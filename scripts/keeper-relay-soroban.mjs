/**
 * SpooVault Web3 Keeper Heartbeat Relay (Soroban / Stellar)
 *
 * Reference implementation of the off-chain half of the Soroban keeper
 * delegation flow: a Chainlink Automation "custom logic" upkeep or a Gelato
 * Web3 Function periodically runs a job like this one to call
 * `prove_life_by_keeper(keeper, vault_id)` on behalf of a vault owner who has
 * already delegated to this keeper via `authorize_keeper`, so the owner's
 * dead-man's-switch never trips just because they didn't personally submit a
 * transaction.
 *
 * Unlike the EVM side, Soroban's native `require_auth` already decouples who
 * authorizes an action from who pays for and submits the transaction, so
 * `authorize_keeper` needs no off-chain signature scheme of its own — it is a
 * normal owner-signed contract call, made once (e.g. via
 * `stellarService.authorizeKeeper`), after which the keeper can relay
 * heartbeats on its own signed transactions with no further owner
 * involvement.
 *
 * This script drives the `stellar` CLI directly (matching the convention
 * already used by `e2e/soroban/soroban-flow.test.mjs`) rather than
 * reimplementing transaction assembly, so it doubles as copy-pasteable
 * documentation of the exact calls a keeper needs to make.
 *
 * Prerequisites:
 *   - `stellar` CLI on PATH (v22+).
 *   - A funded Stellar identity for the keeper, either:
 *       already registered locally as KEEPER_STELLAR_IDENTITY, or
 *       provided as a secret key via KEEPER_STELLAR_SECRET (imported once).
 *   - Set in .env or the environment:
 *       SPOOVAULT_CONTRACT_ID=<deployed contract id>
 *       SOROBAN_RPC_URL=<rpc url>              (default: http://localhost:8000)
 *       SOROBAN_NETWORK_PASSPHRASE=<passphrase> (default: Standalone Network ; February 2017)
 *       KEEPER_STELLAR_IDENTITY=<local `stellar keys` identity name> (default: spoovault-keeper)
 *       KEEPER_STELLAR_SECRET=<S...secret key>  (optional; imports/overwrites the identity above)
 *
 * Usage:
 *   node scripts/keeper-relay-soroban.mjs <vaultId> [vaultId...]
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, "../.env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const CONTRACT_ID = process.env.SPOOVAULT_CONTRACT_ID;
const RPC_URL = process.env.SOROBAN_RPC_URL || "http://localhost:8000";
const NETWORK_PASSPHRASE =
  process.env.SOROBAN_NETWORK_PASSPHRASE || "Standalone Network ; February 2017";
const IDENTITY = process.env.KEEPER_STELLAR_IDENTITY || "spoovault-keeper";
const NETWORK = "spoovault-keeper-relay";

function runStellar(args, opts = {}) {
  return execFileSync("stellar", args, { encoding: "utf8", ...opts }).trim();
}

function ensureNetwork() {
  try {
    runStellar([
      "network",
      "add",
      NETWORK,
      "--rpc-url",
      RPC_URL,
      "--network-passphrase",
      NETWORK_PASSPHRASE,
    ]);
  } catch {
    // Already registered locally; fine to continue.
  }
}

function ensureKeeperIdentity() {
  if (process.env.KEEPER_STELLAR_SECRET) {
    runStellar(["keys", "add", IDENTITY, "--secret-key"], {
      input: process.env.KEEPER_STELLAR_SECRET,
    });
  }
  return runStellar(["keys", "address", IDENTITY]);
}

function invoke(functionName, args) {
  const raw = runStellar([
    "contract",
    "invoke",
    "--id",
    CONTRACT_ID,
    "--source",
    IDENTITY,
    "--network",
    NETWORK,
    "--",
    functionName,
    ...args,
  ]);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function checkAndRelay(keeperAddress, vaultId) {
  const authorization = invoke("get_keeper_authorization", ["--vault_id", String(vaultId)]);

  if (!authorization) {
    console.log(`Vault ${vaultId}: no keeper authorized. Skipping.`);
    return;
  }
  if (authorization.keeper !== keeperAddress) {
    console.log(`Vault ${vaultId}: this keeper is not authorized. Skipping.`);
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Number(authorization.expires_at) <= nowSeconds) {
    console.log(`Vault ${vaultId}: keeper authorization expired. Skipping.`);
    return;
  }

  console.log(`Vault ${vaultId}: relaying proof-of-life heartbeat...`);
  invoke("prove_life_by_keeper", [
    "--keeper",
    keeperAddress,
    "--vault_id",
    String(vaultId),
  ]);
  console.log(`Vault ${vaultId}: relayed.`);
}

async function main() {
  const vaultIds = process.argv.slice(2).map(Number);
  if (vaultIds.length === 0 || vaultIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    console.error("Usage: node scripts/keeper-relay-soroban.mjs <vaultId> [vaultId...]");
    process.exit(1);
  }
  if (!CONTRACT_ID) {
    console.error("SPOOVAULT_CONTRACT_ID is not set in .env");
    process.exit(1);
  }

  ensureNetwork();
  const keeperAddress = ensureKeeperIdentity();
  console.log(`Keeper address: ${keeperAddress}`);

  for (const vaultId of vaultIds) {
    await checkAndRelay(keeperAddress, vaultId);
  }
}

main().catch((err) => {
  console.error("Keeper relay failed:", err.message || err);
  process.exit(1);
});
