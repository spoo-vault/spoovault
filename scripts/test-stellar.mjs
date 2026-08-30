/**
 * Runs `cargo test` for the Soroban crate.
 *
 * Build artifacts go under the OS temp directory so Windows Defender
 * Application Control policies that block executables under Documents
 * do not fail `cargo test --lib`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = join(root, "contracts-stellar");
const targetDir = process.env.CARGO_TARGET_DIR || join(tmpdir(), "spoovault-stellar-target");
const fixtureWasm = join(crateDir, "upgrade_fixture", "target", "wasm32-unknown-unknown", "release", "spoovault_stellar_upgrade_fixture.wasm");

const extraArgs = process.argv.slice(2);
const needsUpgradeFixture = extraArgs.some(arg => arg.includes("upgrade-tests")) || !existsSync(fixtureWasm);

if (needsUpgradeFixture) {
  console.log("Building Stellar upgrade fixture WASM...");
  spawnSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"], {
    cwd: join(crateDir, "upgrade_fixture"),
    stdio: "inherit",
    shell: true,
  });
}

const result = spawnSync("cargo", ["test", ...extraArgs], {
  cwd: crateDir,
  stdio: "inherit",
  env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  shell: true,
});

process.exit(result.status === null ? 1 : result.status);
