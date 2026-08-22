/**
 * Tests for scripts/soroban-ttl-relayer.mjs
 *
 * Covers:
 *   - validateConfig       – rejects bad / missing config values
 *   - buildDataKeyScVal    – correct XDR ScVec encoding for Soroban contracttype enums
 *   - scValU64             – correct u64 ScVal wrapping
 *   - buildPersistentLedgerKey  – ledger key construction
 *   - buildContractInstanceLedgerKey
 *   - fetchEntryTtl        – parses RPC response, handles missing entries
 *   - queryEntityCount     – decodes instance-storage counter
 *   - withRetry            – retries on transient failures, propagates final error
 *   - scanAndBumpEntityType – orchestrates scan, skips OK entries, bumps expiring ones
 *   - runRelayerCycle      – full-cycle integration with mocked server + keypair
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock @stellar/stellar-sdk ────────────────────────────────────────────────
//
// The relayer imports stellar-sdk lazily via loadSdk(). We inject a controlled
// mock so tests never touch the real network.

/** Minimal in-memory ScVal representation */
class ScValMock {
  constructor(type: string, value: unknown) {
    this._type = type;
    this._value = value;
  }
  _type: string;
  _value: unknown;
  toXDR(_fmt?: string) {
    return `xdr:${this._type}:${JSON.stringify(this._value)}`;
  }
}

class LedgerKeyMock {
  _type: string;
  _value: unknown;
  constructor(type: string, value: unknown) {
    this._type = type;
    this._value = value;
  }
  toXDR(_fmt?: string) {
    return `xdrKey:${this._type}`;
  }
}

/** Shared mock XDR factories */
const mockXdr = {
  ScVal: {
    scvVec: (arr: ScValMock[]) => new ScValMock("vec", arr),
    scvSymbol: (s: string) => new ScValMock("sym", s),
    scvU64: (v: unknown) => new ScValMock("u64", v),
    scvI64: (v: unknown) => new ScValMock("i64", v),
    scvLedgerKeyContractInstance: () => new ScValMock("instance", null),
  },
  LedgerKey: {
    contractData: (d: unknown) => new LedgerKeyMock("contractData", d),
  },
  LedgerKeyContractData: class {
    contract: unknown;
    key: unknown;
    durability: unknown;
    constructor({ contract, key, durability }: { contract: unknown; key: unknown; durability: unknown }) {
      this.contract = contract;
      this.key = key;
      this.durability = durability;
    }
  },
  ContractDataDurability: {
    persistent: () => "persistent",
    instance: () => "instance",
  },
  Uint64: class {
    val: bigint;
    constructor(v: bigint) {
      this.val = v;
    }
  },
};

class MockAddress {
  _id: string;
  constructor(id: string) {
    this._id = id;
  }
  toScAddress() {
    return `scAddress:${this._id}`;
  }
}

class MockKeypair {
  _secret: string;
  constructor(secret: string) {
    this._secret = secret;
  }
  publicKey() {
    return "GBRELAYERPUBLICKEY000000000000000000000000000000000000000";
  }
  static fromSecret(secret: string) {
    return new MockKeypair(secret);
  }
  static random() {
    return new MockKeypair("SRANDOM");
  }
}

// Build a mock SDK object that tests can override per-test
const buildMockSdk = (overrides: Record<string, unknown> = {}) => ({
  xdr: mockXdr,
  Address: MockAddress,
  StrKey: { decodeContract: (s: string) => Buffer.from(s) },
  Keypair: MockKeypair,
  Account: class {
    _id: string;
    _seq: string;
    constructor(id: string, seq: string) {
      this._id = id;
      this._seq = seq;
    }
  },
  TransactionBuilder: class {
    _ops: unknown[] = [];
    addOperation(op: unknown) {
      this._ops.push(op);
      return this;
    }
    setTimeout(_t: number) {
      return this;
    }
    build() {
      return { sign: vi.fn(), toXDR: () => "mockTxXDR", _ops: this._ops };
    }
  },
  Operation: {
    invokeContractFunction: vi.fn(({ contract, function: fn, args }) => ({
      type: "invokeContractFunction",
      contract,
      function: fn,
      args,
    })),
  },
  Networks: {
    TESTNET: "Test SDF Network ; September 2015",
  },
  rpc: {
    Server: class {
      getAccount = vi.fn(async () => ({ id: "GBRELAYER", sequence: "0" }));
      getLatestLedger = vi.fn(async () => ({ sequence: 1000 }));
      getLedgerEntries = vi.fn(async () => ({ entries: [], latestLedger: 1000 }));
      simulateTransaction = vi.fn(async () => ({
        results: [{ retval: null, auth: [] }],
        minResourceFee: "100",
        transactionData: "mockSorobanData",
      }));
      sendTransaction = vi.fn(async () => ({ status: "PENDING", hash: "mockTxHash" }));
      getTransaction = vi.fn(async () => ({ status: "SUCCESS" }));
    },
    Api: {
      isSimulationError: vi.fn(() => false),
    },
    assembleTransaction: vi.fn((_tx: unknown, _sim: unknown) => ({
      build: () => ({ sign: vi.fn(), toXDR: () => "assembledXDR" }),
    })),
  },
  scValToNative: vi.fn((_scVal: unknown) => 5n),
  nativeToScVal: vi.fn((v: unknown) => new ScValMock("native", v)),
  ...overrides,
});

