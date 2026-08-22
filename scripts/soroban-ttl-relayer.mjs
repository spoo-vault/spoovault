/**
 * SpooVault – Soroban Automated Multi-Party State Archival Auto-Bump TTL Relayer
 *
 * Issue #94: https://github.com/spoo-vault/spoovault/issues/94
 *
 * WHAT IT DOES
 * ─────────────
 * Monitors every persistent-storage entry in the SpooVault Soroban contract
 * (vaults, documents, access-requests) and automatically issues
 * extend_vault_ttl / extend_document_ttl / extend_request_ttl / extend_contract_ttl
 * Soroban transactions whenever an entry's remaining TTL falls below the
 * TTL_THRESHOLD_LEDGERS threshold (default 10,000 ledgers).
 *
 * ENTRY TYPES MONITORED
 * ──────────────────────
 *   • Contract instance (extend_contract_ttl)
 *   • Vault(id)         (extend_vault_ttl)
 *   • Doc(id)           (extend_document_ttl)
 *   • Request(id)       (extend_request_ttl)
 *
 * REQUIRED ENV VARS
 * ──────────────────
 *   VITE_STELLAR_CONTRACT_ADDRESS   – deployed SpooVault contract ID (C…)
 *   RELAYER_SECRET_KEY               – Stellar secret key (S…) used to sign bump tx
 *
 * OPTIONAL ENV VARS
 * ──────────────────
 *   SOROBAN_RPC_URL     – override RPC (default: https://soroban-testnet.stellar.org)
 *   POLL_INTERVAL_MS    – milliseconds between full scans (default: 60000)
 *   TTL_THRESHOLD       – remaining ledgers below which a bump is issued (default: 10000)
 *   MAX_TTL             – target ledgers after bump (default: 3110400 ≈ ~180 days at 5s/ledger)
 *   MAX_ENTRIES         – safety cap on how many IDs to scan per run (default: 10000)
 *   MAX_RETRIES         – per-entry retry attempts on transient failures (default: 3)
 *   RETRY_DELAY_MS      – milliseconds between retries (default: 5000)
 *   RUN_ONCE            – set to "true" to exit after a single scan (useful in CI)
 *
 * USAGE
 * ─────
 *   node scripts/soroban-ttl-relayer.mjs
 *
 * EXAMPLE (one-shot):
 *   VITE_STELLAR_CONTRACT_ADDRESS=C... \
 *   RELAYER_SECRET_KEY=S...            \
 *   RUN_ONCE=true                      \
 *   node scripts/soroban-ttl-relayer.mjs
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Resolve project root and load .env ─────────────────────────────────────

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
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  rpcUrl:
    process.env.SOROBAN_RPC_URL ||
    "https://soroban-testnet.stellar.org",
  contractId: process.env.VITE_STELLAR_CONTRACT_ADDRESS || "",
  secretKey: process.env.RELAYER_SECRET_KEY || "",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 60_000),
  ttlThreshold: Number(process.env.TTL_THRESHOLD ?? 10_000),
  maxTtl: Number(process.env.MAX_TTL ?? 3_110_400),
  maxEntries: Number(process.env.MAX_ENTRIES ?? 10_000),
  maxRetries: Number(process.env.MAX_RETRIES ?? 3),
  retryDelayMs: Number(process.env.RETRY_DELAY_MS ?? 5_000),
  runOnce: process.env.RUN_ONCE === "true",
  networkPassphrase: process.env.SOROBAN_NETWORK_PASSPHRASE || "",
};

// ─── Logging ─────────────────────────────────────────────────────────────────

const log = (level, message, extra = {}) => {
  const ts = new Date().toISOString();
  const extraStr =
    Object.keys(extra).length > 0
      ? " " + JSON.stringify(extra)
      : "";
  console.log(`[${ts}] [TTL-RELAYER] [${level}] ${message}${extraStr}`);
};

const info = (msg, extra) => log("INFO", msg, extra);
const warn = (msg, extra) => log("WARN", msg, extra);
const error = (msg, extra) => log("ERROR", msg, extra);

// ─── Stellar SDK lazy-load ───────────────────────────────────────────────────

let _sdk = null;

/**
 * Load the Stellar SDK. Returns the full module object.
 * @returns {Promise<import('@stellar/stellar-sdk')>}
 */
export async function loadSdk() {
  if (_sdk) return _sdk;
  _sdk = await import("@stellar/stellar-sdk");
  return _sdk;
}

