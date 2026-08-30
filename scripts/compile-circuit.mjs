#!/usr/bin/env node

/**
 * Circuit Compilation Script — BeneficiaryAccessProof (issue #70)
 *
 * Compiles the Circom circuit and produces:
 *   1. R1CS constraint system (.r1cs)
 *   2. WebAssembly witness generator (.wasm)
 *   3. Solidity verifier template (can be used as basis for ZKAccessVerifier.sol)
 *
 * Prerequisites:
 *   circom must be installed globally or available in PATH:
 *     npm install -g circom
 *
 * Usage:
 *   node scripts/compile-circuit.mjs
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CIRCUITS_DIR = join(ROOT, "circuits");
const BUILD_DIR = join(CIRCUITS_DIR, "build");
const CIRCUIT_NAME = "BeneficiaryAccessProof";
const CIRCUIT_FILE = join(CIRCUITS_DIR, `${CIRCUIT_NAME}.circom`);

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function run(cmd, cwd = ROOT) {
  console.log(`  $ ${cmd}`);
  try {
    return execSync(cmd, { cwd, stdio: "inherit" });
  } catch (err) {
    console.error(`  ✗ Failed: ${cmd}`);
    process.exit(1);
  }
}

function checkPrerequisites() {
  try {
    execSync("circom --version", { stdio: "pipe" });
    console.log("✓ circom found");
  } catch {
    console.error(
      "circom not found. Install it globally:\n  npm install -g circom"
    );
    console.error(
      "Or install locally and use npx:\n  npm install --save-dev circom\n  npx circom"
    );
    process.exit(1);
  }

  if (!existsSync(CIRCUIT_FILE)) {
    console.error(`Circuit file not found: ${CIRCUIT_FILE}`);
    process.exit(1);
  }
}

async function main() {
  console.log("\nCompiling BeneficiaryAccessProof circuit\n");

  checkPrerequisites();
  ensureDir(BUILD_DIR);

  // Step 1: Compile to R1CS
  console.log("[1/3] Compiling circuit to R1CS...");
  run(
    `circom "${CIRCUIT_FILE}" --r1cs --wasm --sym --output "${BUILD_DIR}"`,
    ROOT
  );

  // Step 2: Generate Solidity/Python verifier templates (optional)
  console.log("[2/3] Exporting Solidity verifier template...");
  const r1csFile = join(BUILD_DIR, `${CIRCUIT_NAME}.r1cs`);
  if (existsSync(r1csFile)) {
    try {
      // Try snarkjs first (if available)
      execSync(
        `npx snarkjs zkey export solidityverifier "${r1csFile}" "${join(BUILD_DIR, "verifier.sol")}" || true`,
        { cwd: ROOT, stdio: "pipe" }
      );
    } catch {
      console.log("  ⚠ snarkjs not available; skipping verifier export");
    }
  }

  // Step 3: Summary
  console.log("\n[3/3] Build complete!\n");
  console.log("Output files:");
  console.log(`  • ${join(BUILD_DIR, `${CIRCUIT_NAME}.r1cs`)}`);
  console.log(`  • ${join(BUILD_DIR, `${CIRCUIT_NAME}_js/${CIRCUIT_NAME}.wasm`)}`);
  console.log(`  • ${join(BUILD_DIR, `${CIRCUIT_NAME}_js/generate_witness.js`)}`);
  console.log(
    "\nNext: run `node scripts/generate-keys.mjs` to create proving & verification keys."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});