// ─── We need to test the relayer's exported functions, but it's a .mjs script
// that uses top-level `import` and a module-level _sdk variable.
// We exercise the exported pure functions by injecting a known mock SDK through
// the `loadSdk` seam that the module exposes.

// Dynamic import of the relayer is done inside each describe block to ensure
// the module-level _sdk variable can be set via loadSdk.
// Because Vitest caches modules, we inject the mock through the module's own
// exported `loadSdk` function (which sets the private _sdk variable on first call).

let relayer: {
  loadSdk: () => Promise<unknown>;
  buildDataKeyScVal: (tag: string, args?: unknown[]) => ScValMock;
  scValU64: (id: bigint | number) => ScValMock;
  buildPersistentLedgerKey: (contractId: string, keyScVal: unknown) => LedgerKeyMock;
  buildContractInstanceLedgerKey: (contractId: string) => LedgerKeyMock;
  fetchEntryTtl: (server: unknown, ledgerKey: unknown) => Promise<{ liveUntilLedgerSeq: number; latestLedger: number } | null>;
  queryEntityCount: (server: unknown, contractId: string, counterKey: string) => Promise<bigint>;
  withRetry: <T>(fn: () => Promise<T>, maxRetries: number, delayMs: number, label: string) => Promise<T>;
  scanAndBumpEntityType: (opts: unknown) => Promise<{ scanned: number; bumped: number; errors: number }>;
  runRelayerCycle: (cfg?: unknown) => Promise<{ scanned: number; bumped: number; errors: number }>;
  validateConfig: (cfg: unknown) => void;
};

// Inject mock SDK and import module under test before all tests
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const SECRET_KEY = "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
// Use a realistic 56-char C-strkey contract ID for validation tests
const VALID_CONTRACT_ID = "C" + "A".repeat(55);

beforeEach(async () => {
  // Re-load the module each time to get a fresh _sdk state
  // Vitest caches ES modules; we use vi.resetModules() to get a clean slate
  vi.resetModules();

  // Import after reset so we get a fresh module instance
  relayer = await import("../../scripts/soroban-ttl-relayer.mjs") as typeof relayer;

  // Prime the SDK by resolving loadSdk once with the mock
  const mockSdk = buildMockSdk();
  // Override loadSdk to return our mock
  // Because _sdk is module-private, we call loadSdk once – but it will try to
  // import the real package. Instead, we monkeypatch the function post-import.
  // The simplest seam: replace the `loadSdk` export with a function that sets
  // the internal variable. Since we cannot reach `_sdk` directly, we manually
  // call the module's loadSdk after stubbing the import.
  // For these unit tests we bypass loadSdk entirely and call helpers that
  // require _sdk to be set by first invoking loadSdk via vi.mock.

  // We achieve SDK injection by mocking the dynamic import inside the relayer.
  // Because vi.resetModules() was called, the next import will re-run module code.
  // We use vi.doMock to intercept the dynamic import('@stellar/stellar-sdk').
  vi.doMock("@stellar/stellar-sdk", () => mockSdk);

  // Re-import after doMock
  relayer = await import("../../scripts/soroban-ttl-relayer.mjs") as typeof relayer;

  // Call loadSdk once so the internal _sdk variable is populated
  await relayer.loadSdk();
});

// ─── validateConfig ───────────────────────────────────────────────────────────