// ─── Key encoding helpers ────────────────────────────────────────────────────

/**
 * Build the XDR ScVal representation of a DataKey enum variant.
 *
 * Soroban #[contracttype] enum variants are serialised as:
 *   Unit variant   → ScVec([ ScSymbol("VariantName") ])
 *   Tuple variant  → ScVec([ ScSymbol("VariantName"), ScVal(arg0), … ])
 *
 * @param {string}       tag    – variant name, e.g. "VaultCount", "Vault"
 * @param {xdr.ScVal[]}  args   – serialised arguments (empty for unit variants)
 * @returns {xdr.ScVal}
 */
export function buildDataKeyScVal(tag, args = []) {
  // We import xdr synchronously once the SDK is loaded.
  if (!_sdk) throw new Error("SDK not loaded yet – call loadSdk() first");
  const { xdr } = _sdk;
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(tag), ...args]);
}

/**
 * Build an XDR ScVal for a u64 value (used as Vault/Doc/Request IDs).
 * @param {bigint|number} id
 * @returns {xdr.ScVal}
 */
export function scValU64(id) {
  if (!_sdk) throw new Error("SDK not loaded yet – call loadSdk() first");
  const { xdr } = _sdk;
  return xdr.ScVal.scvU64(new xdr.Uint64(BigInt(id)));
}

/**
 * Build an xdr.LedgerKey for a persistent contract-data entry.
 *
 * @param {string}       contractId  – C-strkey of the contract
 * @param {xdr.ScVal}    keyScVal    – the key to look up
 * @returns {xdr.LedgerKey}
 */
export function buildPersistentLedgerKey(contractId, keyScVal) {
  if (!_sdk) throw new Error("SDK not loaded yet – call loadSdk() first");
  const { xdr, Address } = _sdk;
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: keyScVal,
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
}

/**
 * Build an xdr.LedgerKey for the contract instance entry itself.
 *
 * @param {string} contractId
 * @returns {xdr.LedgerKey}
 */
export function buildContractInstanceLedgerKey(contractId) {
  if (!_sdk) throw new Error("SDK not loaded yet – call loadSdk() first");
  const { xdr, StrKey } = _sdk;
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new _sdk.Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
}

// ─── TTL query helpers ───────────────────────────────────────────────────────

/**
 * Fetch the liveUntilLedgerSeq for a single ledger key.
 * Returns null if the entry does not exist (archived or never written).
 *
 * @param {import('@stellar/stellar-sdk').rpc.Server} server
 * @param {xdr.LedgerKey} ledgerKey
 * @returns {Promise<{liveUntilLedgerSeq: number, latestLedger: number} | null>}
 */
export async function fetchEntryTtl(server, ledgerKey) {
  const response = await server.getLedgerEntries(ledgerKey);
  if (!response.entries || response.entries.length === 0) return null;
  const entry = response.entries[0];
  return {
    liveUntilLedgerSeq: entry.liveUntilLedgerSeq ?? 0,
    latestLedger: response.latestLedger,
  };
}

/**
 * Query the count of a given entity (VaultCount / DocCount / ReqCount) from
 * the contract's instance storage.
 *
 * @param {import('@stellar/stellar-sdk').rpc.Server} server
 * @param {string}                                     contractId
 * @param {"VaultCount"|"DocCount"|"ReqCount"}         counterKey
 * @returns {Promise<bigint>} – current count, 0 if not yet set
 */
export async function queryEntityCount(server, contractId, counterKey) {
  if (!_sdk) throw new Error("SDK not loaded yet");
  const { xdr, Address } = _sdk;

  // Counter keys live in instance storage
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: buildDataKeyScVal(counterKey),
      durability: xdr.ContractDataDurability.instance(),
    })
  );

  const response = await server.getLedgerEntries(instanceKey);
  if (!response.entries || response.entries.length === 0) return 0n;

  const entry = response.entries[0];
  if (!entry.val) return 0n;

  // entry.val is an xdr.LedgerEntryData → .contractData() → .val() → ScVal (u64)
  try {
    const ledgerEntryData = entry.val;
    const scVal = ledgerEntryData.contractData().val();
    const native = _sdk.scValToNative(scVal);
    return typeof native === "bigint" ? native : BigInt(String(native));
  } catch {
    return 0n;
  }
}

// ─── Transaction submission helpers ─────────────────────────────────────────

/**
 * Sleep for `ms` milliseconds.
 * @param {number} ms
 */
