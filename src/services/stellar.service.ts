// Stellar SDK packages are loaded lazily so Soroban support stays out of the
// initial application bundle while Vite can still split them into vendor chunks.
//
// import { isConnected, getAddress } from "@stellar/freighter-api";
// import { rpc } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Freighter wallet-change subscription types
// ---------------------------------------------------------------------------
export interface StellarWalletChangeEvent {
  account?: string;
  network?: string;
}

export type StellarWalletChangeListener = (
  event: StellarWalletChangeEvent
) => void;

export type StellarUnsubscribe = () => void;

const normalizeAddressValue = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    if ("address" in value && typeof (value as { address?: unknown }).address === "string") {
      return (value as { address: string }).address.trim();
    }
    if ("publicKey" in value && typeof (value as { publicKey?: unknown }).publicKey === "string") {
      return (value as { publicKey: string }).publicKey.trim();
    }
  }
  return "";
};

const normalizeNetworkValue = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (value && typeof (value as { network?: unknown }).network === "string") {
    return (value as { network: string }).network.trim();
  }
  return "";
};

// ---------------------------------------------------------------------------
// Lightweight freighter shim – replaced by real API when package is present
// ---------------------------------------------------------------------------
export type FreighterShim = {
  isConnected: () => Promise<boolean>;
  getAddress: () => Promise<string>;
  signTransaction?: (xdr: string, opts?: any) => Promise<string>;
  signAuthEntry?: (
    preimageXdr: string,
    opts?: any
  ) => Promise<{ signedAuthEntry: string; error?: string }>;
  signBlob?: (blob: string, opts?: any) => Promise<string>;
  getNetwork?: () => Promise<unknown>;
  listen?: (callback: (event: StellarWalletChangeEvent) => void) => unknown;
};

let _freighter: any = null;
let _stellarSdk: any = null;

export const setMockFreighter = (mock: any) => {
  _freighter = mock;
};

export const setMockStellarSdk = (mock: any) => {
  _stellarSdk = mock;
};

const loadFreighter = async (): Promise<FreighterShim> => {
  if (_freighter) return _freighter;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import("@stellar/freighter-api")) as any;
    return {
      isConnected: async () => {
        try {
          const fn = mod.isConnected || mod.default?.isConnected;
          if (typeof fn !== "function") return false;
          const result = await fn();
          return typeof result === "boolean"
            ? result
            : Boolean(result?.isConnected);
        } catch {
          return false;
        }
      },
      getAddress: async () => {
        try {
          const getAddr = mod.getAddress || mod.default?.getAddress;
          if (typeof getAddr === "function") {
            return normalizeAddressValue(await getAddr());
          }
          const getPk = mod.getPublicKey || mod.default?.getPublicKey;
          if (typeof getPk === "function") {
            return normalizeAddressValue(await getPk());
          }
          const getInfo = mod.getUserInfo || mod.default?.getUserInfo;
          if (typeof getInfo === "function") {
            const info = await getInfo();
            return normalizeAddressValue(
              info &&
                typeof (info as { publicKey?: unknown }).publicKey === "string"
                ? (info as { publicKey: string }).publicKey
                : ""
            );
          }
          return "";
        } catch {
          return "";
        }
      },
      signTransaction: (xdr: string, opts?: any) => {
        const fn = mod.signTransaction || mod.default?.signTransaction;
        if (typeof fn === "function") return fn(xdr, opts);
        return Promise.resolve("");
      },
      signAuthEntry: (preimage: string, opts?: any) => {
        const fn = mod.signAuthEntry || mod.default?.signAuthEntry;
        if (typeof fn === "function") return fn(preimage, opts);
        return Promise.resolve({ signedAuthEntry: "" });
      },
      signBlob: (blob: string, opts?: any) => {
        const fn = mod.signBlob || mod.default?.signBlob;
        if (typeof fn === "function") return fn(blob, opts);
        return Promise.resolve("");
      },
      getNetwork: () => {
        const fn = mod.getNetwork || mod.default?.getNetwork;
        if (typeof fn === "function") return fn();
        return Promise.resolve("TESTNET");
      },
      listen: mod.listen || mod.default?.listen,
    };
  } catch {
    // Package not installed – graceful fallback stubs
    return {
      isConnected: async () => false,
      getAddress: async () => "",
      signTransaction: async () => "",
      signAuthEntry: async () => ({ signedAuthEntry: "" }),
      signBlob: async () => "",
    };
  }
};

const loadStellarSdk = async (): Promise<any> => {
  if (_stellarSdk) return _stellarSdk;
  try {
    _stellarSdk = await import("@stellar/stellar-sdk");
  } catch {
    throw new Error("Stellar SDK is not installed or failed to load");
  }
  return _stellarSdk;
};

export interface StellarVaultData {
  id: number;
  creator: string;
  name: string;
  description: string;
  guardians: string[];
  approvalThreshold: number;
  isActive: boolean;
  createdAt: number;
  network?: "avalanche" | "stellar";
}

export interface StellarTokenData {
  tokenId: number;
  owner: string;
  vaultId: number | null;
  tokenURI: string;
  mintedAt: number | null;
}

export interface StellarDocumentData {
  id: number;
  vaultId: number;
  encryptedMetadata: string;
  ipfsHash: string;
  uploadedBy: string;
  uploadedAt: number;
  requiredAccess: number;
}

