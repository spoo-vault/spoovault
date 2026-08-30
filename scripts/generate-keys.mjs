#!/usr/bin/env node

/**
 * Groth16 Key Generation Script — BeneficiaryAccessProof (issue #70)
 *
 * Generates the proving key (.zkey) and verification key (verification_key.json)
 * for the compiled BeneficiaryAccessProof circuit.
 *
 * Prerequisites:
 *   Node.js 22+, snarkjs installed as dev dependency,
 *   and the circuit already compiled via `node scripts/compile-circuit.mjs`.
 *
 *   npm install --save-dev snarkjs
 *
 * Usage:
 *   node scripts/generate-keys.mjs
 *
 * Optional: use an entropy seed for deterministic key generation:
 *   node scripts/generate-keys.mjs --seed "my-entropy-seed"
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CIRCUITS_DIR = join(ROOT, "circuits");
const BUILD_DIR = join(CIRCUITS_DIR, "build");
const CIRCUIT_NAME = "BeneficiaryAccessProof";
const R1CS_FILE = join(BUILD_DIR, `${CIRCUIT_NAME}.r1cs`);

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
  if (!existsSync(R1CS_FILE)) {
    console.error(`R1CS file not found: ${R1CS_FILE}`);
    console.error("Run `node scripts/compile-circuit.mjs` first.");
    process.exit(1);
  }

  try {
    execSync("npx snarkjs --version 2>&1 || true", { stdio: "pipe" });
  } catch {
    console.error("snarkjs not found. Install it:");
    console.error("  npm install --save-dev snarkjs");
    process.exit(1);
  }
}

async function main() {
  console.log(`\nGenerating Groth16 keys for ${CIRCUIT_NAME}\n`);

  checkPrerequisites();
  ensureDir(BUILD_DIR);

  // Parse CLI arguments
  const args = process.argv.slice(2);
  const seedFlagIdx = args.indexOf("--seed");
  const seedArg =
    seedFlagIdx >= 0 && seedFlagIdx + 1 < args.length
      ? args[seedFlagIdx + 1]
      : null;

  // Step 1: Powers of Tau ceremony (Phase 1)
  console.log("[1/4] Powers of Tau (Phase 1)...");
  const ptauFile = join(BUILD_DIR, "pot12_final.ptau");
  if (!existsSync(ptauFile)) {
    run(`npx snarkjs powersoftau new bn128 12 "${ptauFile}.tmp" -v`);
    run(`npx snarkjs powersoftau contribute "${ptauFile}.tmp" "${ptauFile}" --name="SpooVault Contributor" -v -e="${seedArg || randomBytes(32).toString('hex')}"`);
    // Clean up temp
    try {
      execSync(`rm -f "${ptauFile}.tmp"`);
    } catch {
      // ignore
    }
  } else {
    console.log("  ⚠ Powers of Tau file already exists; skipping.");
  }

  // Step 2: Circuit-specific setup (Phase 2)
  console.log("\n[2/4] Circuit-specific setup (Phase 2)...");
  const zkeyFile = join(BUILD_DIR, `${CIRCUIT_NAME}_0000.zkey`);
  if (!existsSync(zkeyFile)) {
    run(
      `npx snarkjs groth16 setup "${R1CS_FILE}" "${ptauFile}" "${zkeyFile}"`
    );
  } else {
    console.log("  ⚠ Initial zkey already exists; skipping.");
  }

  // Step 3: Contribute to the circuit-specific ceremony
  console.log("\n[3/4] Contributing to circuit ceremony...");
  const finalZkey = join(BUILD_DIR, `${CIRCUIT_NAME}_final.zkey`);
  if (!existsSync(finalZkey)) {
    run(
      `npx snarkjs zkey contribute "${zkeyFile}" "${finalZkey}" --name="SpooVault ZK Contributor" -v -e="${seedArg || randomBytes(32).toString('hex')}"`
    );
  } else {
    console.log("  ⚠ Final zkey already exists; skipping.");
  }

  // Step 4: Export verification key
  console.log("\n[4/4] Exporting verification key...");
  const vkeyFile = join(BUILD_DIR, "verification_key.json");
  run(`npx snarkjs zkey export verificationkey "${finalZkey}" "${vkeyFile}"`);

  // Export Solidity verifier
  const solVerifierFile = join(BUILD_DIR, "verifier_generated.sol");
  run(
    `npx snarkjs zkey export solidityverifier "${finalZkey}" "${solVerifierFile}"`
  );

  // Also export to public/ for frontend
  const publicBuildDir = join(ROOT, "public", "circuits", "build");
  ensureDir(publicBuildDir);
  ensureDir(join(publicBuildDir, `${CIRCUIT_NAME}_js`));

  copyFileSync(vkeyFile, join(publicBuildDir, "verification_key.json"));
  copyFileSync(finalZkey, join(publicBuildDir, `${CIRCUIT_NAME}_final.zkey`));

  const wasmSrc = join(BUILD_DIR, `${CIRCUIT_NAME}_js`, `${CIRCUIT_NAME}.wasm`);
  const wasmDest = join(publicBuildDir, `${CIRCUIT_NAME}_js`, `${CIRCUIT_NAME}.wasm`);
  if (existsSync(wasmSrc)) {
    copyFileSync(wasmSrc, wasmDest);
  }

  console.log(`\n✅ Key generation complete!\n`);
  console.log(`Output files:`);
  console.log(`  • ${finalZkey}`);
  console.log(`  • ${vkeyFile}`);
  console.log(`  • ${solVerifierFile}`);
  console.log(`  • ${join(publicBuildDir, "**")}`);
  console.log(
    `\nThe Solidity verifier at ${solVerifierFile} should be reviewed and`
  );
  console.log(
    `integrated into contracts/ZKAccessVerifier.sol for the nullifier engine.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});