const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build, simulate, sign, and submit a Soroban transaction that calls a
 * TTL-extension function on the SpooVault contract.  Returns the final
 * transaction hash on success.
 *
 * @param {import('@stellar/stellar-sdk').rpc.Server} server
 * @param {import('@stellar/stellar-sdk').Keypair}    keypair
 * @param {string}                                     contractId
 * @param {string}                                     functionName    – extend_*_ttl
 * @param {xdr.ScVal[]}                                args            – function args
 * @param {string}                                     networkPassphrase
 * @returns {Promise<string>} – transaction hash
 */
export async function submitTtlExtensionTx(
  server,
  keypair,
  contractId,
  functionName,
  args,
  networkPassphrase
) {
  if (!_sdk) throw new Error("SDK not loaded yet");
  const {
    Account,
    TransactionBuilder,
    Operation,
    Address,
    Networks,
  } = _sdk;

  const passphrase = networkPassphrase || Networks.TESTNET;

  // 1. Fetch current sequence number for the relayer account
  const sourceAccount = await server.getAccount(keypair.publicKey());

  // 2. Build the invoke-contract operation
  const op = Operation.invokeContractFunction({
    contract: contractId,
    function: functionName,
    args,
  });

  // 3. Build a preliminary transaction (fee will be updated after simulation)
  const tx = new TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase: passphrase,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  // 4. Simulate to get the actual resource fee and footprint
  const simulation = await server.simulateTransaction(tx);
  if (_sdk.rpc.Api.isSimulationError(simulation)) {
    throw new Error(
      `Simulation failed for ${functionName}: ${simulation.error}`
    );
  }

  // 5. Assemble the transaction with correct fee + soroban data
  const preparedTx = _sdk.rpc.assembleTransaction(tx, simulation).build();

  // 6. Sign with the relayer key
  preparedTx.sign(keypair);

  // 7. Submit
  const response = await server.sendTransaction(preparedTx);
  if (response.status === "ERROR") {
    throw new Error(
      `sendTransaction failed for ${functionName}: ${JSON.stringify(
        response.errorResult
      )}`
    );
  }

  const txHash = response.hash;

  // 8. Poll for confirmation (up to 30 attempts × 2 s)
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = await server.getTransaction(txHash);
    if (status.status === "SUCCESS") return txHash;
    if (status.status === "FAILED") {
      throw new Error(
        `Transaction FAILED (hash=${txHash}): ${JSON.stringify(
          status.resultXdr
        )}`
      );
    }
    await sleep(2_000);
  }

  throw new Error(`Transaction polling timed out (hash=${txHash})`);
}

// ─── Retry wrapper ───────────────────────────────────────────────────────────

/**
 * Attempt `fn` up to `maxRetries` times, waiting `delayMs` between attempts.
 * The last error is re-thrown if all attempts fail.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number}           maxRetries
 * @param {number}           delayMs
 * @param {string}           label        – used in log messages
 * @returns {Promise<T>}
 */
export async function withRetry(fn, maxRetries, delayMs, label) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        warn(`Attempt ${attempt}/${maxRetries} failed for "${label}": ${err.message}. Retrying in ${delayMs}ms…`);
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

// ─── Core scan + bump logic ──────────────────────────────────────────────────

/**
 * Scan all entities of one type and issue TTL bumps for those below threshold.
 *
 * @param {object} opts
 * @param {import('@stellar/stellar-sdk').rpc.Server} opts.server
 * @param {import('@stellar/stellar-sdk').Keypair}    opts.keypair
 * @param {string}                                     opts.contractId
 * @param {number}                                     opts.latestLedger
 * @param {string}                                     opts.networkPassphrase
 * @param {"VaultCount"|"DocCount"|"ReqCount"}         opts.counterKey
 * @param {"Vault"|"Doc"|"Request"}                    opts.dataKeyTag
 * @param {string}                                     opts.extendFn
 * @param {number}                                     opts.ttlThreshold
 * @param {number}                                     opts.maxEntries
 * @param {number}                                     opts.maxRetries
 * @param {number}                                     opts.retryDelayMs
 * @returns {Promise<{scanned: number, bumped: number, errors: number}>}
 */