export interface StellarPendingApprovalData {
  requestId: number;
  documentId: number;
  vaultId: number;
  vaultName: string;
  requester: string;
  createdAt: number;
  expiresAt: number;
}

let activeAccount: string | null = null;
const sorobanRpcUrl = "https://soroban-testnet.stellar.org";
let contractId = "";

export const getRpcUrl = (): string => {
  const url = import.meta.env.VITE_STELLAR_RPC_URL as string | undefined;
  return url || sorobanRpcUrl;
};

export const getContractId = (): string => {
  const cid = import.meta.env.VITE_STELLAR_CONTRACT_ADDRESS as
    | string
    | undefined;
  return cid || contractId || "";
};

// ---------------------------------------------------------------------------
// Cross-chain identity binding registry (issue #131)
// ---------------------------------------------------------------------------
// The Soroban `identity_registry` module (and the EVM
// `CrossChainIdentityRegistry.sol` contract) verify BOTH the Stellar
// (Ed25519) and EVM (secp256k1) signatures of
// `BindIdentity(evmAddr, stellarPubkey, timestamp)` on-chain before recording
// a binding. These helpers build and sign the shared payload.

const BIND_IDENTITY_PREFIX = "BindIdentity";

let identityRegistryContractId = "";

export const getIdentityRegistryContractId = (): string => {
  const cid = import.meta.env.VITE_IDENTITY_REGISTRY_ADDRESS as string | undefined;
  return cid || identityRegistryContractId;
};

const isIdentityRegistryConfigured = (): boolean => !!getIdentityRegistryContractId();

const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.replace(/^0x/i, "");
  if (clean.length % 2 !== 0) throw new Error("Invalid hex string");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

const bytesToHex = (bytes: Uint8Array | ArrayBuffer): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const base64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const loadEthers = async (): Promise<any> => {
  try {
    return await import("ethers");
  } catch {
    throw new Error("ethers is not installed or failed to load");
  }
};

const loadTweetNacl = async (): Promise<any> => {
  try {
    return await import("tweetnacl");
  } catch {
    throw new Error("tweetnacl is not installed or failed to load");
  }
};

/**
 * Build the 72-byte payload that both wallets sign:
 * "BindIdentity" || evmAddress(20) || stellarPublicKey(32) || timestamp(8, BE)
 */
const buildIdentityBindingPayload = (
  evmAddressBytes: Uint8Array,
  stellarPublicKeyBytes: Uint8Array,
  timestamp: number
): Uint8Array => {
  const payload = new Uint8Array(12 + 20 + 32 + 8);
  payload.set(new TextEncoder().encode(BIND_IDENTITY_PREFIX), 0);
  payload.set(evmAddressBytes, 12);
  payload.set(stellarPublicKeyBytes, 32);
  new DataView(payload.buffer).setBigUint64(64, BigInt(Math.floor(timestamp)), false);
  return payload;
};

/**
 * Compute the 32-byte message hash both wallets sign for a binding.
 * @returns 0x-prefixed hex of keccak256(payload)
 */
const buildIdentityBindingMessageHash = async (
  evmAddress: string,
  stellarAddress: string,
  timestamp: number
): Promise<string> => {
  const sdk = await loadStellarSdk();
  const stellarPubkey = sdk.StrKey.decodeEd25519PublicKey(stellarAddress);
  const evmBytes = hexToBytes(evmAddress);
  if (evmBytes.length !== 20) throw new Error("Invalid EVM address");
  const payload = buildIdentityBindingPayload(evmBytes, Uint8Array.from(stellarPubkey), timestamp);
  const ethersMod = await loadEthers();
  return ethersMod.keccak256(payload);
};

/**
 * Encode a 32-byte Ed25519 public key as a Stellar G-address.
 */
const encodeStellarPublicKey = async (publicKeyHex: string): Promise<string> => {
  const sdk = await loadStellarSdk();
  const bytes = hexToBytes(publicKeyHex);
  if (bytes.length !== 32) throw new Error("Invalid Stellar public key length");
  return sdk.StrKey.encodeEd25519PublicKey(bytes);
};

/**
 * Normalize the ScVal struct returned by the Soroban identity registry into a
 * plain JS object. Bytes fields come back as Buffers from scValToNative.
 */
const normalizeBindingResult = (result: any): { evmAddress: string; stellarPublicKey: string; timestamp: number } | null => {
  if (!result || typeof result !== "object") return null;
  const rawEvm = result?.evm_address ?? result?.evmAddress ?? null;
  const rawPk = result?.stellar_pubkey ?? result?.stellarPublicKey ?? null;
  const rawTs = result?.timestamp ?? null;
  if (rawPk === null || rawTs === null) return null;
  const toHexString = (v: any): string => {
    if (typeof v === "string") return v.startsWith("0x") ? v : `0x${v}`;
    if (v instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(v))) {
      return `0x${bytesToHex(v as Uint8Array)}`;
    }
    return "";
  };
  return {
    evmAddress: toHexString(rawEvm),
    stellarPublicKey: toHexString(rawPk),
    timestamp: Number(rawTs),
  };
};

const isConfigured = (): boolean => {
  return !!getContractId();
};

