// @ts-check
/**
 * Gas profiling & performance regression benchmark tool.
 *
 * Parses the text report emitted by `hardhat-gas-reporter`
 * (configured via REPORT_GAS=true) and:
 *   1. Produces `gas-benchmark.json` in the format expected by
 *      `benchmark-action/github-action-benchmark`.
 *   2. Compares every measured method/constructor against the in-repo
 *      baseline stored at `.github/gas-baseline.json` and writes a
 *      detailed markdown diff table to `gas-comparison.md`.
 *   3. Emits a machine-readable summary (`gas-summary.json`) including
 *      whether any measured entry regressed beyond the allowed threshold.
 *   4. When `UPDATE_BASELINE=true` (run on the `main` branch merge) the
 *      baseline file is refreshed with the current measurements.
 *
 * Exit code is non-zero when a regression above the threshold is detected
 * and `FAIL_ON_REGRESSION=true`, so the CI job can block the merge.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const GAS_REPORT = path.join(ROOT, "gas-report.txt");
const BASELINE_PATH = path.join(ROOT, ".github", "gas-baseline.json");
const BENCHMARK_OUT = path.join(ROOT, "gas-benchmark.json");
const COMPARISON_OUT = path.join(ROOT, "gas-comparison.md");
const SUMMARY_OUT = path.join(ROOT, "gas-summary.json");

const REGRESSION_THRESHOLD_PCT = Number(process.env.REGRESSION_THRESHOLD_PCT || "5");
const ALLOW_FAIL = process.env.FAIL_ON_REGRESSION !== "false";
const UPDATE_BASELINE = process.env.UPDATE_BASELINE === "true";

/**
 * @typedef {Object} GasEntry
 * @property {string} name  Fully-qualified name, e.g. `SpooVault.deposit`.
 * @property {number} avg   Average gas consumed.
 * @property {number} min   Minimum gas consumed.
 * @property {number} max   Maximum gas consumed.
 * @property {number} calls Number of times the method was exercised.
 */

/**
 * Parse the hardhat-gas-reporter text report into a list of gas entries.
 *
 * Two report layouts are supported:
 *
 *  (A) Modern (hardhat-gas-reporter >= 2.x) — a 6 column layout where the
 *      first column merges the contract and method, the contract name is
 *      emitted on its own row (rest of the row empty) and each method is
 *      indented underneath it. Numbers use thousands separators.
 *        |  SpooVault                       ·                 ·                 ·                 ·                 ·       |
 *        |      createVault                 ·        398,587  ·        707,597  ·        635,133  ·            51  ·     -  |
 *
 *  (B) Legacy — a 7 column layout: Contract, Method, Min, Max, Avg, # calls,
 *      usd (avg).
 *
 * Both use `·` as the intra-row separator and `|` as the outer frame.
 *
 * @param {string} raw
 * @returns {GasEntry[]}
 */
function parseGasReport(raw) {
  const entries = [];
  const lines = raw.split(/\r?\n/);
  /** @type {string} */
  let currentContract = "";

  const toNum = (s) => {
    const n = Number(String(s).replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : 0;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.includes("·")) continue;

    // Strip the outer frame (both ASCII `|` and box-drawing `│`) and split
    // on the inner `·` separators.
    const inner = trimmed.replace(/^[│|]/, "").replace(/[│|]$/, "");
    const cols = inner.split("·").map((c) => c.trim());

    // --- Layout A: contract name row (bare name, rest empty) -------------
    if (
      cols.length >= 2 &&
      cols.slice(1).every((v) => v === "" || v === "-") &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(cols[0])
    ) {
      if (cols[0] !== "Deployments") currentContract = cols[0];
      continue;
    }

    // --- Layout B: legacy 7-column method row ----------------------------
    if (cols.length >= 7) {
      const contract = cols[0];
      const method = cols[1];
      const avg = toNum(cols[4]);
      if (avg <= 0) continue;
      if (/^(contract|method)/i.test(contract) || /^(min|max|avg)/i.test(method)) continue;
      if (/^[-–—]+$/.test(contract) || /^[-–—]+$/.test(method)) continue;
      const name =
        method.toLowerCase() === "constructor"
          ? `${contract}.constructor`
          : `${contract}.${method}`;
      entries.push({
        name,
        avg,
        min: toNum(cols[2]) || avg,
        max: toNum(cols[3]) || avg,
        calls: toNum(cols[5]),
      });
      continue;
    }

    // --- Layout A: 6-column method/deployment row ------------------------
    if (cols.length >= 6) {
      const avg = toNum(cols[3]);
      if (avg <= 0) continue;
      if (/methods/i.test(cols[0])) continue; // "Contracts / Methods" header
      const label = cols[0].trim();
      let name;
      if (label === currentContract) {
        name = `${currentContract}.constructor`;
      } else {
        name = `${currentContract}.${label}`;
      }
      entries.push({
        name,
        avg,
        min: toNum(cols[1]) || avg,
        max: toNum(cols[2]) || avg,
        calls: toNum(cols[4]),
      });
    }
  }

  return entries;
}

/**
 * @param {GasEntry[]} entries
 * @returns {Record<string, number>}
 */
function toBaselineMap(entries) {
  /** @type {Record<string, number>} */
  const map = {};
  for (const e of entries) map[e.name] = e.avg;
  return map;
}