export async function scanAndBumpEntityType({
  server,
  keypair,
  contractId,
  latestLedger,
  networkPassphrase,
  counterKey,
  dataKeyTag,
  extendFn,
  ttlThreshold,
  maxEntries,
  maxRetries,
  retryDelayMs,
}) {
  let count;
  try {
    count = await queryEntityCount(server, contractId, counterKey);
  } catch (err) {
    error(`Could not read ${counterKey}: ${err.message}`);
    return { scanned: 0, bumped: 0, errors: 1 };
  }

  const total = Number(count);
  const limit = Math.min(total, maxEntries);
  info(`Scanning ${limit} ${dataKeyTag} entries (total: ${total})`);

  let scanned = 0;
  let bumped = 0;
  let errors = 0;

  for (let id = 1; id <= limit; id++) {
    scanned++;

    // Build the ledger key for this entry
    const keyScVal = buildDataKeyScVal(dataKeyTag, [scValU64(id)]);
    const ledgerKey = buildPersistentLedgerKey(contractId, keyScVal);

    let ttlInfo;
    try {
      ttlInfo = await withRetry(
        () => fetchEntryTtl(server, ledgerKey),
        maxRetries,
        retryDelayMs,
        `fetchEntryTtl(${dataKeyTag}#${id})`
      );
    } catch (err) {
      error(`Failed to fetch TTL for ${dataKeyTag}#${id}: ${err.message}`);
      errors++;
      continue;
    }

    if (!ttlInfo) {
      // Entry does not exist (not yet written or already archived)
      continue;
    }

    const remaining = ttlInfo.liveUntilLedgerSeq - latestLedger;

    if (remaining < ttlThreshold) {
      info(
        `TTL below threshold for ${dataKeyTag}#${id} – remaining=${remaining} ledgers. Bumping…`,
        { id, remaining, threshold: ttlThreshold }
      );

      try {
        const txHash = await withRetry(
          () =>
            submitTtlExtensionTx(
              server,
              keypair,
              contractId,
              extendFn,
              [scValU64(id)],
              networkPassphrase
            ),
          maxRetries,
          retryDelayMs,
          `${extendFn}(${id})`
        );
        info(`Bumped ${dataKeyTag}#${id} – tx=${txHash}`);
        bumped++;
      } catch (err) {
        error(`Failed to bump ${dataKeyTag}#${id}: ${err.message}`);
        errors++;
      }
    }
  }

  return { scanned, bumped, errors };
}

// ─── Full scan cycle ─────────────────────────────────────────────────────────

/**
 * Execute one full monitoring cycle.
 *
 * 1. Check the contract instance TTL.
 * 2. Scan all vaults.
 * 3. Scan all documents.
 * 4. Scan all access requests.
 *
 * @param {object} cfg – see CONFIG shape
 * @returns {Promise<{scanned: number, bumped: number, errors: number}>}
 */