const initialize = async (
  customContractId?: string
): Promise<string | null> => {
  if (customContractId) {
    contractId = customContractId;
  } else {
    contractId =
      (import.meta.env.VITE_STELLAR_CONTRACT_ADDRESS as string | undefined) ||
      "";
  }

  try {
    const freighter = await loadFreighter();
    const connected = await freighter.isConnected();
    if (connected) {
      const address = await freighter.getAddress();
      activeAccount = address || null;
      return activeAccount;
    }
  } catch (error) {
    console.error("Freighter initialization failed:", error);
  }
  return null;
};

const clear = () => {
  activeAccount = null;
  activeNetwork = "";
};

const getAccount = (): string | null => activeAccount;

const connectWallet = async (): Promise<string> => {
  const freighter = await loadFreighter();
  const connected = await freighter.isConnected();
  if (!connected) {
    throw new Error("Freighter wallet extension is not installed or enabled");
  }

  const address = await freighter.getAddress();
  if (!address) {
    throw new Error("Failed to get address from Freighter wallet");
  }

  activeAccount = address;
  return address;
};

// Fallback Mock Storage for local development and test environments when Freighter/Soroban is not deployed
const inMemoryMockStorage: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Freighter wallet-change subscriptions
//
// The frontend previously snapshotted the Freighter wallet state once during
// initialization. If the user switched accounts or changed networks inside the
// Freighter extension, the app stayed out of sync and subsequent Soroban
// transactions were signed for the wrong account (HostError Auth/InvalidAction).
//
// We integrate Freighter's `listen` event subscription when it is available
// (either from the npm package or the injected window.freighterApi global) and
// fall back to a lightweight polling watcher so account/network changes are
// always detected even without native event support.
// ---------------------------------------------------------------------------

let activeNetwork = "";

const getActiveNetwork = (): string => activeNetwork;

const getNetworkValue = async (freighter: FreighterShim): Promise<string> => {
  if (typeof freighter.getNetwork !== "function") return "";
  try {
    return normalizeNetworkValue(await freighter.getNetwork());
  } catch {
    return "";
  }
};

/**
 * Resolve the current Freighter network name (e.g. "TESTNET" or "PUBLIC").
 */
const getNetwork = async (): Promise<string> => {
  const freighter = await loadFreighter();
  const network = await getNetworkValue(freighter);
  if (network) {
    activeNetwork = network;
  }
  return network || activeNetwork;
};

const getInjectedListen = ():
  | ((callback: (event: StellarWalletChangeEvent) => void) => unknown)
  | null => {
  if (typeof window === "undefined") return null;
  const injected = window.freighterApi || window.freighter;
  if (injected && typeof injected.listen === "function") {
    return injected.listen;
  }
  return null;
};

const loadListen = async (): Promise<
  ((callback: (event: StellarWalletChangeEvent) => void) => unknown) | null
> => {
  const freighter = await loadFreighter();
  if (typeof freighter.listen === "function") {
    return freighter.listen;
  }
  return getInjectedListen();
};

const startPollingWatcher = (
  listener: StellarWalletChangeListener
): (() => void) => {
  if (
    typeof window === "undefined" ||
    typeof window.setInterval !== "function"
  ) {
    return () => {};
  }

  let lastAccount = activeAccount ?? "";
  let lastNetwork = activeNetwork;

  const tick = async () => {
    try {
      const freighter = await loadFreighter();
      const [account, network] = await Promise.all([
        freighter.getAddress(),
        getNetworkValue(freighter),
      ]);
      const next: StellarWalletChangeEvent = {};
      if (account && account !== lastAccount) {
        lastAccount = account;
        activeAccount = account;
        next.account = account;
      }
      if (network && network !== lastNetwork) {
        lastNetwork = network;
        activeNetwork = network;
        next.network = network;
      }
      if (next.account || next.network) {
        listener(next);
      }
    } catch {
      // ignore transient polling failures
    }
  };

  void tick();
  const interval = window.setInterval(tick, 2000);
  return () => window.clearInterval(interval);
};

/**
 * Subscribe to Freighter account/network changes. Prefers the extension's
 * native `listen` subscription; otherwise falls back to polling. Returns an
 * unsubscribe function that should be invoked on cleanup.
 */
export const subscribeToWalletChanges = (
  listener: StellarWalletChangeListener
): StellarUnsubscribe => {
  let active = true;
  let stopNative: (() => void) | null = null;
  let stopPolling: (() => void) | null = null;

  const handleEvent = (event: StellarWalletChangeEvent) => {
    if (!active) return;
    if (event && typeof event.account === "string" && event.account) {
      activeAccount = event.account;
    }
    if (event && typeof event.network === "string" && event.network) {
      activeNetwork = event.network;
    }
    listener({
      ...(event && typeof event.account === "string" && event.account
        ? { account: event.account }
        : {}),
      ...(event && typeof event.network === "string" && event.network
        ? { network: event.network }
        : {}),
    });
  };

  void (async () => {
    try {
      const listenFn = await loadListen();
      if (!active) return;
      if (listenFn) {
        const ret = listenFn(handleEvent) as unknown;
        stopNative = typeof ret === "function" ? (ret as () => void) : () => {};
      } else {
        stopPolling = startPollingWatcher(handleEvent);
      }
    } catch {
      if (active) {
        stopPolling = startPollingWatcher(handleEvent);
      }
    }
  })();

  return () => {
    active = false;
    if (stopNative) stopNative();
    if (stopPolling) stopPolling();
  };
};

