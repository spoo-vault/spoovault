import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory localStorage shim for the Vitest Node environment
// ---------------------------------------------------------------------------
class MockLocalStorage {
  private store: Record<string, string> = {};

  getItem(key: string): string | null {
    return this.store[key] || null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  clear(): void {
    this.store = {};
  }
}

if (typeof globalThis.localStorage === "undefined") {
  (globalThis as any).localStorage = new MockLocalStorage();
}
if (typeof globalThis.window === "undefined") {
  (globalThis as any).window = {
    localStorage: (globalThis as any).localStorage,
  };
}

// ---------------------------------------------------------------------------
// Shared Soroban RPC mock. `serverMock` is the object returned by
// `new rpc.Server()` and cached by the service, so tests configure it here.
// ---------------------------------------------------------------------------
const { serverMock, sdk } = vi.hoisted(() => {
  const serverMock = {
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  };

  const sdk = {
    isSimulationError: vi.fn(() => false),
    assembleTransaction: vi.fn((_tx: unknown, _sim: unknown) => ({
      build: () => ({ toXDR: () => "assembled-xdr" }),
    })),
    nativeToScVal: vi.fn((value: unknown) => ({ kind: "native", value })),
    builderCalls: [] as { source: unknown; opts: Record<string, unknown> }[],
    txCalls: [] as [string, string][],
  };

  return { serverMock, sdk };
});

vi.mock("@stellar/stellar-sdk", () => {
  const scValToNative = (scv: any): any => {
    if (scv && typeof scv === "object" && "__native" in scv) {
      const val = scv.__native;
      if (Array.isArray(val)) return val.map((item: any) => scValToNative(item));
      return val;
    }
    if (Array.isArray(scv)) return scv.map((item: any) => scValToNative(item));
    return scv;
  };

  class Address {
    address: string;
    constructor(address: string) {
      this.address = address;
    }
    toScVal() {
      return { kind: "address", address: this.address };
    }
  }

  class TransactionBuilder {
    source: unknown;
    opts: Record<string, unknown>;
    op: unknown;
    constructor(source: unknown, opts: Record<string, unknown>) {
      sdk.builderCalls.push({ source, opts });
      this.source = source;
      this.opts = opts;
    }
    addOperation(op: unknown): this {
      this.op = op;
      return this;
    }
    setTimeout(): this {
      return this;
    }
    build() {
      return { source: this.source, op: this.op, toXDR: () => "built-xdr" };
    }
  }

  class Transaction {
    xdr: string;
    passphrase: string;
    constructor(xdr: string, passphrase: string) {
      sdk.txCalls.push([xdr, passphrase]);
      this.xdr = xdr;
      this.passphrase = passphrase;
    }
  }

  return {
    Address,
    BASE_FEE: "100",
    Contract: class {
      call(functionName: string, ...args: unknown[]) {
        return { functionName, args };
      }
    },
    Networks: {
      PUBLIC: "Public Global Stellar Network ; September 2015",
      TESTNET: "Test SDF Network ; September 2015",
    },
    Transaction,
    TransactionBuilder,
    nativeToScVal: sdk.nativeToScVal,
    scValToNative,
    rpc: {
      // Regular function so `new rpc.Server()` works (arrow functions are not constructable)
      Server: vi.fn(function () {
        return serverMock;
      }),
      assembleTransaction: sdk.assembleTransaction,
      Api: { isSimulationError: sdk.isSimulationError },
    },
    xdr: {
      ScVal: {
        scvSymbol: (name: string) => ({ kind: "symbol", name }),
        scvVec: (vals: unknown[]) => ({ kind: "vec", vals }),
        scvVoid: () => ({ kind: "void" }),
      },
    },
  };
});

import {
  stellarService,
  invokeSorobanContract,
  __setFreighterModuleForTesting,
} from "../services/stellar.service";

const TESTNET = "Test SDF Network ; September 2015";
const PUBLIC = "Public Global Stellar Network ; September 2015";
const CREATOR = "GBCDF123456789STEL";
const GUARDIAN = "GGUARDIAN00000001";
const GUARDIAN2 = "GGUARDIAN00000002";
const CONTRACT = "CCXAMPLE123456789CONTRACT";

interface FreighterModule {
  isConnected: () => Promise<boolean>;
  getAddress: () => Promise<string>;
  signTransaction: (xdr: string, opts?: { networkPassphrase?: string }) => Promise<string>;
  getNetwork?: () => Promise<string>;
  getNetworkDetails?: () => Promise<{ networkPassphrase?: string }>;
  getPublicKey?: () => Promise<string>;
  getUserInfo?: () => Promise<{ publicKey?: string }>;
}

// Builds a fake @stellar/freighter-api module (the shape the real browser
// extension exposes). loadFreighter() turns this into the shim the service uses.
const fakeFreighterModule = (overrides: Partial<FreighterModule> = {}): FreighterModule & {
  signTransaction: ReturnType<typeof vi.fn>;
  getAddress: ReturnType<typeof vi.fn>;
  isConnected: ReturnType<typeof vi.fn>;
} => {
  const module: any = {
    isConnected: vi.fn(async () => true),
    getAddress: vi.fn(async () => CREATOR),
    signTransaction: vi.fn(async () => "signed-xdr"),
    getNetwork: vi.fn(async () => "TESTNET"),
    getNetworkDetails: vi.fn(async () => ({ networkPassphrase: TESTNET })),
    ...overrides,
  };
  return module;
};

const resetServerMocks = () => {
  serverMock.getAccount.mockReset();
  serverMock.simulateTransaction.mockReset();
  serverMock.sendTransaction.mockReset();
  serverMock.getTransaction.mockReset();
  sdk.builderCalls.length = 0;
  sdk.txCalls.length = 0;
};

const mockSuccessfulMutation = (retval: unknown) => {
  serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
  serverMock.simulateTransaction.mockResolvedValue({
    result: { retval: { __native: retval } },
  });
  serverMock.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "txhash-1" });
  serverMock.getTransaction.mockResolvedValue({
    status: "SUCCESS",
    returnValue: { __native: retval },
  });
};

const mockReadonly = (retval: unknown) => {
  serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
  serverMock.simulateTransaction.mockResolvedValue({
    result: { retval: { __native: retval } },
  });
};

// Routes simulation responses by the invoked contract function name so tests
// can answer get_invites/get_vault/get_document/etc. differently.
const mockRoute = (routes: Record<string, unknown>) => {
  serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
  serverMock.simulateTransaction.mockImplementation(async (tx: any) => ({
    result: { retval: { __native: routes[tx?.op?.functionName] ?? null } },
  }));
};

const validVaultRaw = [
  1,
  CREATOR,
  "My Vault",
  "A test vault",
  [CREATOR, GUARDIAN],
  2,
  true,
  1700000000,
];