/**
 * @param {GasEntry[]} entries
 * @param {Record<string, number>} baseline
 */
function buildComparison(entries, baseline) {
  const rows = [];
  let maxIncreasePct = 0;
  let regressionCount = 0;

  for (const e of entries) {
    const base = baseline[e.name];
    let delta = 0;
    let pct = 0;
    let status = "new";

    if (typeof base === "number") {
      delta = e.avg - base;
      pct = base === 0 ? 0 : (delta / base) * 100;
      status = delta > 0 ? "increase" : delta < 0 ? "decrease" : "unchanged";
      if (pct > maxIncreasePct) maxIncreasePct = pct;
      if (pct > REGRESSION_THRESHOLD_PCT) regressionCount += 1;
    }

    rows.push({ ...e, base: typeof base === "number" ? base : null, delta, pct, status });
  }

  return { rows, maxIncreasePct, regressionCount };
}

function renderMarkdown(entries, comparison, baselineExists) {
  const lines = [];
  lines.push("## ⛽ Gas Profile & Regression Report");
  lines.push("");
  lines.push(
    `Threshold for regression alert: **+${REGRESSION_THRESHOLD_PCT}%** average gas.`
  );
  lines.push("");

  if (comparison.regressionCount > 0) {
    lines.push(
      `:warning: **${comparison.regressionCount} method(s) regressed beyond the threshold** (max +${comparison.maxIncreasePct.toFixed(
        2
      )}%).`
    );
    lines.push("");
  }

  if (!baselineExists) {
    lines.push(
      "_No baseline found in this run — these values establish the first benchmark. The baseline will be committed when this change lands on `main`._"
    );
    lines.push("");
  }

  lines.push("| Contract.Method | Avg Gas | Baseline | Δ Gas | Δ % | Status |");
  lines.push("| --- | ---: | ---: | ---: | ---: | --- |");

  for (const r of comparison.rows) {
    const base = r.base === null ? "—" : String(r.base);
    const sign = r.delta > 0 ? "+" : "";
    const pctStr =
      r.base === null ? "—" : `${sign}${r.pct.toFixed(2)}%`;
    let icon = "🆕";
    if (r.status === "increase" && r.pct > REGRESSION_THRESHOLD_PCT) icon = "🔴";
    else if (r.status === "increase") icon = "🟡";
    else if (r.status === "decrease") icon = "🟢";
    else if (r.status === "unchanged") icon = "⚪";
    lines.push(
      `| \`${r.name}\` | ${r.avg} | ${base} | ${sign}${r.delta} | ${pctStr} | ${icon} ${r.status} |`
    );
  }

  lines.push("");
  lines.push(
    `_Generated by \`scripts/gas-benchmark.mjs\` from \`gas-report.txt\`. Benchmark feed: \`gas-benchmark.json\`._`
  );
  return lines.join("\n");
}

function toBenchmarkFormat(entries) {
  // github-action-benchmark expects an array of
  // { name, unit, value } where "value" is the metric being tracked.
  return entries.map((e) => ({
    name: e.name,
    unit: "gas",
    value: e.avg,
  }));
}

function main() {
  if (!fs.existsSync(GAS_REPORT)) {
    console.error(`ERROR: gas report not found at ${GAS_REPORT}`);
    console.error("Run `REPORT_GAS=true npx hardhat test` first.");
    process.exit(2);
  }

  const raw = fs.readFileSync(GAS_REPORT, "utf8");
  const entries = parseGasReport(raw);

  if (entries.length === 0) {
    console.error("ERROR: no gas entries parsed from the report.");
    process.exit(2);
  }

  /** @type {Record<string, number>} */
  let baseline = {};
  let baselineExists = false;
  if (fs.existsSync(BASELINE_PATH)) {
    try {
      baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
      baselineExists = true;
    } catch {
      console.warn("WARN: could not parse existing baseline, starting fresh.");
    }
  }

  const comparison = buildComparison(entries, baseline);

  fs.writeFileSync(BENCHMARK_OUT, JSON.stringify(toBenchmarkFormat(entries), null, 2));
  const md = renderMarkdown(entries, comparison, baselineExists);
  fs.writeFileSync(COMPARISON_OUT, md);

  const summary = {
    thresholdPct: REGRESSION_THRESHOLD_PCT,
    maxIncreasePct: Number(comparison.maxIncreasePct.toFixed(2)),
    regressionCount: comparison.regressionCount,
    hasRegression: comparison.regressionCount > 0,
    measuredMethods: entries.length,
    baselineExists,
  };
  fs.writeFileSync(SUMMARY_OUT, JSON.stringify(summary, null, 2));

  console.log(md);
  console.log(
    `\nSUMMARY: ${entries.length} methods measured, ${comparison.regressionCount} regression(s), max +${summary.maxIncreasePct}%.`
  );

  if (UPDATE_BASELINE) {
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(toBaselineMap(entries), null, 2) + "\n");
    console.log(`BASELINE: refreshed ${BASELINE_PATH} with ${entries.length} entries.`);
  }

  if (summary.hasRegression && ALLOW_FAIL) {
    console.error(`FAIL: gas regression(s) above +${REGRESSION_THRESHOLD_PCT}% detected.`);
    process.exit(1);
  }

  process.exit(0);
}

main();