const getMockStorage = <T>(key: string, defaults: T): T => {
  try {
    if (typeof localStorage !== "undefined" && localStorage !== null) {
      const raw = localStorage.getItem(`spoovault-stellar-mock-${key}`);
      return raw ? (JSON.parse(raw) as T) : defaults;
    }
  } catch {
    // ignore and fallback
  }
  const raw = inMemoryMockStorage[`spoovault-stellar-mock-${key}`];
  return raw ? (JSON.parse(raw) as T) : defaults;
};

const saveMockStorage = <T>(key: string, data: T) => {
  const jsonStr = JSON.stringify(data);
  try {
    if (typeof localStorage !== "undefined" && localStorage !== null) {
      localStorage.setItem(`spoovault-stellar-mock-${key}`, jsonStr);
      return;
    }
  } catch {
    // ignore
  }
  inMemoryMockStorage[`spoovault-stellar-mock-${key}`] = jsonStr;
};

// Mock structures matching Soroban states
interface MockVault {
  id: number;
  creator: string;
  name: string;
  description: string;
  guardians: string[];
  approvalThreshold: number;
  isActive: boolean;
  createdAt: number;
}

interface MockDocument {
  id: number;
  vaultId: number;
  encryptedMetadata: string;
  ipfsHash: string;
  uploadedBy: string;
  uploadedAt: number;
  requiredAccess: number;
  releaseCondition: number;
  shares: Record<string, string>;
}

interface MockRequest {
  requestId: number;
  documentId: number;
  requester: string;
  approvedBy: string[];
  status: number;
  expiresAt: number;
  createdAt: number;
  beneficiaryShares: Record<string, string>;
}

interface MockInvite {
  guardian: string;
  vaultId: number;
  accepted: boolean;
  expiresAt: number;
}

export const isSigningRejection = (err: any): boolean => {
  const msg = err?.message || String(err);
  return (
    /reject|decline|cancel|denied/i.test(msg) ||
    msg.includes("Transaction was rejected")
  );
};