describe("stellarService Soroban live integration", () => {
  beforeEach(async () => {
    resetServerMocks();
    localStorage.clear();
    stellarService.clear();
    // Inject a disconnected fake Freighter module so the real browser extension
    // import is never attempted during tests, and reset the configured contract.
    __setFreighterModuleForTesting(fakeFreighterModule({ isConnected: vi.fn(async () => false) }));
    await stellarService.initialize("");
  });

  afterEach(() => {
    __setFreighterModuleForTesting(undefined);
    vi.unstubAllEnvs();
    sdk.isSimulationError.mockReturnValue(false);
  });

  describe("wallet connection", () => {
    it("throws a friendly error when Freighter is not installed", async () => {
      // A rejected dynamic import drives loadFreighter's graceful fallback stub.
      __setFreighterModuleForTesting(Promise.reject(new Error("extension missing")));
      await expect(stellarService.connectWallet()).rejects.toThrow(
        "Freighter wallet extension is not installed or enabled"
      );
    });

    it("returns the address and stores the active account when Freighter is available", async () => {
      const module = fakeFreighterModule();
      __setFreighterModuleForTesting(module);
      const address = await stellarService.connectWallet();
      expect(address).toBe(CREATOR);
      expect(stellarService.getAccount()).toBe(CREATOR);
    });

    it("throws when Freighter reports a connection but no address", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule({ getAddress: async () => "" }));
      await expect(stellarService.connectWallet()).rejects.toThrow(
        "Failed to get address from Freighter wallet"
      );
    });

    it("initializes the active account via initialize() when connected", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      const address = await stellarService.initialize(CONTRACT);
      expect(address).toBe(CREATOR);
      expect(stellarService.getAccount()).toBe(CREATOR);
    });

    it("does not set an account when Freighter is disconnected", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule({ isConnected: async () => false }));
      const result = await stellarService.initialize(CONTRACT);
      expect(result).toBeNull();
      expect(stellarService.getAccount()).toBeNull();
    });

    it("returns null when Freighter initialization throws", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule({ getAddress: async () => Promise.reject(new Error("boom")) }));
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const result = await stellarService.initialize(CONTRACT);
      expect(result).toBeNull();
      spy.mockRestore();
    });

    it("clear() resets the active account", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      stellarService.clear();
      expect(stellarService.getAccount()).toBeNull();
    });
  });

  describe("isConfigured / contract id resolution", () => {
    it("reflects the custom contract id passed to initialize()", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      expect(stellarService.isConfigured()).toBe(true);
    });

    it("is false when no contract id is configured", async () => {
      expect(stellarService.isConfigured()).toBe(false);
    });

    it("reads the contract address from VITE_STELLAR_CONTRACT_ADDRESS", async () => {
      vi.stubEnv("VITE_STELLAR_CONTRACT_ADDRESS", CONTRACT);
      expect(stellarService.isConfigured()).toBe(true);
    });
  });

  describe("invokeSorobanContract guards", () => {
    it("throws when no wallet is connected", async () => {
      await expect(invokeSorobanContract("create_vault", [])).rejects.toThrow(
        "Wallet not connected"
      );
    });

    it("throws when the contract is not configured", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      await expect(invokeSorobanContract("create_vault", [])).rejects.toThrow(
        "Stellar contract is not configured"
      );
    });

    it("throws a funding hint when the account is unknown to the RPC", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      const notFound = new Error("missing");
      notFound.name = "NotFoundError";
      serverMock.getAccount.mockRejectedValue(notFound);
      await expect(
        invokeSorobanContract("create_vault", [], { readonly: true })
      ).rejects.toThrow(/Fund your testnet account/);
    });

    it("treats a 404 status as an unknown account", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));
      await expect(
        invokeSorobanContract("create_vault", [], { readonly: true })
      ).rejects.toThrow(/Fund your testnet account/);
    });

    it("rethrows non-account errors from getAccount", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockRejectedValue(new Error("RPC unreachable"));
      await expect(
        invokeSorobanContract("create_vault", [], { readonly: true })
      ).rejects.toThrow("RPC unreachable");
    });

    it("surfaces Soroban simulation errors", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
      serverMock.simulateTransaction.mockResolvedValue({ error: "simulation exploded" });
      sdk.isSimulationError.mockReturnValue(true);
      await expect(
        invokeSorobanContract("create_vault", [], { readonly: true })
      ).rejects.toThrow(/Soroban simulation failed: simulation exploded/);
    });

    it("throws when contract data has expired and a restore is required", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
      serverMock.simulateTransaction.mockResolvedValue({ restorePreamble: { minResourceFee: "1" } });
      await expect(
        invokeSorobanContract("create_vault", [], { readonly: true })
      ).rejects.toThrow(/expired; restore footprint required/);
    });
  });

  describe("invokeSorobanContract execution", () => {
    it("resolves read-only calls without signing or submission", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockReadonly(validVaultRaw);
      const result = await invokeSorobanContract("get_vault", [], { readonly: true });
      expect(result).toEqual(validVaultRaw);
      expect(serverMock.sendTransaction).not.toHaveBeenCalled();
      expect(sdk.assembleTransaction).not.toHaveBeenCalled();
    });

    it("returns null for a void read-only result", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
      serverMock.simulateTransaction.mockResolvedValue({ result: { retval: undefined } });
      const result = await invokeSorobanContract("get_vault", [], { readonly: true });
      expect(result).toBeNull();
    });

    it("assembles, signs via Freighter, submits and polls for mutating calls", async () => {
      const module = fakeFreighterModule();
      __setFreighterModuleForTesting(module);
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(42);

      const result = await invokeSorobanContract("create_vault", []);

      expect(result).toBe(42);
      expect(sdk.assembleTransaction).toHaveBeenCalledTimes(1);
      expect(module.signTransaction).toHaveBeenCalledWith("assembled-xdr", {
        networkPassphrase: TESTNET,
      });
      expect(serverMock.sendTransaction).toHaveBeenCalledTimes(1);
      expect(serverMock.getTransaction).toHaveBeenCalledWith("txhash-1");
    });

    it("uses the network passphrase reported by Freighter", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(1);
      await invokeSorobanContract("create_vault", []);
      expect(sdk.builderCalls[sdk.builderCalls.length - 1]?.opts.networkPassphrase).toBe(TESTNET);
      expect(sdk.txCalls[sdk.txCalls.length - 1]?.[1]).toBe(TESTNET);
    });

    it("falls back to the TESTNET passphrase when Freighter exposes no network info", async () => {
      __setFreighterModuleForTesting(
        fakeFreighterModule({ getNetwork: undefined, getNetworkDetails: undefined })
      );
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(1);
      await invokeSorobanContract("create_vault", []);
      expect(sdk.builderCalls[sdk.builderCalls.length - 1]?.opts.networkPassphrase).toBe(TESTNET);
    });

    it("uses the PUBLIC passphrase when Freighter reports the public network", async () => {
      __setFreighterModuleForTesting(
        fakeFreighterModule({ getNetwork: async () => "PUBLIC", getNetworkDetails: undefined })
      );
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(1);
      await invokeSorobanContract("create_vault", []);
      expect(sdk.builderCalls[sdk.builderCalls.length - 1]?.opts.networkPassphrase).toBe(PUBLIC);
    });

    it("falls back to TESTNET when reading Freighter network details throws", async () => {
      __setFreighterModuleForTesting(
        fakeFreighterModule({ getNetworkDetails: async () => Promise.reject(new Error("boom")) })
      );
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(1);
      await invokeSorobanContract("create_vault", []);
      expect(sdk.builderCalls[sdk.builderCalls.length - 1]?.opts.networkPassphrase).toBe(TESTNET);
    });

    it("falls back to TESTNET when Freighter reports an unknown network", async () => {
      __setFreighterModuleForTesting(
        fakeFreighterModule({ getNetwork: async () => "CUSTOM", getNetworkDetails: undefined })
      );
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(1);
      await invokeSorobanContract("create_vault", []);
      expect(sdk.builderCalls[sdk.builderCalls.length - 1]?.opts.networkPassphrase).toBe(TESTNET);
    });

    it("falls back to TESTNET when Freighter reports empty network details", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule({ getNetworkDetails: async () => ({}) }));
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(1);
      await invokeSorobanContract("create_vault", []);
      expect(sdk.builderCalls[sdk.builderCalls.length - 1]?.opts.networkPassphrase).toBe(TESTNET);
    });

    it("normalizes a Freighter signing rejection into a friendly error", async () => {
      const module = fakeFreighterModule({
        signTransaction: vi.fn(async () => Promise.reject(new Error("User declined the transaction"))),
      });
      __setFreighterModuleForTesting(module);
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
      serverMock.simulateTransaction.mockResolvedValue({ result: { retval: { __native: 1 } } });
      await expect(invokeSorobanContract("create_vault", [])).rejects.toThrow(
        "Transaction signing was rejected in Freighter"
      );
    });

    it("normalizes a non-Error signing rejection into a plain error message", async () => {
      __setFreighterModuleForTesting(
        fakeFreighterModule({ signTransaction: vi.fn(async () => Promise.reject("user cancelled")) })
      );
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
      serverMock.simulateTransaction.mockResolvedValue({ result: { retval: { __native: 1 } } });
      await expect(invokeSorobanContract("create_vault", [])).rejects.toThrow("user cancelled");
    });

    it("re-throws non-rejection signing errors untouched", async () => {
      __setFreighterModuleForTesting(
        fakeFreighterModule({
          signTransaction: vi.fn(async () => Promise.reject(new Error("Freighter timed out"))),
        })
      );
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
      serverMock.simulateTransaction.mockResolvedValue({ result: { retval: { __native: 1 } } });
      await expect(invokeSorobanContract("create_vault", [])).rejects.toThrow("Freighter timed out");
    });

    it("throws when transaction submission reports an error", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
      serverMock.simulateTransaction.mockResolvedValue({ result: { retval: { __native: 1 } } });
      serverMock.sendTransaction.mockResolvedValue({ status: "ERROR", errorResult: {} });
      await expect(invokeSorobanContract("create_vault", [])).rejects.toThrow(
        "Soroban transaction submission failed"
      );
    });

    it("throws when the transaction fails on-chain while polling", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
      serverMock.simulateTransaction.mockResolvedValue({ result: { retval: { __native: 1 } } });
      serverMock.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "txhash-1" });
      serverMock.getTransaction.mockResolvedValue({ status: "FAILED", result: {} });
      await expect(invokeSorobanContract("create_vault", [])).rejects.toThrow(
        "Soroban transaction failed on-chain"
      );
    });

    it("times out while waiting for transaction completion", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
      serverMock.simulateTransaction.mockResolvedValue({ result: { retval: { __native: 1 } } });
      serverMock.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "txhash-1" });
      serverMock.getTransaction.mockResolvedValue({ status: "NOT_FOUND" });
      await expect(
        invokeSorobanContract("create_vault", [], { timeoutMs: 400 })
      ).rejects.toThrow(/Timed out waiting for the Soroban transaction/);
    });
  });

  describe("vault lifecycle", () => {
    it("creates a vault on-chain and records it in the live index", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(1);
      const vaultId = await stellarService.createVault("My Vault", "desc", [GUARDIAN], 2);
      expect(vaultId).toBe(1);

      mockRoute({ get_invites: [], get_vault: validVaultRaw });
      const vaults = await stellarService.fetchVaultsForAccount(CREATOR);
      expect(vaults).toHaveLength(1);
      expect(vaults[0].name).toBe("My Vault");
      expect(vaults[0].network).toBe("stellar");
    });

    it("does not index vault ids of zero", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(0);
      const vaultId = await stellarService.createVault("Noop", "desc", [GUARDIAN], 1);
      expect(vaultId).toBe(0);

      mockRoute({ get_invites: [] });
      const vaults = await stellarService.fetchVaultsForAccount(CREATOR);
      expect(vaults).toHaveLength(0);
    });

    it("falls back to mock storage when no contract is configured", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      const vaultId = await stellarService.createVault("Mock Vault", "desc", [GUARDIAN], 1);
      expect(vaultId).toBe(1);
      const vault = await stellarService.getVault(vaultId);
      expect(vault?.name).toBe("Mock Vault");
      expect(vault?.creator).toBe(CREATOR);
    });

    it("reads a live vault via getVault", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockReadonly(validVaultRaw);
      const vault = await stellarService.getVault(1);
      expect(vault).not.toBeNull();
      expect(vault?.name).toBe("My Vault");
      expect(vault?.guardians).toEqual([CREATOR, GUARDIAN]);
      expect(vault?.approvalThreshold).toBe(2);
    });

    it("returns null when get_vault yields no struct", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockReadonly(null);
      expect(await stellarService.getVault(1)).toBeNull();
    });

    it("returns null when get_vault yields a non-array value", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockReadonly("not-a-struct");
      expect(await stellarService.getVault(1)).toBeNull();
    });

    it("returns null when get_vault yields a struct without an id", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockReadonly([null, CREATOR, "NoId"]);
      expect(await stellarService.getVault(1)).toBeNull();
    });

    it("falls back to mock storage when the live read fails", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockRejectedValue(new Error("RPC down"));

      localStorage.setItem(
        "spoovault-stellar-mock-vaults",
        JSON.stringify([{ id: 7, creator: CREATOR, name: "Fallback", description: "", guardians: [CREATOR], approvalThreshold: 1, isActive: true, createdAt: 1 }])
      );
      const vault = await stellarService.getVault(7);
      expect(vault?.name).toBe("Fallback");
    });

    it("returns null from mock storage when the vault does not exist", async () => {
      expect(await stellarService.getVault(999)).toBeNull();
    });
  });

  describe("vault listing", () => {
    it("lists live vaults from the index and guardian invites", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);

      localStorage.setItem(
        "spoovault-stellar-mock-live_vault_index",
        JSON.stringify({ [CREATOR.toLowerCase()]: [1] })
      );
      mockRoute({
        get_invites: [[GUARDIAN, 1, false, 1700000000]],
        get_vault: validVaultRaw,
      });

      const vaults = await stellarService.fetchVaultsForAccount(CREATOR);
      expect(vaults).toHaveLength(1);
      expect(vaults[0].id).toBe(1);
    });

    it("still lists index vaults when reading invites fails", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      localStorage.setItem(
        "spoovault-stellar-mock-live_vault_index",
        JSON.stringify({ [CREATOR.toLowerCase()]: [2] })
      );
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
      serverMock.simulateTransaction.mockImplementation(async (tx: any) => {
        if (tx?.op?.functionName === "get_invites") throw new Error("invites unavailable");
        return {
          result: {
            retval: { __native: [2, CREATOR, "Indexed Vault", "d", [CREATOR], 1, true, 1] },
          },
        };
      });
      const vaults = await stellarService.fetchVaultsForAccount(CREATOR);
      expect(vaults.some((v) => v.id === 2)).toBe(true);
      spy.mockRestore();
    });

    it("gracefully degrades to an empty list when the live RPC is down", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockRejectedValue(new Error("RPC down"));
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const vaults = await stellarService.fetchVaultsForAccount(CREATOR);
      expect(vaults).toEqual([]);
      spy.mockRestore();
    });

    it("filters mock vaults by creator or guardian membership", async () => {
      localStorage.setItem(
        "spoovault-stellar-mock-vaults",
        JSON.stringify([
          { id: 1, creator: CREATOR, name: "Mine", description: "", guardians: [CREATOR], approvalThreshold: 1, isActive: true, createdAt: 1 },
          { id: 2, creator: "GOTHER", name: "Theirs", description: "", guardians: ["GOTHER"], approvalThreshold: 1, isActive: true, createdAt: 1 },
          { id: 3, creator: "GOTHER", name: "Shared", description: "", guardians: [CREATOR], approvalThreshold: 1, isActive: true, createdAt: 1 },
        ])
      );
      const vaults = await stellarService.fetchVaultsForAccount(CREATOR);
      expect(vaults.map((v) => v.id).sort()).toEqual([1, 3]);
    });
  });

  describe("document lifecycle", () => {
    it("adds a document on-chain and records it in the live document index", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(5);
      const docId = await stellarService.addDocument(1, "encrypted", "QmIpfs", 1, 0, [GUARDIAN], ["share1"]);
      expect(docId).toBe(5);

      mockReadonly([5, 1, "encrypted", "QmIpfs", CREATOR, 1700000000, "Read"]);
      const docs = await stellarService.fetchDocumentsForVaults([1]);
      expect(docs).toHaveLength(1);
      expect(docs[0].id).toBe(5);
      expect(docs[0].requiredAccess).toBe(0);
    });

    it("adds a document to mock storage when no contract is configured", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      const docId = await stellarService.addDocument(1, "encrypted", "QmIpfs", 2, 1, [GUARDIAN, GUARDIAN2], ["s1", "s2"]);
      expect(docId).toBe(1);
      const docs = await stellarService.fetchDocumentsForVaults([1]);
      expect(docs).toHaveLength(1);
      expect(docs[0].uploadedBy).toBe(CREATOR);
      expect(docs[0].requiredAccess).toBe(2);
    });

    it("does not index document ids of zero", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(0);
      const docId = await stellarService.addDocument(1, "encrypted", "QmIpfs", 0);
      expect(docId).toBe(0);
      mockReadonly([]);
      expect(await stellarService.fetchDocumentsForVaults([1])).toHaveLength(0);
    });

    it("skips live documents that fail to read", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      localStorage.setItem(
        "spoovault-stellar-mock-live_doc_index",
        JSON.stringify({ "1": [10] })
      );
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
      serverMock.simulateTransaction.mockResolvedValue({ error: "not found" });
      sdk.isSimulationError.mockReturnValue(true);
      expect(await stellarService.fetchDocumentsForVaults([1])).toHaveLength(0);
      spy.mockRestore();
    });

    it("filters documents that belong to a different vault", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      localStorage.setItem(
        "spoovault-stellar-mock-live_doc_index",
        JSON.stringify({ "1": [9] })
      );
      mockReadonly([9, 2, "encrypted", "QmIpfs", CREATOR, 1, "Read"]);
      expect(await stellarService.fetchDocumentsForVaults([1])).toHaveLength(0);
    });

    it("filters mock documents by vault id", async () => {
      localStorage.setItem(
        "spoovault-stellar-mock-documents",
        JSON.stringify([
          { id: 1, vaultId: 1, encryptedMetadata: "a", ipfsHash: "ipfs", uploadedBy: CREATOR, uploadedAt: 1, requiredAccess: 0, releaseCondition: 0, shares: {} },
          { id: 2, vaultId: 2, encryptedMetadata: "b", ipfsHash: "ipfs", uploadedBy: CREATOR, uploadedAt: 1, requiredAccess: 0, releaseCondition: 0, shares: {} },
        ])
      );
      const docs = await stellarService.fetchDocumentsForVaults([1, 3]);
      expect(docs.map((d) => d.id)).toEqual([1]);
    });
  });

  describe("access requests", () => {
    it("requests access on-chain", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(11);
      expect(await stellarService.requestAccess(3)).toBe(11);
    });

    it("requests access in mock storage", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      const requestId = await stellarService.requestAccess(3);
      expect(requestId).toBe(1);
      const pending = await stellarService.fetchPendingApprovalsForGuardian(CREATOR);
      expect(pending).toHaveLength(0);
    });

    it("approves access on-chain", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(null);
      await expect(stellarService.approveAccess(1, "encrypted-share")).resolves.toBeUndefined();
    });

    it("approves access in mock storage and completes once the threshold is met", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      localStorage.setItem(
        "spoovault-stellar-mock-vaults",
        JSON.stringify([{ id: 1, creator: "GOTHER", name: "V", description: "", guardians: [CREATOR, GUARDIAN], approvalThreshold: 2, isActive: true, createdAt: 1 }])
      );
      localStorage.setItem(
        "spoovault-stellar-mock-documents",
        JSON.stringify([{ id: 1, vaultId: 1, encryptedMetadata: "m", ipfsHash: "ipfs", uploadedBy: "GOTHER", uploadedAt: 1, requiredAccess: 0, releaseCondition: 0, shares: {} }])
      );
      localStorage.setItem(
        "spoovault-stellar-mock-requests",
        JSON.stringify([{ requestId: 1, documentId: 1, requester: "GBENEFICIARY", approvedBy: [GUARDIAN], status: 0, expiresAt: 9999999999, createdAt: 1, beneficiaryShares: {} }])
      );
      await stellarService.approveAccess(1, "share-for-beneficiary");
      const requests = JSON.parse(localStorage.getItem("spoovault-stellar-mock-requests") || "[]");
      expect(requests[0].status).toBe(1);
      expect(requests[0].beneficiaryShares[CREATOR]).toBe("share-for-beneficiary");
    });

    it("throws when approving a missing mock request", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      await expect(stellarService.approveAccess(404)).rejects.toThrow("Request not found");
    });

    it("throws when a guardian approves twice", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      localStorage.setItem(
        "spoovault-stellar-mock-requests",
        JSON.stringify([{ requestId: 1, documentId: 1, requester: "GBENEFICIARY", approvedBy: [CREATOR], status: 0, expiresAt: 9999999999, createdAt: 1, beneficiaryShares: {} }])
      );
      await expect(stellarService.approveAccess(1)).rejects.toThrow("Already approved");
    });

    it("lists pending approvals for a guardian with the right filters", async () => {
      localStorage.setItem(
        "spoovault-stellar-mock-vaults",
        JSON.stringify([
          { id: 1, creator: "GOTHER", name: "Vault One", description: "", guardians: [CREATOR, GUARDIAN], approvalThreshold: 1, isActive: true, createdAt: 1 },
          { id: 2, creator: "GOTHER", name: "Vault Two", description: "", guardians: [GUARDIAN2], approvalThreshold: 1, isActive: true, createdAt: 1 },
        ])
      );
      localStorage.setItem(
        "spoovault-stellar-mock-documents",
        JSON.stringify([
          { id: 1, vaultId: 1, encryptedMetadata: "m", ipfsHash: "ipfs", uploadedBy: "GOTHER", uploadedAt: 1, requiredAccess: 0, releaseCondition: 0, shares: {} },
          { id: 2, vaultId: 2, encryptedMetadata: "m", ipfsHash: "ipfs", uploadedBy: "GOTHER", uploadedAt: 1, requiredAccess: 0, releaseCondition: 0, shares: {} },
        ])
      );
      localStorage.setItem(
        "spoovault-stellar-mock-requests",
        JSON.stringify([
          { requestId: 1, documentId: 1, requester: "GBENEFICIARY", approvedBy: [], status: 0, expiresAt: 9999999999, createdAt: 1, beneficiaryShares: {} },
          { requestId: 2, documentId: 1, requester: "GBENEFICIARY", approvedBy: [CREATOR], status: 0, expiresAt: 9999999999, createdAt: 1, beneficiaryShares: {} },
          { requestId: 3, documentId: 1, requester: "GBENEFICIARY", approvedBy: [], status: 1, expiresAt: 9999999999, createdAt: 1, beneficiaryShares: {} },
          { requestId: 4, documentId: 2, requester: "GBENEFICIARY", approvedBy: [], status: 0, expiresAt: 9999999999, createdAt: 1, beneficiaryShares: {} },
          { requestId: 5, documentId: 3, requester: "GBENEFICIARY", approvedBy: [], status: 0, expiresAt: 9999999999, createdAt: 1, beneficiaryShares: {} },
        ])
      );
      localStorage.setItem(
        "spoovault-stellar-mock-documents",
        JSON.stringify([
          { id: 1, vaultId: 1, encryptedMetadata: "m", ipfsHash: "ipfs", uploadedBy: "GOTHER", uploadedAt: 1, requiredAccess: 0, releaseCondition: 0, shares: {} },
          { id: 2, vaultId: 2, encryptedMetadata: "m", ipfsHash: "ipfs", uploadedBy: "GOTHER", uploadedAt: 1, requiredAccess: 0, releaseCondition: 0, shares: {} },
          { id: 3, vaultId: 99, encryptedMetadata: "m", ipfsHash: "ipfs", uploadedBy: "GOTHER", uploadedAt: 1, requiredAccess: 0, releaseCondition: 0, shares: {} },
        ])
      );
      const pending = await stellarService.fetchPendingApprovalsForGuardian(CREATOR);
      expect(pending).toHaveLength(1);
      expect(pending[0].vaultName).toBe("Vault One");
      expect(pending[0].requestId).toBe(1);
    });

    it("returns guardian and beneficiary key shares from mock storage", async () => {
      localStorage.setItem(
        "spoovault-stellar-mock-documents",
        JSON.stringify([{ id: 1, vaultId: 1, encryptedMetadata: "m", ipfsHash: "ipfs", uploadedBy: "GOTHER", uploadedAt: 1, requiredAccess: 0, releaseCondition: 0, shares: { [GUARDIAN]: "guardian-share" } }])
      );
      localStorage.setItem(
        "spoovault-stellar-mock-requests",
        JSON.stringify([{ requestId: 1, documentId: 1, requester: "GBENEFICIARY", approvedBy: [], status: 0, expiresAt: 1, createdAt: 1, beneficiaryShares: { [CREATOR]: "beneficiary-share" } }])
      );
      expect(await stellarService.getEncryptedGuardianShare(1, GUARDIAN)).toBe("guardian-share");
      expect(await stellarService.getEncryptedGuardianShare(1, "GUNKNOWN")).toBe("");
      expect(await stellarService.getBeneficiaryKeyShare(1, CREATOR)).toBe("beneficiary-share");
      expect(await stellarService.getBeneficiaryKeyShare(2, CREATOR)).toBe("");
    });
  });

  describe("guardian invites", () => {
    it("returns pending invites from on-chain state", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockReadonly([
        [GUARDIAN, 1, false, 1700000000],
        [GUARDIAN, 2, true, 1700000000],
      ]);
      const invites = await stellarService.getPendingInvites(GUARDIAN);
      expect(invites).toHaveLength(1);
      expect(invites[0].vaultId).toBe(1);
      expect(invites[0].accepted).toBe(false);
    });

    it("falls back to mock invites when the live read fails", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockRejectedValue(new Error("RPC down"));
      localStorage.setItem(
        "spoovault-stellar-mock-invites",
        JSON.stringify([
          { guardian: GUARDIAN, vaultId: 1, accepted: false, expiresAt: 9999999999 },
          { guardian: GUARDIAN, vaultId: 2, accepted: true, expiresAt: 9999999999 },
          { guardian: "GOTHER", vaultId: 3, accepted: false, expiresAt: 9999999999 },
        ])
      );
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const invites = await stellarService.getPendingInvites(GUARDIAN);
      expect(invites).toHaveLength(1);
      expect(invites[0].vaultId).toBe(1);
      spy.mockRestore();
    });

    it("falls back to mock invites when the live read is not an array", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockReadonly("not-an-array");
      localStorage.setItem(
        "spoovault-stellar-mock-invites",
        JSON.stringify([{ guardian: GUARDIAN, vaultId: 5, accepted: false, expiresAt: 9999999999 }])
      );
      const invites = await stellarService.getPendingInvites(GUARDIAN);
      expect(invites).toHaveLength(1);
      expect(invites[0].vaultId).toBe(5);
    });

    it("accepts a guardian invite on-chain", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(null);
      await expect(stellarService.acceptGuardianInvite(1)).resolves.toBeUndefined();
    });

    it("accepts a guardian invite in mock storage and adds the guardian to the vault", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      localStorage.setItem(
        "spoovault-stellar-mock-invites",
        JSON.stringify([{ guardian: CREATOR, vaultId: 1, accepted: false, expiresAt: 9999999999 }])
      );
      localStorage.setItem(
        "spoovault-stellar-mock-vaults",
        JSON.stringify([{ id: 1, creator: "GOTHER", name: "V", description: "", guardians: ["GOTHER"], approvalThreshold: 1, isActive: true, createdAt: 1 }])
      );
      await stellarService.acceptGuardianInvite(1);
      const invites = JSON.parse(localStorage.getItem("spoovault-stellar-mock-invites") || "[]");
      expect(invites[0].accepted).toBe(true);
      const vaults = JSON.parse(localStorage.getItem("spoovault-stellar-mock-vaults") || "[]");
      expect(vaults[0].guardians).toContain(CREATOR);
    });

    it("accepting an invite does not fail when the vault is missing from mock storage", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      localStorage.setItem(
        "spoovault-stellar-mock-invites",
        JSON.stringify([{ guardian: CREATOR, vaultId: 1, accepted: false, expiresAt: 9999999999 }])
      );
      await expect(stellarService.acceptGuardianInvite(1)).resolves.toBeUndefined();
    });
  });

  describe("public key registry", () => {
    it("registers a public key on-chain", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(null);
      await expect(stellarService.registerPublicKey("pubkey-1")).resolves.toBeUndefined();
    });

    it("registers a public key in mock storage", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      await stellarService.registerPublicKey("pubkey-mock");
      expect(await stellarService.getUserPublicKey(CREATOR)).toBe("pubkey-mock");
    });

    it("reads a public key from on-chain state", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockReadonly("pubkey-live");
      expect(await stellarService.getUserPublicKey(GUARDIAN)).toBe("pubkey-live");
    });

    it("returns an empty string when the on-chain value is not a string", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockReadonly(12345);
      expect(await stellarService.getUserPublicKey(GUARDIAN)).toBe("");
    });

    it("falls back to mock storage when the live read fails", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockRejectedValue(new Error("RPC down"));
      localStorage.setItem(
        "spoovault-stellar-mock-public_keys",
        JSON.stringify({ [GUARDIAN]: "fallback-key" })
      );
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(await stellarService.getUserPublicKey(GUARDIAN)).toBe("fallback-key");
      spy.mockRestore();
    });

    it("returns an empty string when no key exists in mock storage", async () => {
      expect(await stellarService.getUserPublicKey("GUNKNOWN")).toBe("");
    });
  });

  describe("tokens", () => {
    it("mints an access token and reports ownership", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      const tokenId = await stellarService.mintAccessToken(1, GUARDIAN, "ipfs://token");
      expect(tokenId).toBe(1);
      expect(await stellarService.hasVaultToken(GUARDIAN, 1)).toBe(true);
      expect(await stellarService.hasVaultToken(CREATOR, 1)).toBe(false);
    });

    it("returns false for invalid ownership queries", async () => {
      expect(await stellarService.hasVaultToken("", 1)).toBe(false);
      expect(await stellarService.hasVaultToken(CREATOR, 0)).toBe(false);
      expect(await stellarService.hasVaultToken(CREATOR, -1)).toBe(false);
    });

    it("returns false when the mock token query throws", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      localStorage.setItem("spoovault-stellar-mock-tokens", "{invalid-json");
      expect(await stellarService.hasVaultToken(CREATOR, 1)).toBe(false);
      spy.mockRestore();
    });

    it("lists tokens owned by an account", async () => {
      localStorage.setItem(
        "spoovault-stellar-mock-tokens",
        JSON.stringify([
          { tokenId: 1, owner: CREATOR, vaultId: 1, tokenURI: "ipfs://1", mintedAt: 1 },
          { tokenId: 2, owner: GUARDIAN, vaultId: 2, tokenURI: "ipfs://2", mintedAt: 2 },
        ])
      );
      const tokens = await stellarService.fetchUserTokens(CREATOR);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].vaultId).toBe(1);
      expect(await stellarService.fetchUserTokens("")).toHaveLength(0);
    });
  });

  describe("mock storage resilience", () => {
    it("returns defaults when mock storage holds corrupt JSON", async () => {
      localStorage.setItem("spoovault-stellar-mock-vaults", "{corrupt");
      const vaults = await stellarService.fetchVaultsForAccount(CREATOR);
      expect(vaults).toHaveLength(0);
    });

    it("ignores failures while persisting mock data", async () => {
      const spy = vi.spyOn(globalThis.localStorage as any, "setItem").mockImplementation(() => {
        throw new Error("quota exceeded");
      });
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      const vaultId = await stellarService.createVault("Quota", "desc", [GUARDIAN], 1);
      expect(vaultId).toBe(1);
      spy.mockRestore();
    });
  });

  describe("loadFreighter module resolution", () => {
    it("uses the CJS default export when the module exposes one", async () => {
      const inner = fakeFreighterModule();
      __setFreighterModuleForTesting({ default: inner });
      const address = await stellarService.connectWallet();
      expect(address).toBe(CREATOR);
      expect(inner.isConnected).toHaveBeenCalled();
    });

    it("resolves the address via getPublicKey when getAddress is absent", async () => {
      const module = fakeFreighterModule({
        getAddress: undefined,
        getPublicKey: vi.fn(async () => CREATOR),
      });
      __setFreighterModuleForTesting(module);
      expect(await stellarService.connectWallet()).toBe(CREATOR);
    });

    it("falls back to an empty address when getPublicKey returns nothing", async () => {
      const module = fakeFreighterModule({
        getAddress: undefined,
        getPublicKey: vi.fn(async () => ""),
      });
      __setFreighterModuleForTesting(module);
      await expect(stellarService.connectWallet()).rejects.toThrow("Failed to get address");
    });

    it("resolves the address from getUserInfo when it is the only option", async () => {
      const module = fakeFreighterModule({
        getAddress: undefined,
        getUserInfo: vi.fn(async () => ({ publicKey: CREATOR })),
      });
      __setFreighterModuleForTesting(module);
      expect(await stellarService.connectWallet()).toBe(CREATOR);
    });

    it("returns an empty address when getUserInfo exposes no public key", async () => {
      const module = fakeFreighterModule({
        getAddress: undefined,
        getUserInfo: vi.fn(async () => ({})),
      });
      __setFreighterModuleForTesting(module);
      await expect(stellarService.connectWallet()).rejects.toThrow("Failed to get address");
    });

    it("returns an empty address when the module exposes no address resolver", async () => {
      const module = fakeFreighterModule({
        getAddress: undefined,
        getPublicKey: undefined,
        getUserInfo: undefined,
      });
      __setFreighterModuleForTesting(module);
      await expect(stellarService.connectWallet()).rejects.toThrow("Failed to get address");
    });
  });

  describe("wallet-not-connected guards", () => {
    it("createVault requires a connected wallet", async () => {
      await expect(stellarService.createVault("V", "d", [GUARDIAN], 1)).rejects.toThrow(
        "Wallet not connected"
      );
    });

    it("addDocument requires a connected wallet", async () => {
      await expect(stellarService.addDocument(1, "m", "ipfs", 0)).rejects.toThrow(
        "Wallet not connected"
      );
    });

    it("requestAccess requires a connected wallet", async () => {
      await expect(stellarService.requestAccess(1)).rejects.toThrow("Wallet not connected");
    });

    it("approveAccess requires a connected wallet", async () => {
      await expect(stellarService.approveAccess(1)).rejects.toThrow("Wallet not connected");
    });

    it("acceptGuardianInvite requires a connected wallet", async () => {
      await expect(stellarService.acceptGuardianInvite(1)).rejects.toThrow("Wallet not connected");
    });

    it("registerPublicKey requires a connected wallet", async () => {
      await expect(stellarService.registerPublicKey("pk")).rejects.toThrow("Wallet not connected");
    });
  });

  describe("scVal decoder edge cases", () => {
    it("parses a vault struct with absent fields using safe defaults", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockReadonly([1, null, null, null, "not-an-array", null, null, null]);
      const vault = await stellarService.getVault(1);
      expect(vault).toEqual({
        id: 1,
        creator: "",
        name: "",
        description: "",
        guardians: [],
        approvalThreshold: 0,
        isActive: false,
        createdAt: 0,
      });
    });

    it("parses a document struct with absent fields using safe defaults", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      localStorage.setItem("spoovault-stellar-mock-live_doc_index", JSON.stringify({ "1": [1] }));
      mockReadonly([1, 1, null, null, null, null, "UnknownLevel"]);
      const docs = await stellarService.fetchDocumentsForVaults([1]);
      expect(docs).toHaveLength(1);
      expect(docs[0].vaultId).toBe(1);
      expect(docs[0].requiredAccess).toBe(0);
      expect(docs[0].encryptedMetadata).toBe("");
      expect(docs[0].uploadedAt).toBe(0);
    });

    it("skips null, non-array and id-less documents returned from the chain", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      localStorage.setItem(
        "spoovault-stellar-mock-live_doc_index",
        JSON.stringify({ "1": [1, 2, 3] })
      );
      mockRoute({
        get_document: [null, "not-a-doc", [null, 1]],
      });
      expect(await stellarService.fetchDocumentsForVaults([1])).toHaveLength(0);
    });

    it("skips null, non-array and id-less invites returned from the chain", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockReadonly([null, "not-an-invite", [GUARDIAN, null, false, 1]]);
      expect(await stellarService.getPendingInvites(GUARDIAN)).toHaveLength(0);
    });
  });

  describe("live listing branches", () => {
    it("ignores non-array get_invites results while listing vaults", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      localStorage.setItem(
        "spoovault-stellar-mock-live_vault_index",
        JSON.stringify({ [CREATOR.toLowerCase()]: [1] })
      );
      mockRoute({ get_invites: "not-an-array", get_vault: validVaultRaw });
      const vaults = await stellarService.fetchVaultsForAccount(CREATOR);
      expect(vaults).toHaveLength(1);
      expect(vaults[0].id).toBe(1);
    });

    it("skips invalid invites but keeps valid ones", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockRoute({
        get_invites: [null, [GUARDIAN, 1, false, 1700000000]],
        get_vault: validVaultRaw,
      });
      const vaults = await stellarService.fetchVaultsForAccount(GUARDIAN);
      expect(vaults).toHaveLength(1);
      expect(vaults[0].id).toBe(1);
    });

    it("skips index entries whose vault can no longer be read", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      localStorage.setItem(
        "spoovault-stellar-mock-live_vault_index",
        JSON.stringify({ [CREATOR.toLowerCase()]: [1, 2] })
      );
      serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
      serverMock.simulateTransaction.mockImplementation(async (tx: any) => {
        if (tx?.op?.functionName === "get_invites") {
          return { result: { retval: { __native: [] } } };
        }
        const vaultId = Number(tx?.op?.args?.[0]?.value);
        if (vaultId === 2) return { result: { retval: { __native: null } } };
        return { result: { retval: { __native: validVaultRaw } } };
      });
      const vaults = await stellarService.fetchVaultsForAccount(CREATOR);
      expect(vaults).toHaveLength(1);
      expect(vaults[0].id).toBe(1);
    });
  });

  describe("return value normalization", () => {
    it("uses the simulation return value when the completion exposes none", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
      serverMock.simulateTransaction.mockResolvedValue({ result: { retval: { __native: 7 } } });
      serverMock.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "txhash-1" });
      serverMock.getTransaction.mockResolvedValue({ status: "SUCCESS", returnValue: undefined });
      expect(await invokeSorobanContract("create_vault", [])).toBe(7);
    });

    it("returns null when both return values are absent", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockResolvedValue({ accountId: CREATOR, sequenceNumber: "1" });
      serverMock.simulateTransaction.mockResolvedValue({ result: { retval: null } });
      serverMock.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "txhash-1" });
      serverMock.getTransaction.mockResolvedValue({ status: "SUCCESS", returnValue: null });
      expect(await invokeSorobanContract("prove_life", [])).toBeNull();
    });

    it("createVault returns zero and skips indexing when the chain returns no id", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(null);
      expect(await stellarService.createVault("Noop", "d", [GUARDIAN], 1)).toBe(0);
    });

    it("requestAccess returns zero when the chain returns no request id", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(null);
      expect(await stellarService.requestAccess(1)).toBe(0);
    });

    it("addDocument coerces out-of-range levels and a missing id safely", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      mockSuccessfulMutation(null);
      expect(await stellarService.addDocument(1, "m", "ipfs", 99, 99)).toBe(0);
    });
  });

  describe("mock access approval branches", () => {
    it("approves without attaching a beneficiary share", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      localStorage.setItem(
        "spoovault-stellar-mock-requests",
        JSON.stringify([{ requestId: 1, documentId: 1, requester: "GBENEFICIARY", approvedBy: [], status: 0, expiresAt: 9999999999, createdAt: 1, beneficiaryShares: {} }])
      );
      await stellarService.approveAccess(1);
      const requests = JSON.parse(localStorage.getItem("spoovault-stellar-mock-requests") || "[]");
      expect(requests[0].approvedBy).toContain(CREATOR);
      expect(requests[0].beneficiaryShares).toEqual({});
    });

    it("keeps the request pending when its document is missing", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      localStorage.setItem(
        "spoovault-stellar-mock-requests",
        JSON.stringify([{ requestId: 1, documentId: 404, requester: "GBENEFICIARY", approvedBy: [], status: 0, expiresAt: 9999999999, createdAt: 1, beneficiaryShares: {} }])
      );
      await stellarService.approveAccess(1);
      const requests = JSON.parse(localStorage.getItem("spoovault-stellar-mock-requests") || "[]");
      expect(requests[0].status).toBe(0);
    });

    it("keeps the request pending when its vault is missing", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      localStorage.setItem(
        "spoovault-stellar-mock-documents",
        JSON.stringify([{ id: 1, vaultId: 404, encryptedMetadata: "m", ipfsHash: "ipfs", uploadedBy: "GOTHER", uploadedAt: 1, requiredAccess: 0, releaseCondition: 0, shares: {} }])
      );
      localStorage.setItem(
        "spoovault-stellar-mock-requests",
        JSON.stringify([{ requestId: 1, documentId: 1, requester: "GBENEFICIARY", approvedBy: [], status: 0, expiresAt: 9999999999, createdAt: 1, beneficiaryShares: {} }])
      );
      await stellarService.approveAccess(1);
      const requests = JSON.parse(localStorage.getItem("spoovault-stellar-mock-requests") || "[]");
      expect(requests[0].status).toBe(0);
    });

    it("ignores acceptGuardianInvite when no matching invite exists", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      localStorage.setItem("spoovault-stellar-mock-invites", JSON.stringify([]));
      await expect(stellarService.acceptGuardianInvite(1)).resolves.toBeUndefined();
    });

    it("does not duplicate a guardian already present in the vault", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      localStorage.setItem(
        "spoovault-stellar-mock-invites",
        JSON.stringify([{ guardian: CREATOR, vaultId: 1, accepted: false, expiresAt: 9999999999 }])
      );
      localStorage.setItem(
        "spoovault-stellar-mock-vaults",
        JSON.stringify([{ id: 1, creator: "GOTHER", name: "V", description: "", guardians: [CREATOR], approvalThreshold: 1, isActive: true, createdAt: 1 }])
      );
      await stellarService.acceptGuardianInvite(1);
      const vaults = JSON.parse(localStorage.getItem("spoovault-stellar-mock-vaults") || "[]");
      expect(vaults[0].guardians).toEqual([CREATOR]);
    });
  });

  describe("mock createVault invite handling", () => {
    it("skips the creator when building the invite list", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.connectWallet();
      const vaultId = await stellarService.createVault("V", "d", [GUARDIAN, CREATOR], 2);
      expect(vaultId).toBe(1);
      const invites = JSON.parse(localStorage.getItem("spoovault-stellar-mock-invites") || "[]");
      expect(invites).toHaveLength(1);
      expect(invites[0].guardian).toBe(GUARDIAN);
    });
  });

  describe("RPC account resolution edge cases", () => {
    it("treats a 500 status as an unknown account", async () => {
      __setFreighterModuleForTesting(fakeFreighterModule());
      await stellarService.initialize(CONTRACT);
      serverMock.getAccount.mockRejectedValue(Object.assign(new Error("server error"), { status: 500 }));
      await expect(
        invokeSorobanContract("create_vault", [], { readonly: true })
      ).rejects.toThrow(/Fund your testnet account/);
    });
  });

  describe("token listing defaults", () => {
    it("fills empty token metadata with empty strings", async () => {
      localStorage.setItem(
        "spoovault-stellar-mock-tokens",
        JSON.stringify([{ tokenId: 3, owner: CREATOR, vaultId: 3, tokenURI: "", mintedAt: null }])
      );
      const tokens = await stellarService.fetchUserTokens(CREATOR);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].tokenURI).toBe("");
      expect(tokens[0].mintedAt).toBeNull();
    });
  });
});
describe('stellarService - Cross-Chain Identity Resolution', () => {
  it('should register and resolve EVM address to Stellar address and public key', async () => {
    const stellarAddress = 'GBZXN7PIRZGNMHGA72STUFTOAITGM522NM3TVYLZMJOXOALPUYSTZFEF';
    const evmAddress = '0x64128680775Ef626379DeF6E5c815AeA8F4707Ef';
    const pubKey = '0x04bfcab5516089d846985a12';

    await stellarService.registerCrossChainIdentity(stellarAddress, evmAddress, pubKey);

    const resolvedStellar = await stellarService.resolveEvmToStellar(evmAddress);
    expect(resolvedStellar).toBe(stellarAddress);

    const resolvedEvm = await stellarService.resolveStellarToEvm(stellarAddress);
    expect(resolvedEvm).toBe(evmAddress.toLowerCase());

    const resolvedPubKey = await stellarService.resolveEvmToPublicKey(evmAddress);
    expect(resolvedPubKey).toBe(pubKey);
  });

  it('should fallback to resolving Stellar public key if direct EVM pubkey not registered', async () => {
    const stellarAddress = 'GDJNX7PIRZGNMHGA72STUFTOAITGM522NM3TVYLZMJOXOALPUYSTZFEF';
    const evmAddress = '0x1234567890123456789012345678901234567890';
    const pubKey = 'STELLAR_DIRECT_PUBLIC_KEY';

    // Register with stellar public key first
    await stellarService.registerCrossChainIdentity(stellarAddress, '0x8888888888888888888888888888888888888888', pubKey);

    // Register cross-chain identity without separate pubkey
    await stellarService.registerCrossChainIdentity(stellarAddress, evmAddress);

    const resolvedPubKey = await stellarService.resolveEvmToPublicKey(evmAddress);
    expect(resolvedPubKey).toBe(pubKey);
  });

  it('should return null for unregistered EVM or Stellar addresses', async () => {
    const resolvedStellar = await stellarService.resolveEvmToStellar('0x0000000000000000000000000000000000000000');
    expect(resolvedStellar).toBeNull();

    const resolvedEvm = await stellarService.resolveStellarToEvm('GNOTREGISTEREDADDRESSZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(resolvedEvm).toBeNull();

    const resolvedPubKey = await stellarService.resolveEvmToPublicKey('0x9999999999999999999999999999999999999999');
    expect(resolvedPubKey).toBeNull();
  });
});