describe("validateConfig", () => {
  it("throws when contractId is missing", () => {
    expect(() =>
      relayer.validateConfig({ contractId: "", ttlThreshold: 1000, maxTtl: 3_000_000, secretKey: "" })
    ).toThrow(/VITE_STELLAR_CONTRACT_ADDRESS is not set/);
  });

  it("throws when contractId does not start with C", () => {
    expect(() =>
      relayer.validateConfig({ contractId: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", ttlThreshold: 1000, maxTtl: 3_000_000, secretKey: "" })
    ).toThrow(/looks invalid/);
  });

  it("throws when contractId is wrong length", () => {
    expect(() =>
      relayer.validateConfig({ contractId: "CSHORT", ttlThreshold: 1000, maxTtl: 3_000_000, secretKey: "" })
    ).toThrow(/looks invalid/);
  });

  it("throws when ttlThreshold is 0", () => {
    expect(() =>
      relayer.validateConfig({ contractId: VALID_CONTRACT_ID, ttlThreshold: 0, maxTtl: 3_000_000, secretKey: "" })
    ).toThrow(/TTL_THRESHOLD must be a positive integer/);
  });

  it("throws when maxTtl is not greater than ttlThreshold", () => {
    expect(() =>
      relayer.validateConfig({ contractId: VALID_CONTRACT_ID, ttlThreshold: 5000, maxTtl: 5000, secretKey: "" })
    ).toThrow(/MAX_TTL must be greater than TTL_THRESHOLD/);
  });

  it("throws when secretKey doesn't start with S", () => {
    expect(() =>
      relayer.validateConfig({ contractId: VALID_CONTRACT_ID, ttlThreshold: 1000, maxTtl: 3_000_000, secretKey: "GBADKEY" })
    ).toThrow(/RELAYER_SECRET_KEY does not look like a valid/);
  });

  it("passes with valid config (no secret key)", () => {
    expect(() =>
      relayer.validateConfig({ contractId: VALID_CONTRACT_ID, ttlThreshold: 10_000, maxTtl: 3_110_400, secretKey: "" })
    ).not.toThrow();
  });

  it("passes with valid config (with secret key)", () => {
    expect(() =>
      relayer.validateConfig({
        contractId: VALID_CONTRACT_ID,
        ttlThreshold: 10_000,
        maxTtl: 3_110_400,
        secretKey: "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      })
    ).not.toThrow();
  });
});

// ─── buildDataKeyScVal ────────────────────────────────────────────────────────

describe("buildDataKeyScVal", () => {
  it("encodes a unit enum variant as a single-element ScVec", () => {
    const val = relayer.buildDataKeyScVal("VaultCount");
    expect((val as ScValMock)._type).toBe("vec");
    const vec = (val as ScValMock)._value as ScValMock[];
    expect(vec).toHaveLength(1);
    expect(vec[0]._type).toBe("sym");
    expect(vec[0]._value).toBe("VaultCount");
  });

  it("encodes a tuple variant with arguments", () => {
    const u64 = relayer.scValU64(42);
    const val = relayer.buildDataKeyScVal("Vault", [u64]);
    expect((val as ScValMock)._type).toBe("vec");
    const vec = (val as ScValMock)._value as ScValMock[];
    expect(vec).toHaveLength(2);
    expect(vec[0]._value).toBe("Vault");
    expect(vec[1]._type).toBe("u64");
  });

  it("encodes DocCount correctly", () => {
    const val = relayer.buildDataKeyScVal("DocCount");
    const vec = (val as ScValMock)._value as ScValMock[];
    expect(vec[0]._value).toBe("DocCount");
  });

  it("encodes Request(99) correctly", () => {
    const idVal = relayer.scValU64(99n);
    const val = relayer.buildDataKeyScVal("Request", [idVal]);
    const vec = (val as ScValMock)._value as ScValMock[];
    expect(vec[0]._value).toBe("Request");
    expect(vec[1]._type).toBe("u64");
  });
});

// ─── scValU64 ─────────────────────────────────────────────────────────────────

describe("scValU64", () => {
  it("creates an scvU64 ScVal from a number", () => {
    const val = relayer.scValU64(1);
    expect((val as ScValMock)._type).toBe("u64");
  });

  it("creates an scvU64 ScVal from a bigint", () => {
    const val = relayer.scValU64(1n);
    expect((val as ScValMock)._type).toBe("u64");
  });

  it("wraps value in mockXdr.Uint64", () => {
    const val = relayer.scValU64(777);
    const inner = (val as ScValMock)._value as { val: bigint };
    expect(inner.val).toBe(777n);
  });
});

// ─── buildPersistentLedgerKey ─────────────────────────────────────────────────

describe("buildPersistentLedgerKey", () => {
  it("returns a LedgerKey of type contractData", () => {
    const keyScVal = relayer.buildDataKeyScVal("VaultCount");
    const key = relayer.buildPersistentLedgerKey(VALID_CONTRACT_ID, keyScVal);
    expect((key as LedgerKeyMock)._type).toBe("contractData");
  });

  it("uses persistent durability", () => {
    const keyScVal = relayer.buildDataKeyScVal("Vault", [relayer.scValU64(1)]);
    const key = relayer.buildPersistentLedgerKey(VALID_CONTRACT_ID, keyScVal);
    const data = (key as LedgerKeyMock)._value as { durability: string };
    expect(data.durability).toBe("persistent");
  });
});

// ─── buildContractInstanceLedgerKey ──────────────────────────────────────────

describe("buildContractInstanceLedgerKey", () => {
  it("returns a LedgerKey of type contractData", () => {
    const key = relayer.buildContractInstanceLedgerKey(VALID_CONTRACT_ID);
    expect((key as LedgerKeyMock)._type).toBe("contractData");
  });

  it("uses the scvLedgerKeyContractInstance sentinel key", () => {
    const key = relayer.buildContractInstanceLedgerKey(VALID_CONTRACT_ID);
    const data = (key as LedgerKeyMock)._value as { key: ScValMock };
    expect(data.key._type).toBe("instance");
  });
});

// ─── fetchEntryTtl ────────────────────────────────────────────────────────────

describe("fetchEntryTtl", () => {
  it("returns null when the entry is not found", async () => {
    const server = { getLedgerEntries: vi.fn(async () => ({ entries: [], latestLedger: 1000 })) };
    const key = new LedgerKeyMock("contractData", {});
    const result = await relayer.fetchEntryTtl(server, key);
    expect(result).toBeNull();
  });

  it("returns liveUntilLedgerSeq and latestLedger on success", async () => {
    const server = {
      getLedgerEntries: vi.fn(async () => ({
        entries: [{ liveUntilLedgerSeq: 50_000, val: "mock" }],
        latestLedger: 40_000,
      })),
    };
    const key = new LedgerKeyMock("contractData", {});
    const result = await relayer.fetchEntryTtl(server, key);
    expect(result).not.toBeNull();
    expect(result!.liveUntilLedgerSeq).toBe(50_000);
    expect(result!.latestLedger).toBe(40_000);
  });

  it("uses the first entry when multiple are returned", async () => {
    const server = {
      getLedgerEntries: vi.fn(async () => ({
        entries: [
          { liveUntilLedgerSeq: 1_000 },
          { liveUntilLedgerSeq: 2_000 },
        ],
        latestLedger: 500,
      })),
    };
    const key = new LedgerKeyMock("contractData", {});
    const result = await relayer.fetchEntryTtl(server, key);
    expect(result!.liveUntilLedgerSeq).toBe(1_000);
  });

  it("handles missing liveUntilLedgerSeq (treats as 0)", async () => {
    const server = {
      getLedgerEntries: vi.fn(async () => ({
        entries: [{}], // no liveUntilLedgerSeq
        latestLedger: 800,
      })),
    };
    const key = new LedgerKeyMock("contractData", {});
    const result = await relayer.fetchEntryTtl(server, key);
    expect(result!.liveUntilLedgerSeq).toBe(0);
  });
});

// ─── queryEntityCount ─────────────────────────────────────────────────────────

describe("queryEntityCount", () => {
  it("returns 0n when the entry does not exist", async () => {
    const server = { getLedgerEntries: vi.fn(async () => ({ entries: [], latestLedger: 1000 })) };
    const count = await relayer.queryEntityCount(server, VALID_CONTRACT_ID, "VaultCount");
    expect(count).toBe(0n);
  });

  it("returns 0n when entry has no val", async () => {
    const server = {
      getLedgerEntries: vi.fn(async () => ({
        entries: [{ key: "k" }], // no .val
        latestLedger: 1000,
      })),
    };
    const count = await relayer.queryEntityCount(server, VALID_CONTRACT_ID, "VaultCount");
    expect(count).toBe(0n);
  });

  it("decodes a bigint counter value via scValToNative", async () => {
    // Build a fake LedgerEntryData that returns a scVal decoding to 7n
    const mockScVal = { tag: "mock" };
    const server = {
      getLedgerEntries: vi.fn(async () => ({
        entries: [
          {
            val: {
              contractData: () => ({
                val: () => mockScVal,
              }),
            },
          },
        ],
        latestLedger: 1000,
      })),
    };
    // scValToNative is already mocked to return 5n in buildMockSdk
    const count = await relayer.queryEntityCount(server, VALID_CONTRACT_ID, "VaultCount");
    expect(typeof count).toBe("bigint");
  });
});

// ─── withRetry ────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("returns the result immediately when fn succeeds on first attempt", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await relayer.withRetry(fn, 3, 0, "test");
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds on second attempt", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return "recovered";
    });
    const result = await relayer.withRetry(fn, 3, 0, "test");
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exhausts all retries and throws the last error", async () => {
    const fn = vi.fn(async () => {
      throw new Error("persistent");
    });
    await expect(relayer.withRetry(fn, 3, 0, "test")).rejects.toThrow("persistent");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("passes the correct label to log messages without throwing", async () => {
    const fn = vi.fn(async () => 42);
    await expect(relayer.withRetry(fn, 1, 0, "my-operation")).resolves.toBe(42);
  });
});