export async function runRelayerCycle(cfg = CONFIG) {
  const sdk = await loadSdk();
  const { Keypair, Networks } = sdk;

  const networkPassphrase =
    cfg.networkPassphrase || Networks.TESTNET;
  const server = new sdk.rpc.Server(cfg.rpcUrl);

  // Derive relayer Keypair
  const keypair = cfg.secretKey
    ? Keypair.fromSecret(cfg.secretKey)
    : null;

  if (!keypair) {
    warn("No RELAYER_SECRET_KEY set – TTL queries will run but no bumps will be submitted");
  }

  // Get latest ledger sequence
  const { sequence: latestLedger } = await server.getLatestLedger();
  info(`Latest ledger: ${latestLedger}`);

  let totalScanned = 0;
  let totalBumped = 0;
  let totalErrors = 0;

  // ── Step 1: Contract instance TTL ────────────────────────────────────────

  const instanceLedgerKey = buildContractInstanceLedgerKey(cfg.contractId);
  let instanceTtlInfo;
  try {
    instanceTtlInfo = await withRetry(
      () => fetchEntryTtl(server, instanceLedgerKey),
      cfg.maxRetries,
      cfg.retryDelayMs,
      "fetchEntryTtl(contractInstance)"
    );
  } catch (err) {
    error(`Failed to fetch contract instance TTL: ${err.message}`);
    totalErrors++;
  }

  if (instanceTtlInfo) {
    const remaining = instanceTtlInfo.liveUntilLedgerSeq - latestLedger;
    totalScanned++;
    if (remaining < cfg.ttlThreshold) {
      info(`Contract instance TTL below threshold – remaining=${remaining} ledgers. Bumping…`);
      if (keypair) {
        try {
          const txHash = await withRetry(
            () =>
              submitTtlExtensionTx(
                server,
                keypair,
                cfg.contractId,
                "extend_contract_ttl",
                [],
                networkPassphrase
              ),
            cfg.maxRetries,
            cfg.retryDelayMs,
            "extend_contract_ttl"
          );
          info(`Bumped contract instance – tx=${txHash}`);
          totalBumped++;
        } catch (err) {
          error(`Failed to bump contract instance: ${err.message}`);
          totalErrors++;
        }
      }
    } else {
      info(`Contract instance TTL OK – remaining=${remaining} ledgers`);
    }
  }

  // ── Step 2–4: Entity scans ────────────────────────────────────────────────

  const entityTypes = [
    {
      counterKey: "VaultCount",
      dataKeyTag: "Vault",
      extendFn: "extend_vault_ttl",
    },
    {
      counterKey: "DocCount",
      dataKeyTag: "Doc",
      extendFn: "extend_document_ttl",
    },
    {
      counterKey: "ReqCount",
      dataKeyTag: "Request",
      extendFn: "extend_request_ttl",
    },
  ];

  for (const entity of entityTypes) {
    const result = await scanAndBumpEntityType({
      server,
      keypair: keypair || {
        publicKey: () => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      },
      contractId: cfg.contractId,
      latestLedger,
      networkPassphrase,
      counterKey: entity.counterKey,
      dataKeyTag: entity.dataKeyTag,
      extendFn: entity.extendFn,
      ttlThreshold: cfg.ttlThreshold,
      maxEntries: cfg.maxEntries,
      maxRetries: cfg.maxRetries,
      retryDelayMs: cfg.retryDelayMs,
    });

    totalScanned += result.scanned;
    totalBumped += result.bumped;
    totalErrors += result.errors;
  }

  info("Cycle complete", {
    scanned: totalScanned,
    bumped: totalBumped,
    errors: totalErrors,
  });

  return { scanned: totalScanned, bumped: totalBumped, errors: totalErrors };
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate runtime configuration and throw informative errors.
 * @param {object} cfg
 */
export function validateConfig(cfg) {
  if (!cfg.contractId) {
    throw new Error(
      "VITE_STELLAR_CONTRACT_ADDRESS is not set. " +
        "Export the deployed SpooVault contract ID before starting the relayer."
    );
  }
  if (!cfg.contractId.startsWith("C") || cfg.contractId.length !== 56) {
    throw new Error(
      `VITE_STELLAR_CONTRACT_ADDRESS looks invalid: "${cfg.contractId}". ` +
        "Expected a 56-character C-strkey."
    );
  }
  if (cfg.ttlThreshold <= 0) {
    throw new Error("TTL_THRESHOLD must be a positive integer.");
  }
  if (cfg.maxTtl <= cfg.ttlThreshold) {
    throw new Error("MAX_TTL must be greater than TTL_THRESHOLD.");
  }
  if (cfg.secretKey && !cfg.secretKey.startsWith("S")) {
    throw new Error(
      "RELAYER_SECRET_KEY does not look like a valid Stellar secret key (expected S…)."
    );
  }
}

// ─── Main entry point ────────────────────────────────────────────────────────

async function main() {
  info("SpooVault Soroban TTL Relayer starting…", {
    rpcUrl: CONFIG.rpcUrl,
    contractId: CONFIG.contractId,
    ttlThreshold: CONFIG.ttlThreshold,
    maxTtl: CONFIG.maxTtl,
    pollIntervalMs: CONFIG.pollIntervalMs,
    runOnce: CONFIG.runOnce,
  });

  try {
    validateConfig(CONFIG);
  } catch (err) {
    error(err.message);
    process.exit(1);
  }

  if (!CONFIG.secretKey) {
    warn("RELAYER_SECRET_KEY is not set – the relayer will monitor TTLs but skip all bump transactions.");
  }

  const runCycle = async () => {
    try {
      await runRelayerCycle(CONFIG);
    } catch (err) {
      error(`Unexpected error during relayer cycle: ${err.message}`);
    }
  };

  if (CONFIG.runOnce) {
    await runCycle();
    info("RUN_ONCE=true – exiting after single scan.");
    return;
  }

  // Continuous mode: run immediately, then on a fixed interval.
  await runCycle();
  const interval = setInterval(runCycle, CONFIG.pollIntervalMs);

  // Graceful shutdown on SIGINT / SIGTERM
  const shutdown = () => {
    info("Received shutdown signal – stopping relayer.");
    clearInterval(interval);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run main() when this script is executed directly (not imported by tests)
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("soroban-ttl-relayer.mjs")
) {
  main();
}
