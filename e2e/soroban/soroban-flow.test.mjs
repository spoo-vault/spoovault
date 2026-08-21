/**
 * SpooVault — Soroban (Stellar) E2E flow.
 *
 * This exercises the *real* `spoovault_stellar` contract end-to-end against a
 * local Soroban standalone network (e.g. the `stellar/quickstart` standalone
 * service used in .github/workflows/e2e.yml):
 *
 *   create_vault -> accept_guardian_invite -> add_document
 *   -> request_access -> approve_access
 *
 * It is intentionally independent of Synpress (Freighter is not supported by
 * Synpress); it drives the contract through the `stellar` CLI so the Soroban
 * side of the dApp is covered by an automated, runnable E2E.
 *
 * Prerequisites (provided by the CI job / local dev):
 *   - `stellar` CLI on PATH (v22+).
 *   - A running standalone network at SOROBAN_RPC_URL (default http://localhost:8000).
 *   - Three funded identities supplied via env, or auto-generated + funded from
 *     the standalone network's friendbot.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(import.meta.url);
const repoRoot = resolve(__dirname, "..", "..");
const STELLAR_CRATE = resolve(repoRoot, "contracts-stellar");

const RPC_URL = process.env.SOROBAN_RPC_URL || "http://localhost:8000";
const NETWORK_PASSPHRASE =
  process.env.SOROBAN_NETWORK_PASSPHRASE || "Standalone Network ; February 2017";
const NETWORK = "spoovault-e2e";

function runStellar(args, opts = {}) {
  try {
    return execFileSync("stellar", args, {
      encoding: "utf8",
      cwd: opts.cwd,
    }).trim();
  } catch (err) {
    if (opts.allowFail) return "";
    throw new Error(
      `stellar ${args.join(" ")} failed:\n${err.stdout || ""}\n${err.stderr || err.message}`,
    );
  }
}

function ensureNetwork() {
  runStellar(
    [
      "network",
      "add",
      NETWORK,
      "--rpc-url",
      RPC_URL,
      "--network-passphrase",
      NETWORK_PASSPHRASE,
    ],
    { allowFail: true },
  );
}

let creator;
let guardian;
let beneficiary;
let contractId;

before(async () => {
  ensureNetwork();

  // Identities: use provided funded secrets, else generate + fund from faucet.
  const makeKey = (name) => {
    const existing = process.env[`STELLAR_${name.toUpperCase()}_SECRET`];
    if (existing) return existing;
    runStellar(["keys", "generate", name, "--network", NETWORK], {
      allowFail: true,
    });
    runStellar(["keys", "fund", name, "--network", NETWORK], { allowFail: true });
    return runStellar(["keys", "secret", name]);
  };

  creator = makeKey("creator");
  guardian = makeKey("guardian");
  beneficiary = makeKey("beneficiary");

  // Build the wasm (expects rust + wasm32 target, available in soroban-preview).
  runStellar(["contract", "build"], { cwd: STELLAR_CRATE });
  const wasm = resolve(
    STELLAR_CRATE,
    "target/wasm32-unknown-unknown/release/spoovault_stellar.wasm",
  );

  // Deploy.
  contractId = runStellar([
    "contract",
    "deploy",
    "--wasm",
    wasm,
    "--source",
    creator,
    "--network",
    NETWORK,
  ]);
  assert.ok(contractId.startsWith("C"), `unexpected contract id: ${contractId}`);
});

test("create_vault + guardian invite + document + access approval", () => {
  ensureNetwork();

  const vaultId = runStellar([
    "contract",
    "invoke",
    "--id",
    contractId,
    "--source",
    creator,
    "--network",
    NETWORK,
    "--",
    "create_vault",
    "--creator",
    creator,
    "--name",
    "Soroban E2E Vault",
    "--description",
    "end-to-end automated vault",
    "--guardians",
    `["${guardian}"]`,
    "--approval_threshold",
    "1",
  ]);
  assert.ok(Number(vaultId) > 0, `vault id should be > 0, got ${vaultId}`);

  runStellar([
    "contract",
    "invoke",
    "--id",
    contractId,
    "--source",
    guardian,
    "--network",
    NETWORK,
    "--",
    "accept_guardian_invite",
    "--guardian",
    guardian,
    "--vault_id",
    vaultId,
  ]);

  const docId = runStellar([
    "contract",
    "invoke",
    "--id",
    contractId,
    "--source",
    guardian,
    "--network",
    NETWORK,
    "--",
    "add_document",
    "--uploader",
    guardian,
    "--vault_id",
    vaultId,
    "--encrypted_metadata",
    "meta",
    "--ipfs_hash",
    "ipfs://e2e",
    "--required_access",
    "0",
    "--release_condition",
    "0",
    "--guardians_list",
    "[]",
    "--shares",
    "[]",
  ]);
  assert.ok(Number(docId) > 0, `document id should be > 0, got ${docId}`);

  const requestId = runStellar([
    "contract",
    "invoke",
    "--id",
    contractId,
    "--source",
    beneficiary,
    "--network",
    NETWORK,
    "--",
    "request_access",
    "--requester",
    beneficiary,
    "--document_id",
    docId,
  ]);
  assert.ok(Number(requestId) > 0, `request id should be > 0, got ${requestId}`);

  // Guardian approves the request (no beneficiary share supplied -> null).
  runStellar([
    "contract",
    "invoke",
    "--id",
    contractId,
    "--source",
    guardian,
    "--network",
    NETWORK,
    "--",
    "approve_access",
    "--approver",
    guardian,
    "--request_id",
    requestId,
    "--beneficiary_share",
    "null",
  ]);
});