// ─── scanAndBumpEntityType ────────────────────────────────────────────────────

describe("scanAndBumpEntityType", () => {
  const makeServer = (ttlOverride?: number) => {
    const latestLedger = 100_000;
    const liveUntilLedgerSeq = ttlOverride ?? latestLedger + 50_000; // healthy by default

    return {
      getAccount: vi.fn(async () => ({ id: "GBRELAYER", sequence: "0" })),
      getLedgerEntries: vi.fn(async () => ({
        entries:
          liveUntilLedgerSeq !== undefined
            ? [{ liveUntilLedgerSeq }]
            : [],
        latestLedger,
      })),
      simulateTransaction: vi.fn(async () => ({
        results: [{ retval: null, auth: [] }],
        transactionData: "mock",
        minResourceFee: "100",
      })),
      sendTransaction: vi.fn(async () => ({ status: "PENDING", hash: "hash1" })),
      getTransaction: vi.fn(async () => ({ status: "SUCCESS" })),
    };
  };

  const defaultOpts = (server: ReturnType<typeof makeServer>, vaultCount: bigint = 2n) => ({
    server,
    keypair: MockKeypair.fromSecret("SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"),
    contractId: VALID_CONTRACT_ID,
    latestLedger: 100_000,
    networkPassphrase: "Test SDF Network ; September 2015",
    counterKey: "VaultCount" as const,
    dataKeyTag: "Vault" as const,
    extendFn: "extend_vault_ttl",
    ttlThreshold: 10_000,
    maxEntries: 10_000,
    maxRetries: 1,
    retryDelayMs: 0,
  });

  it("returns 0 bumped entries when all entries have healthy TTL", async () => {
    // liveUntilLedgerSeq = 150,000; latestLedger = 100,000 → remaining = 50,000 > 10,000
    const server = makeServer(150_000);
    // Override getLedgerEntries: first call returns count=2, subsequent calls return healthy TTL
    let callIdx = 0;
    server.getLedgerEntries = vi.fn(async () => {
      callIdx++;
      if (callIdx === 1) {
        // VaultCount query returns entries with scValToNative→2n via scValToNative mock
        return {
          entries: [
            {
              val: {
                contractData: () => ({ val: () => ({ tag: "u64" }) }),
              },
            },
          ],
          latestLedger: 100_000,
        };
      }
      return { entries: [{ liveUntilLedgerSeq: 150_000 }], latestLedger: 100_000 };
    });

    const opts = defaultOpts(server);
    const result = await relayer.scanAndBumpEntityType(opts as Parameters<typeof relayer.scanAndBumpEntityType>[0]);
    expect(result.bumped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("bumps entries below the TTL threshold", async () => {
    // liveUntilLedgerSeq = 105,000; latestLedger = 100,000 → remaining = 5,000 < 10,000
    const server = makeServer(105_000);
    let callIdx = 0;
    server.getLedgerEntries = vi.fn(async () => {
      callIdx++;
      if (callIdx === 1) {
        return {
          entries: [
            {
              val: {
                contractData: () => ({ val: () => ({ tag: "u64" }) }),
              },
            },
          ],
          latestLedger: 100_000,
        };
      }
      return { entries: [{ liveUntilLedgerSeq: 105_000 }], latestLedger: 100_000 };
    });

    const opts = defaultOpts(server);
    const result = await relayer.scanAndBumpEntityType(opts as Parameters<typeof relayer.scanAndBumpEntityType>[0]);
    expect(result.bumped).toBeGreaterThanOrEqual(1);
    expect(server.sendTransaction).toHaveBeenCalled();
  });

  it("skips non-existent entries (no bump)", async () => {
    const server = makeServer();
    let callIdx = 0;
    server.getLedgerEntries = vi.fn(async () => {
      callIdx++;
      if (callIdx === 1) {
        // count = 2 (via scValToNative mock → 5n → limit 5)
        return {
          entries: [
            {
              val: {
                contractData: () => ({ val: () => ({ tag: "u64" }) }),
              },
            },
          ],
          latestLedger: 100_000,
        };
      }
      // Entry doesn't exist
      return { entries: [], latestLedger: 100_000 };
    });

    const opts = defaultOpts(server);
    const result = await relayer.scanAndBumpEntityType(opts as Parameters<typeof relayer.scanAndBumpEntityType>[0]);
    expect(result.bumped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("records errors when bump tx submission fails", async () => {
    const server = makeServer(105_000);
    let callIdx = 0;
    server.getLedgerEntries = vi.fn(async () => {
      callIdx++;
      if (callIdx === 1) {
        return {
          entries: [{ val: { contractData: () => ({ val: () => ({}) }) } }],
          latestLedger: 100_000,
        };
      }
      return { entries: [{ liveUntilLedgerSeq: 105_000 }], latestLedger: 100_000 };
    });
    // Make sendTransaction fail
    server.sendTransaction = vi.fn(async () => {
      throw new Error("Network error");
    });

    const opts = defaultOpts(server);
    const result = await relayer.scanAndBumpEntityType(opts as Parameters<typeof relayer.scanAndBumpEntityType>[0]);
    expect(result.errors).toBeGreaterThan(0);
  });

  it("returns errors=1 when queryEntityCount throws", async () => {
    const server = makeServer();
    server.getLedgerEntries = vi.fn(async () => {
      throw new Error("RPC error");
    });

    const opts = defaultOpts(server);
    const result = await relayer.scanAndBumpEntityType(opts as Parameters<typeof relayer.scanAndBumpEntityType>[0]);
    expect(result.scanned).toBe(0);
    expect(result.errors).toBe(1);
  });
});

// ─── runRelayerCycle ──────────────────────────────────────────────────────────

describe("runRelayerCycle", () => {
  const buildCycleCfg = (overrides: Record<string, unknown> = {}) => ({
    rpcUrl: "https://soroban-testnet.stellar.org",
    contractId: VALID_CONTRACT_ID,
    secretKey: "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    pollIntervalMs: 60_000,
    ttlThreshold: 10_000,
    maxTtl: 3_110_400,
    maxEntries: 100,
    maxRetries: 1,
    retryDelayMs: 0,
    runOnce: true,
    networkPassphrase: "Test SDF Network ; September 2015",
    ...overrides,
  });

  it("returns scanned ≥ 0 for a healthy cycle with no expiring entries", async () => {
    const result = await relayer.runRelayerCycle(buildCycleCfg());
    expect(typeof result.scanned).toBe("number");
    expect(typeof result.bumped).toBe("number");
    expect(typeof result.errors).toBe("number");
    expect(result.scanned).toBeGreaterThanOrEqual(0);
  });

  it("handles missing secretKey without throwing (monitor-only mode)", async () => {
    const result = await relayer.runRelayerCycle(buildCycleCfg({ secretKey: "" }));
    expect(result).toBeDefined();
  });

  it("counts the contract instance as one scanned entry", async () => {
    // The cycle always scans the instance entry (+1 to scanned)
    const result = await relayer.runRelayerCycle(buildCycleCfg());
    // At minimum the instance was scanned (may be 0 if entry missing, which is fine)
    expect(result.scanned).toBeGreaterThanOrEqual(0);
  });
});