const executeSorobanQuery = async (
  functionName: string,
  args: any[],
  contractAddressOverride?: string
): Promise<any> => {
  const sdk = await loadStellarSdk();
  const server = new sdk.rpc.Server(sorobanRpcUrl);
  const contractAddress = contractAddressOverride || getContractId();
  const sourceAddress =
    activeAccount || "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const sourceAccount = new sdk.Account(sourceAddress, "0");

  const scArgs = args.map((arg) => {
    if (typeof arg === "string" && arg.startsWith("G") && arg.length === 56) {
      return sdk.nativeToScVal(new sdk.Address(arg));
    }
    return sdk.nativeToScVal(arg);
  });

  const op = sdk.Operation.invokeContractFunction({
    contract: new sdk.Address(contractAddress),
    function: functionName,
    args: scArgs,
  });

  const tx = new sdk.TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase: sdk.Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (sdk.rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  if (simulation.result?.retval) {
    return sdk.scValToNative(simulation.result.retval);
  }
  if (simulation.results && simulation.results.length > 0) {
    const result = simulation.results[0];
    if (result.retval) {
      return sdk.scValToNative(result.retval);
    }
  }
  return null;
};

export const executeSorobanCall = async (
  functionName: string,
  args: any[],
  contractAddressOverride?: string
): Promise<any> => {
  const freighter = await loadFreighter();
  const connected = await freighter.isConnected();
  if (!connected) {
    throw new Error("Freighter not connected");
  }
  if (!activeAccount) {
    const addr = await freighter.getAddress();
    if (addr) {
      activeAccount = addr;
    } else {
      throw new Error("Wallet not connected");
    }
  }

  const sdk = await loadStellarSdk();
  const server = new sdk.rpc.Server(sorobanRpcUrl);
  const contractAddress = contractAddressOverride || getContractId();
  const sourceAccount = await server.getAccount(activeAccount);

  // 2. Convert arguments
  const scArgs = args.map((arg) => {
    if (typeof arg === "string" && arg.startsWith("G") && arg.length === 56) {
      return sdk.nativeToScVal(new sdk.Address(arg));
    }
    if (Array.isArray(arg)) {
      return sdk.nativeToScVal(
        arg.map((item) => {
          if (
            typeof item === "string" &&
            item.startsWith("G") &&
            item.length === 56
          ) {
            return new sdk.Address(item);
          }
          return item;
        })
      );
    }
    return sdk.nativeToScVal(arg);
  });

  // 3. Build Operation & Base transaction
  const op = sdk.Operation.invokeContractFunction({
    contract: new sdk.Address(contractAddress),
    function: functionName,
    args: scArgs,
  });

  const tx = new sdk.TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase: sdk.Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  // 4. Simulate transaction
  const simulation = await server.simulateTransaction(tx);
  if (sdk.rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  // 5. Sign auth entries (simulation entries) before Freighter submission
  if (simulation.results && simulation.results.length > 0) {
    const result = simulation.results[0];
    if (result.auth && result.auth.length > 0) {
      const freighter = await loadFreighter();
      if (typeof freighter.signAuthEntry !== "function") {
        throw new Error("Freighter wallet does not support signAuthEntry");
      }
      for (let i = 0; i < result.auth.length; i++) {
        const entry = result.auth[i];
        const preimageXdr = entry.preimage().toXDR("base64");

        const signResponse = await freighter.signAuthEntry(preimageXdr);
        if (signResponse.error) {
          throw new Error(
            `Freighter auth entry signing failed: ${signResponse.error}`
          );
        }

        if (signResponse.signedAuthEntry) {
          const signedEntryXdr = signResponse.signedAuthEntry;
          const parsedEntry = sdk.xdr.SorobanAuthorizationEntry.fromXDR(
            signedEntryXdr,
            "base64"
          );
          result.auth[i] = parsedEntry;
        }
      }
    }
  }

  // 6. Assemble the transaction with simulated data
  const preparedTx = sdk.rpc.assembleTransaction(tx, simulation).build();

  // 7. Request Freighter user signature for transaction envelope
  if (typeof freighter.signTransaction !== "function") {
    throw new Error("Freighter wallet does not support signTransaction");
  }
  let signedXdr: string | undefined;
  try {
    signedXdr = await freighter.signTransaction(preparedTx.toXDR(), {
      network: "TESTNET",
    });
  } catch (err: any) {
    if (isSigningRejection(err)) {
      throw new Error("Transaction was rejected by user.");
    }
    throw err;
  }

  if (!signedXdr) {
    throw new Error("Transaction was rejected by user.");
  }

  // 8. Submit the transaction
  const signedTx = sdk.TransactionBuilder.fromXDR(
    signedXdr,
    sdk.Networks.TESTNET
  );
  const response = await server.sendTransaction(signedTx);
  if (response.status === "ERROR") {
    throw new Error(
      `Transaction submission failed: ${JSON.stringify(response.errorResult)}`
    );
  }

  // 9. Poll for status
  let pollAttempts = 0;
  while (pollAttempts < 30) {
    const txStatus = await server.getTransaction(response.hash);
    if (txStatus.status === "SUCCESS") {
      if (txStatus.returnValue) {
        return sdk.scValToNative(txStatus.returnValue);
      }
      if (
        simulation.results &&
        simulation.results.length > 0 &&
        simulation.results[0].retval
      ) {
        return sdk.scValToNative(simulation.results[0].retval);
      }
      if (simulation.result?.retval) {
        return sdk.scValToNative(simulation.result.retval);
      }
      return null;
    } else if (txStatus.status === "FAILED") {
      throw new Error(
        `Transaction execution failed: ${JSON.stringify(txStatus.resultXdr)}`
      );
    }
    const delayMs =
      typeof process !== "undefined" && process.env.NODE_ENV === "test"
        ? 1
        : 1000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    pollAttempts++;
  }

  throw new Error("Transaction polling timed out");
};

const ensureConfigured = () => {
  if (!isConfigured()) {
    throw new Error("Stellar contract is not configured");
  }
};

const createVault = async (
  name: string,
  description: string,
  guardians: string[],
  approvalThreshold: number
): Promise<number> => {
  if (!activeAccount) throw new Error("Wallet not connected");
  ensureConfigured();
  const vaultId = await executeSorobanCall("create_vault", [
    activeAccount,
    name,
    description,
    guardians,
    approvalThreshold,
  ]);
  return Number(vaultId);
};

const getVault = async (vaultId: number): Promise<StellarVaultData | null> => {
  const vaults = getMockStorage<MockVault[]>("vaults", []);
  const vault = vaults.find((v) => v.id === vaultId);
  return vault || null;
};

const fetchVaultsForAccount = async (
  account: string
): Promise<StellarVaultData[]> => {
  const vaults = getMockStorage<MockVault[]>("vaults", []);
  const target = account.toLowerCase();

  // Return vaults where user is a creator or active guardian
  return vaults
    .filter(
      (v) =>
        v.creator.toLowerCase() === target ||
        v.guardians.some((g) => g.toLowerCase() === target)
    )
    .map((v) => ({ ...v, network: "stellar" as const }));
};

const addDocument = async (
  vaultId: number,
  encryptedMetadata: string,
  ipfsHash: string,
  requiredAccess: number,
  releaseCondition = 0,
  guardiansList: string[] = [],
  shares: string[] = []
): Promise<number> => {
  if (!activeAccount) throw new Error("Wallet not connected");
  ensureConfigured();
  const docId = await executeSorobanCall("add_document", [
    activeAccount,
    vaultId,
    encryptedMetadata,
    ipfsHash,
    requiredAccess,
    releaseCondition,
    guardiansList,
    shares,
  ]);
  return Number(docId);
};

const fetchDocumentsForVaults = async (
  vaultIds: number[]
): Promise<StellarDocumentData[]> => {
  const docs = getMockStorage<MockDocument[]>("documents", []);
  const set = new Set(vaultIds);
  return docs.filter((d) => set.has(d.vaultId));
};

const requestAccess = async (documentId: number): Promise<number> => {
  if (!activeAccount) throw new Error("Wallet not connected");
  ensureConfigured();
  const requestId = await executeSorobanCall("request_access", [
    activeAccount,
    documentId,
  ]);
  return Number(requestId);
};

const approveAccess = async (
  requestId: number,
  encryptedShareForBeneficiary?: string
): Promise<void> => {
  if (!activeAccount) throw new Error("Wallet not connected");
  ensureConfigured();
  await executeSorobanCall("approve_access", [
    activeAccount,
    requestId,
    encryptedShareForBeneficiary || null,
  ]);
};

const fetchPendingApprovalsForGuardian = async (
  guardianAddress: string
): Promise<StellarPendingApprovalData[]> => {
  const requests = getMockStorage<MockRequest[]>("requests", []);
  const docs = getMockStorage<MockDocument[]>("documents", []);
  const vaults = getMockStorage<MockVault[]>("vaults", []);
  const target = guardianAddress.toLowerCase();

  const pending: StellarPendingApprovalData[] = [];

  for (const req of requests) {
    if (req.status !== 0) continue; // Not pending
    if (req.approvedBy.some((a) => a.toLowerCase() === target)) continue; // Already approved by us

    const doc = docs.find((d) => d.id === req.documentId);
    if (!doc) continue;

    const vault = vaults.find((v) => v.id === doc.vaultId);
    if (!vault) continue;

    // Check if the user is a guardian of this vault
    const isGuardian = vault.guardians.some((g) => g.toLowerCase() === target);
    if (!isGuardian) continue;

    pending.push({
      requestId: req.requestId,
      documentId: req.documentId,
      vaultId: vault.id,
      vaultName: vault.name,
      requester: req.requester,
      createdAt: req.createdAt,
      expiresAt: req.expiresAt,
    });
  }

  return pending;
};

const getEncryptedGuardianShare = async (
  documentId: number,
  guardian: string
): Promise<string> => {
  const docs = getMockStorage<MockDocument[]>("documents", []);
  const doc = docs.find((d) => d.id === documentId);
  return doc?.shares?.[guardian] || "";
};

const getBeneficiaryKeyShare = async (
  requestId: number,
  guardian: string
): Promise<string> => {
  const requests = getMockStorage<MockRequest[]>("requests", []);
  const req = requests.find((r) => r.requestId === requestId);
  return req?.beneficiaryShares?.[guardian] || "";
};

const getPendingInvites = async (account: string): Promise<MockInvite[]> => {
  const invites = getMockStorage<MockInvite[]>("invites", []);
  const target = account.toLowerCase();
  return invites.filter(
    (inv) => inv.guardian.toLowerCase() === target && !inv.accepted
  );
};

const acceptGuardianInvite = async (vaultId: number): Promise<void> => {
  if (!activeAccount) throw new Error("Wallet not connected");
  ensureConfigured();
  await executeSorobanCall("accept_guardian_invite", [
    activeAccount,
    vaultId,
  ]);
};

const registerPublicKey = async (publicKey: string): Promise<void> => {
  if (!activeAccount) throw new Error("Wallet not connected");
  ensureConfigured();
  await executeSorobanCall("register_public_key", [
    activeAccount,
    publicKey,
  ]);
};

const getUserPublicKey = async (user: string): Promise<string> => {
  if (isConfigured()) {
    try {
      const pubKey = await executeSorobanQuery("get_public_key", [user]);
      return pubKey || "";
    } catch (err) {
      console.error("Soroban get_public_key failed:", err);
    }
  }

  const pubKeys = getMockStorage<Record<string, string>>("public_keys", {});
  return pubKeys[user] || "";
};

interface MockToken {
  tokenId: number;
  owner: string;
  vaultId: number;
  tokenURI: string;
  mintedAt: number;
}

const fetchUserTokens = async (
  account: string
): Promise<StellarTokenData[]> => {
  if (!account) return [];
  const tokens = getMockStorage<MockToken[]>("tokens", []);
  const target = account.toLowerCase();
  return tokens
    .filter((t) => t.owner.toLowerCase() === target)
    .map((t) => ({
      tokenId: t.tokenId,
      owner: t.owner,
      vaultId: t.vaultId,
      tokenURI: t.tokenURI || "",
      mintedAt: t.mintedAt || null,
    }));
};

const hasVaultToken = async (
  account: string,
  vaultId: number
): Promise<boolean> => {
  if (!account || !vaultId || vaultId <= 0) return false;
  try {
    const tokens = getMockStorage<MockToken[]>("tokens", []);
    const target = account.toLowerCase();
    const hasMockToken = tokens.some(
      (t) => t.vaultId === vaultId && t.owner.toLowerCase() === target
    );
    if (hasMockToken) return true;

    if (isConfigured()) {
      const hasToken = await executeSorobanQuery("has_vault_token", [
        account,
        vaultId,
      ]);
      return !!hasToken;
    }
    return false;
  } catch (error) {
    console.error("Soroban token query failed:", error);
    return false;
  }
};

const mintAccessToken = async (
  vaultId: number,
  to: string,
  tokenURI: string
): Promise<number> => {
  if (isConfigured()) {
    try {
      const tokenId = await executeSorobanCall("mint_access_token", [
        vaultId,
        to,
        tokenURI,
      ]);
      return Number(tokenId);
    } catch (err) {
      console.error("Soroban mint_access_token failed:", err);
      throw err;
    }
  }

  const tokens = getMockStorage<MockToken[]>("tokens", []);
  const nextId = tokens.length + 1;
  const newToken: MockToken = {
    tokenId: nextId,
    owner: to,
    vaultId,
    tokenURI,
    mintedAt: Math.floor(Date.now() / 1000),
  };
  tokens.push(newToken);
  saveMockStorage("tokens", tokens);
  return nextId;
};

const saveCrossChainBindingMock = (
  evmAddress: string,
  stellarAddress: string,
  publicKey?: string
): void => {
  const normEvm = evmAddress.toLowerCase().trim();
  const normStellar = stellarAddress.trim();

  const evmToStellar = getMockStorage<Record<string, string>>(
    "cross_evm_to_stellar",
    {}
  );
  const stellarToEvm = getMockStorage<Record<string, string>>(
    "cross_stellar_to_evm",
    {}
  );
  const evmToPubkey = getMockStorage<Record<string, string>>(
    "cross_evm_to_pubkey",
    {}
  );

  evmToStellar[normEvm] = normStellar;
  stellarToEvm[normStellar] = normEvm;

  saveMockStorage("cross_evm_to_stellar", evmToStellar);
  saveMockStorage("cross_stellar_to_evm", stellarToEvm);

  if (publicKey) {
    evmToPubkey[normEvm] = publicKey;
    saveMockStorage("cross_evm_to_pubkey", evmToPubkey);

    const pubKeys = getMockStorage<Record<string, string>>("public_keys", {});
    pubKeys[normStellar] = publicKey;
    saveMockStorage("public_keys", pubKeys);
  }
};

const registerCrossChainIdentity = async (
  stellarAddress: string,
  evmAddress: string,
  publicKey?: string
): Promise<void> => {
  saveCrossChainBindingMock(evmAddress, stellarAddress, publicKey);
};

const resolveEvmToStellar = async (evmAddress: string): Promise<string | null> => {
  const normEvm = evmAddress.toLowerCase().trim();

  if (isIdentityRegistryConfigured()) {
    try {
      const binding = normalizeBindingResult(
        await executeSorobanQuery(
          "resolve_evm_to_stellar",
          [hexToBytes(normEvm)],
          getIdentityRegistryContractId()
        )
      );
      if (binding?.stellarPublicKey) {
        return encodeStellarPublicKey(binding.stellarPublicKey);
      }
    } catch (err) {
      console.error("Soroban resolve_evm_to_stellar failed:", err);
    }
  }

  const evmToStellar = getMockStorage<Record<string, string>>("cross_evm_to_stellar", {});
  return evmToStellar[normEvm] || null;
};

const resolveStellarToEvm = async (
  stellarAddress: string
): Promise<string | null> => {
  const normStellar = stellarAddress.trim();

  if (isIdentityRegistryConfigured()) {
    try {
      const sdk = await loadStellarSdk();
      const pubkey = sdk.StrKey.decodeEd25519PublicKey(normStellar);
      const binding = normalizeBindingResult(
        await executeSorobanQuery(
          "resolve_stellar_to_evm",
          [Uint8Array.from(pubkey)],
          getIdentityRegistryContractId()
        )
      );
      if (binding?.evmAddress) {
        return binding.evmAddress.toLowerCase();
      }
    } catch (err) {
      console.error("Soroban resolve_stellar_to_evm failed:", err);
    }
  }

  const stellarToEvm = getMockStorage<Record<string, string>>("cross_stellar_to_evm", {});
  return stellarToEvm[normStellar] || null;
};

// ---------------------------------------------------------------------------
// Dual-signed identity binding (MetaMask + Freighter)
// ---------------------------------------------------------------------------

export interface CrossChainIdentityBinding {
  evmAddress: string;
  stellarAddress: string;
  stellarPublicKey: string;
  timestamp: number;
  /** 65-byte EIP-191 signature (r || s || v) from MetaMask personal_sign. */
  evmSignature: string;
  /** 64-byte Ed25519 signature over the message hash from Freighter signBlob. */
  stellarSignature: string;
}

/**
 * Split a 65-byte EIP-191 signature into (r || s) and the recovery id.
 * Accepts v as 27/28 or 0/1.
 */
const splitEvmSignature = (signatureHex: string): { rs: string; recoveryId: number } => {
  const bytes = hexToBytes(signatureHex);
  if (bytes.length !== 65) throw new Error("EVM signature must be 65 bytes");
  const v = bytes[64];
  const recoveryId = v === 27 || v === 28 ? v - 27 : v;
  if (recoveryId !== 0 && recoveryId !== 1) throw new Error("Invalid EVM signature recovery id");
  return { rs: `0x${bytesToHex(bytes.slice(0, 64))}`, recoveryId };
};

/**
 * Record a dual-signed EVM <-> Stellar identity binding.
 *
 * When the Soroban identity registry is configured the binding is submitted
 * on-chain (both signatures are verified by the contract and invalid or
 * single-signed requests revert). Otherwise the signatures are verified
 * locally and the binding is recorded in the mock store.
 */
const bindIdentity = async (binding: CrossChainIdentityBinding): Promise<void> => {
  const { evmAddress, stellarAddress, stellarPublicKey, timestamp, evmSignature, stellarSignature } = binding;
  if (!evmAddress || !stellarAddress || !stellarPublicKey) {
    throw new Error("Missing binding addresses");
  }
  if (!evmSignature || !stellarSignature) {
    throw new Error("Both EVM and Stellar signatures are required");
  }
  const evmBytes = hexToBytes(evmAddress);
  const pkBytes = hexToBytes(stellarPublicKey);
  if (evmBytes.length !== 20) throw new Error("Invalid EVM address");
  if (pkBytes.length !== 32) throw new Error("Invalid Stellar public key");

  if (isIdentityRegistryConfigured()) {
    const { rs, recoveryId } = splitEvmSignature(evmSignature);
    try {
      await executeSorobanCall(
        "bind_identity",
        [
          evmBytes,
          pkBytes,
          Math.floor(timestamp),
          hexToBytes(rs),
          recoveryId,
          hexToBytes(stellarSignature),
        ],
        getIdentityRegistryContractId()
      );
      return;
    } catch (err) {
      console.error("Soroban bind_identity failed:", err);
      throw err;
    }
  }

  // Fallback: verify both signatures locally before recording.
  const messageHash = await buildIdentityBindingMessageHash(evmAddress, stellarAddress, timestamp);
  const ethersMod = await loadEthers();
  const recovered = ethersMod.verifyMessage(ethersMod.getBytes(messageHash), evmSignature);
  if (recovered.toLowerCase() !== evmAddress.toLowerCase()) {
    throw new Error("Invalid EVM signature for identity binding");
  }

  const nacl = await loadTweetNacl();
  const stellarOk = nacl.sign.detached.verify(
    ethersMod.getBytes(messageHash),
    hexToBytes(stellarSignature),
    pkBytes
  );
  if (!stellarOk) {
    throw new Error("Invalid Stellar signature for identity binding");
  }

  saveCrossChainBindingMock(evmAddress, stellarAddress, stellarPublicKey);
};

/**
 * Sign the binding message hash with MetaMask (EIP-191 personal_sign).
 * @returns the 65-byte signature and the recovery id (0/1).
 */
const signIdentityBindingWithMetaMask = async (
  messageHash: string,
  signer?: { signMessage: (message: Uint8Array) => Promise<string> }
): Promise<{ signature: string; recoveryId: number }> => {
  const ethersMod = await loadEthers();
  let activeSigner: { signMessage: (message: Uint8Array) => Promise<string> };
  if (signer) {
    activeSigner = signer;
  } else {
    if (typeof window === "undefined" || !window.ethereum) {
      throw new Error("MetaMask wallet is not available");
    }
    const provider = new ethersMod.BrowserProvider(window.ethereum);
    activeSigner = await provider.getSigner();
  }
  const signature = await activeSigner.signMessage(ethersMod.getBytes(messageHash));
  const parsed = ethersMod.Signature.from(signature);
  return { signature, recoveryId: parsed.yParity };
};

/**
 * Sign the binding message hash with Freighter (Ed25519 signBlob).
 * @returns the 64-byte Ed25519 signature as 0x-prefixed hex.
 */
const signIdentityBindingWithFreighter = async (messageHash: string): Promise<string> => {
  const freighter = await loadFreighter();
  if (typeof freighter.signBlob !== "function") {
    throw new Error("Freighter signBlob is not available");
  }
  const blob = bytesToBase64(hexToBytes(messageHash));
  const signed = await freighter.signBlob(blob);
  if (!signed) {
    throw new Error("Freighter signing was rejected");
  }
  return `0x${bytesToHex(base64ToBytes(signed))}`;
};

const resolveEvmToPublicKey = async (evmAddress: string): Promise<string | null> => {
  const normEvm = evmAddress.toLowerCase().trim();
  const evmToPubkey = getMockStorage<Record<string, string>>(
    "cross_evm_to_pubkey",
    {}
  );
  if (evmToPubkey[normEvm]) {
    return evmToPubkey[normEvm];
  }

  // Fallback: resolve via Stellar address -> public key
  const stellarAddr = await resolveEvmToStellar(normEvm);
  if (stellarAddr) {
    const pubKey = await getUserPublicKey(stellarAddr);
    if (pubKey) return pubKey;
  }

  return null;
};

export const invokeSorobanContract = async (
  functionName: string,
  args: any[],
  options?: { readonly?: boolean; contractAddress?: string }
): Promise<any> => {
  if (options?.readonly) {
    return executeSorobanQuery(functionName, args, options.contractAddress);
  }
  return executeSorobanCall(functionName, args, options?.contractAddress);
};

export const stellarService = {
  initialize,
  clear,
  getAccount,
  connectWallet,
  getActiveNetwork,
  getNetwork,
  getRpcUrl,
  getContractId,
  subscribeToWalletChanges,
  createVault,
  getVault,
  fetchVaultsForAccount,
  addDocument,
  fetchDocumentsForVaults,
  requestAccess,
  approveAccess,
  fetchPendingApprovalsForGuardian,
  getEncryptedGuardianShare,
  getBeneficiaryKeyShare,
  getPendingInvites,
  acceptGuardianInvite,
  registerPublicKey,
  getUserPublicKey,
  fetchUserTokens,
  hasVaultToken,
  mintAccessToken,
  registerCrossChainIdentity,
  resolveEvmToStellar,
  resolveStellarToEvm,
  resolveEvmToPublicKey,
  buildIdentityBindingMessageHash,
  signIdentityBindingWithMetaMask,
  signIdentityBindingWithFreighter,
  bindIdentity,
  getIdentityRegistryContractId,
  isConfigured,
  setMockStellarSdk,
  setMockFreighter,
  invokeSorobanContract,
};

declare global {
  interface Window {
    freighterApi?: {
      listen?: (
        callback: (event: StellarWalletChangeEvent) => void,
        opts?: { network?: string }
      ) => unknown;
    };
    freighter?: {
      listen?: (
        callback: (event: StellarWalletChangeEvent) => void,
        opts?: { network?: string }
      ) => unknown;
    };
  }
}
