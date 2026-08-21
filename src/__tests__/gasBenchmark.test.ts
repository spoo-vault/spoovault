import { describe, it, expect } from "vitest";
import {
  parseGasReport,
  buildComparison,
  computeCompilerFingerprint,
  loadBaseline,
  evaluate,
} from "../../scripts/gas-benchmark.mjs";

const SAMPLE_REPORT = `
╭───────────────┬─────────┬─────────┬─────────┬─────────┬────────╮
│  Contract     ·   Min   ·   Max   ·   Avg   ·  # calls·  usd   │
├───────────────┼─────────┼─────────┼─────────┼─────────┼────────┤
│  SpooVault    ·         ·         ·         ·         ·        │
│  ──────────── │         │         │         │         │        │
│    createVault· 500,000· 700,000· 600,000·       10·       -│
│    burnToken  ·  50,000·  55,000·  52,000·        5·       -│
╰───────────────┴─────────┴─────────┴─────────┴─────────┴────────╯
`;

const CONFIG_A = `module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "cancun",
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
    },
  },
};`;

const CONFIG_B = CONFIG_A.replace('viaIR: true', 'viaIR: false');
const CONFIG_C = CONFIG_A.replace('"0.8.24"', '"0.8.25"');

describe("Gas benchmark pipeline (scripts/gas-benchmark.mjs)", () => {
  describe("parseGasReport", () => {
    it("should parse modern-layout method rows with thousands separators", () => {
      const entries = parseGasReport(SAMPLE_REPORT);
      const createVault = entries.find((e) => e.name === "SpooVault.createVault");
      expect(createVault).toBeDefined();
      expect(createVault!.avg).toBe(600000);
      expect(createVault!.min).toBe(500000);
      expect(createVault!.max).toBe(700000);
      expect(createVault!.calls).toBe(10);
      expect(entries.find((e) => e.name === "SpooVault.burnToken")?.avg).toBe(52000);
    });

    it("should not treat the contract header row as a method", () => {
      const entries = parseGasReport(SAMPLE_REPORT);
      expect(entries.filter((e) => e.name === "SpooVault.")).toHaveLength(0);
      expect(entries.length).toBe(2);
    });
  });

  describe("computeCompilerFingerprint", () => {
    it("should be stable for identical configs", () => {
      expect(computeCompilerFingerprint(CONFIG_A)).toBe(computeCompilerFingerprint(CONFIG_A));
    });

    it("should change when viaIR changes", () => {
      expect(computeCompilerFingerprint(CONFIG_A)).not.toBe(computeCompilerFingerprint(CONFIG_B));
    });

    it("should change when the solc version changes", () => {
      expect(computeCompilerFingerprint(CONFIG_A)).not.toBe(computeCompilerFingerprint(CONFIG_C));
    });
  });

  describe("baseline formats & regression gating", () => {
    const entries = [
      { name: "SpooVault.a", avg: 100, min: 100, max: 100, calls: 1 },
      { name: "SpooVault.b", avg: 110, min: 110, max: 110, calls: 1 },
      { name: "SpooVault.newMethod", avg: 500, min: 500, max: 500, calls: 1 },
    ];

    it("should detect regressions above the +5% threshold", () => {
      const comparison = buildComparison(
        entries,
        { "SpooVault.a": 95, "SpooVault.b": 100 }
      );
      // a: +5.26% (regression), b: +10% (regression)
      expect(comparison.regressionCount).toBe(2);
      expect(comparison.maxIncreasePct).toBeCloseTo(10, 5);
    });

    it("should treat legacy flat baselines as untrusted provenance and suppress the gate", () => {
      const baselineInfo = loadBaseline(JSON.stringify({ "SpooVault.a": 95 }));
      expect(baselineInfo.knownCompiler).toBe(false);

      const evaluation = evaluate(entries, baselineInfo);
      expect(evaluation.gateReliable).toBe(false);
      expect(evaluation.comparison.regressionCount).toBeGreaterThan(0); // still reported
      expect(evaluation.compilerChanged).toBe(false); // unknown, not "changed"
    });

    it("should suppress the gate when the compiler fingerprint changed", () => {
      const baselineInfo = {
        gas: { "SpooVault.a": 95 },
        fingerprint: "stalefingerprint",
        knownCompiler: true,
      };
      const evaluation = evaluate(entries, baselineInfo);
      expect(evaluation.compilerChanged).toBe(true);
      expect(evaluation.gateReliable).toBe(false);
      // Raw regression is still visible in the table.
      expect(evaluation.comparison.regressionCount).toBeGreaterThan(0);
    });

    it("should keep the gate reliable when fingerprints match", () => {
      const fp = computeCompilerFingerprint(CONFIG_A);
      const baselineInfo = {
        gas: { "SpooVault.a": 90, "SpooVault.b": 100 },
        fingerprint: fp,
        knownCompiler: true,
      };
      const evaluation = evaluate(entries, baselineInfo);
      expect(evaluation.compilerChanged).toBe(false);
      expect(evaluation.gateReliable).toBe(true);
      // a: +11.1%, b: +10% -> both beyond threshold
      expect(evaluation.comparison.regressionCount).toBe(2);
    });

    it("should round-trip the v2 baseline format through loadBaseline", () => {
      const v2 = JSON.stringify({
        version: 2,
        compilerFingerprint: "abc123def456",
        updatedAt: "2026-01-01T00:00:00Z",
        gas: { "SpooVault.a": 100 },
      });
      const info = loadBaseline(v2);
      expect(info.knownCompiler).toBe(true);
      expect(info.fingerprint).toBe("abc123def456");
      expect(info.gas["SpooVault.a"]).toBe(100);
    });
  });

  describe("comparison rendering data", () => {
    it("should mark new methods without a baseline entry", () => {
      const comparison = buildComparison(
        [{ name: "X.fresh", avg: 10, min: 10, max: 10, calls: 1 }],
        {}
      );
      expect(comparison.rows[0].status).toBe("new");
      expect(comparison.rows[0].base).toBeNull();
      expect(comparison.regressionCount).toBe(0);
    });
  });
});
