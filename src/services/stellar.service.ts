// @stellar/stellar-sdk provides Soroban contract invocation, transaction
// building, simulation and XDR helpers. It is a hard dependency and is
// imported statically so TypeScript can validate our usage.
// @stellar/freighter-api (the browser wallet bridge) is loaded lazily through
// an eval-style import so that non-browser environments degrade gracefully.
import {
  Address,
  BASE_FEE,
  Contract,
  Networks,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
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

export type StellarWalletChangeListener = (event: StellarWalletChangeEvent) => void;

export type StellarUnsubscribe = () => void;

const normalizeAddressValue = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (value && typeof (value as { address?: unknown }).address === "string") {
    return (value as { address: string }).address.trim();
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
interface SignTransactionOptions {
  networkPassphrase?: string;
  accountToSign?: string;
  network?: string;
}

export type FreighterShim = {
  isConnected: () => Promise<boolean>;
  getAddress: () => Promise<string>;
  signTransaction?: (transactionXdr: string, opts?: SignTransactionOptions) => Promise<string>;
  signAuthEntry?: (
    preimageXdr: string,
    opts?: Record<string, unknown>
  ) => Promise<{ signedAuthEntry: string; error?: string }>;
  getNetwork?: () => Promise<unknown>;
  getNetworkDetails?: () => Promise<{ networkPassphrase?: string }>;
  listen?: (callback: (event: StellarWalletChangeEvent) => void) => unknown;
};

let _freighter: FreighterShim | null = null;
let _freighterModuleOverride: unknown = undefined;
let _stellarSdk: unknown = null;

// Test seam: lets Vitest inject a fake @stellar/freighter-api module (or a
// rejected promise) without a browser extension being installed. Undefined in
// production, so the normal lazy import is used. Resets the cached shim so a
// subsequent loadFreighter() rebuilds it from the injected module.
export const __setFreighterModuleForTesting = (moduleOrRejection: unknown): void => {
  _freighterModuleOverride = moduleOrRejection;
  _freighter = null;
};

export const setMockFreighter = (mock: FreighterShim | null) => {
  _freighter = mock;
};

export const setMockStellarSdk = (mock: unknown) => {
  _stellarSdk = mock;
};

const loadFreighter = async (): Promise<FreighterShim> => {
  if (_freighter) return _freighter;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = _freighterModuleOverride !== undefined
      ? await Promise.resolve(_freighterModuleOverride)
      : await import(/* @vite-ignore */ "@stellar/freighter-api") as any;
    // CJS interop: the module functions may live on `mod.default`
    const api = mod?.default ?? mod;

    _freighter = {
      isConnected: async () => {
        try {
          const result = await api.isConnected();
          return typeof result === "boolean" ? result : Boolean(result?.isConnected);
        } catch {
          return false;
        }
      },
      getAddress: async () => {
        try {
          if (typeof api.getAddress === "function") {
            return normalizeAddressValue(await api.getAddress());
          }
          if (typeof api.getPublicKey === "function") {
            return normalizeAddressValue(await api.getPublicKey());
          }
          if (typeof api.getUserInfo === "function") {
            const info = await api.getUserInfo();
            return normalizeAddressValue(
              info && typeof (info as { publicKey?: unknown }).publicKey === "string"
                ? (info as { publicKey: string }).publicKey
                : ""
            );
          }
          return "";
        } catch {
          return "";
        }
      },
      signTransaction: api.signTransaction,
      signAuthEntry: api.signAuthEntry,
      getNetwork: typeof api?.getNetwork === "function" ? api.getNetwork : undefined,
      getNetworkDetails: api.getNetworkDetails,
      listen: typeof api?.listen === "function" ? api.listen : undefined,
    };
  } catch {

    // Package not installed – graceful fallback stubs
    _freighter = {
      isConnected: async () => false,
      getAddress: async () => "",
      signTransaction: async () => {
        throw new Error("Freighter wallet is not installed or enabled");
      },
      getNetwork: async () => "TESTNET",
      signAuthEntry: async () => ({ signedAuthEntry: "" }),
    };
  }
  return _freighter;
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

const getContractId = (): string => {
  const cid = import.meta.env.VITE_STELLAR_CONTRACT_ADDRESS as string | undefined;
  return cid || contractId || "";
};

export const getRpcUrl = (): string => sorobanRpcUrl;

export const getContractIdForWatcher = (): string => getContractId();

const isConfigured = (): boolean => {
  return !!getContractId();
};

// ---------------------------------------------------------------------------
// Soroban RPC + scVal helpers for live contract invocations
// ---------------------------------------------------------------------------
let _server: rpc.Server | null = null;

const getSorobanServer = (): rpc.Server => {
  if (!_server) _server = new rpc.Server(sorobanRpcUrl);
  return _server;
};

const getNetworkPassphrase = async (): Promise<string> => {
  try {
    const freighter = await loadFreighter();
    if (typeof freighter.getNetworkDetails === "function") {
      const details = await freighter.getNetworkDetails();
      if (details?.networkPassphrase) return details.networkPassphrase;
    }
    if (typeof freighter.getNetwork === "function") {
      const network = await freighter.getNetwork();
      if (network === "PUBLIC") return Networks.PUBLIC;
      if (network === "TESTNET") return Networks.TESTNET;
    }
  } catch {
    // Fall through to the testnet default
  }
  return Networks.TESTNET;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const addressScVal = (address: string): xdr.ScVal => new Address(address).toScVal();
const textScVal = (value: string): xdr.ScVal => nativeToScVal(value);
const u64ScVal = (value: number): xdr.ScVal => nativeToScVal(BigInt(value), { type: "u64" });
const u32ScVal = (value: number): xdr.ScVal => nativeToScVal(value, { type: "u32" });
const symbolScVal = (name: string): xdr.ScVal => xdr.ScVal.scvSymbol(name);
const addressVecScVal = (addresses: string[]): xdr.ScVal =>
  xdr.ScVal.scvVec(addresses.map(addressScVal));
const textVecScVal = (values: string[]): xdr.ScVal =>
  xdr.ScVal.scvVec(values.map(textScVal));
const optionTextScVal = (value?: string): xdr.ScVal =>
  value ? textScVal(value) : xdr.ScVal.scvVoid();

const ACCESS_LEVEL_NAMES = ["Read", "ReadWrite", "Admin"] as const;
const RELEASE_CONDITION_NAMES = ["Anytime", "LiveOnly", "EmergencyOnly", "PostDeathOnly"] as const;
const ACCESS_LEVEL_NUMBERS: Record<string, number> = { Read: 0, ReadWrite: 1, Admin: 2 };

const isSigningRejection = (error: unknown): boolean => {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return /(declined|rejected|cancel|denied|refused)/.test(message);
  }
  return false;
};

const normalizeSigningError = (error: unknown): Error => {
  if (isSigningRejection(error)) {
    return new Error("Transaction signing was rejected in Freighter");
  }
  return error instanceof Error ? error : new Error(String(error));
};

const isAccountNotFound = (error: unknown): boolean => {
  if (error instanceof Error && error.name === "NotFoundError") return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const status = (error as any)?.status;
  return status === 404 || status === 500;
};

const pollForCompletion = async (
  server: rpc.Server,
  hash: string,
  timeoutMs: number,
  pollMs: number
): Promise<rpc.Api.GetSuccessfulTransactionResponse> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await server.getTransaction(hash);
    const status = String(response.status);
    if (status === "SUCCESS") {
      return response as rpc.Api.GetSuccessfulTransactionResponse;
    }
    if (status === "FAILED") {
      throw new Error("Soroban transaction failed on-chain");
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the Soroban transaction to complete");
    }
    await sleep(pollMs);
  }
};

interface SorobanInvokeOptions {
  readonly?: boolean;
  timeoutMs?: number;
}

/**
 * Executes a Soroban contract function on testnet.
 *  - Read-only calls are simulated against the RPC and resolved without
 *    signing or submission.
 *  - Mutating calls are simulated (footprint + auth), assembled, signed by
 *    Freighter, submitted via sendTransaction and polled via getTransaction.
 * Returns the decoded return value of the invocation (or null for void).
 */
export const invokeSorobanContract = async (
  functionName: string,
  args: xdr.ScVal[],
  options?: SorobanInvokeOptions
): Promise<unknown> => {
  if (!activeAccount) throw new Error("Wallet not connected");
  if (!isConfigured()) throw new Error("Stellar contract is not configured");

  const contractId = getContractId();
  const passphrase = await getNetworkPassphrase();
  const server = getSorobanServer();

  let source;
  try {
    source = await server.getAccount(activeAccount);
  } catch (error) {
    if (isAccountNotFound(error)) {
      throw new Error(
        `Soroban RPC could not load account ${activeAccount}. Fund your testnet account with free XLM first.`
      );
    }
    throw error;
  }

  const contract = new Contract(contractId);
  const operation = contract.call(functionName, ...args);

  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  const simulation = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Soroban simulation failed: ${simulation.error}`);
  }
  if ("restorePreamble" in simulation && simulation.restorePreamble) {
    throw new Error("Contract data has expired; restore footprint required before invoking");
  }

  const retval = simulation.result?.retval;

  // Read-only invocations are simulated only – no signing or submission.
  if (options?.readonly) {
    return retval ? scValToNative(retval) : null;
  }

  const assembled = rpc.assembleTransaction(transaction, simulation).build();

  const freighter = await loadFreighter();
  if (typeof freighter.signTransaction !== "function") {
    throw new Error("Freighter wallet does not support signTransaction");
  }
  let signedXdr: string;
  try {
    signedXdr = await freighter.signTransaction(assembled.toXDR(), { networkPassphrase: passphrase });
  } catch (error) {
    throw normalizeSigningError(error);
  }

  const signedTransaction = new Transaction(signedXdr, passphrase);
  const submission = await server.sendTransaction(signedTransaction);
  if (submission.status === "ERROR") {
    throw new Error("Soroban transaction submission failed");
  }

  const completion = await pollForCompletion(
    server,
    submission.hash,
    options?.timeoutMs ?? 90000,
    2000
  );

  const returnValue = completion.returnValue ?? retval;
  return returnValue ? scValToNative(returnValue) : null;
};

// ---------------------------------------------------------------------------
// Local index of on-chain vault/document IDs so the UI can re-read live state
// (the Soroban contract exposes no list/enumeration functions).
// ---------------------------------------------------------------------------
const getLiveVaultIndex = (): Record<string, number[]> =>
  getMockStorage<Record<string, number[]>>("live_vault_index", {});
const saveLiveVaultIndex = (index: Record<string, number[]>) => {
  saveMockStorage("live_vault_index", index);
};
const addLiveVaultId = (account: string, vaultId: number) => {
  const index = getLiveVaultIndex();
  const key = account.toLowerCase();
  const ids = index[key] ?? [];
  if (!ids.includes(vaultId)) {
    index[key] = [...ids, vaultId];
    saveLiveVaultIndex(index);
  }
};

const getLiveDocIndex = (): Record<string, number[]> =>
  getMockStorage<Record<string, number[]>>("live_doc_index", {});
const saveLiveDocIndex = (index: Record<string, number[]>) => {
  saveMockStorage("live_doc_index", index);
};
const addLiveDocId = (vaultId: number, documentId: number) => {
  const index = getLiveDocIndex();
  const key = String(vaultId);
  const ids = index[key] ?? [];
  if (!ids.includes(documentId)) {
    index[key] = [...ids, documentId];
    saveLiveDocIndex(index);
  }
};

// ---------------------------------------------------------------------------
// Decoders for on-chain structs returned as raw scVals
// ---------------------------------------------------------------------------
const parseVaultScVal = (raw: unknown): StellarVaultData | null => {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  const [id, creator, name, description, guardians, approvalThreshold, isActive, createdAt] =
    raw as unknown[];
  if (id == null) return null;
  return {
    id: Number(id),
    creator: String(creator ?? ""),
    name: String(name ?? ""),
    description: String(description ?? ""),
    guardians: Array.isArray(guardians) ? guardians.map(String) : [],
    approvalThreshold: Number(approvalThreshold ?? 0),
    isActive: Boolean(isActive),
    createdAt: Number(createdAt ?? 0),
  };
};

const parseDocumentScVal = (raw: unknown): StellarDocumentData | null => {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  const [id, vaultId, encryptedMetadata, ipfsHash, uploadedBy, uploadedAt, requiredAccess] =
    raw as unknown[];
  if (id == null) return null;
  return {
    id: Number(id),
    vaultId: Number(vaultId ?? 0),
    encryptedMetadata: String(encryptedMetadata ?? ""),
    ipfsHash: String(ipfsHash ?? ""),
    uploadedBy: String(uploadedBy ?? ""),
    uploadedAt: Number(uploadedAt ?? 0),
    requiredAccess: ACCESS_LEVEL_NUMBERS[String(requiredAccess)] ?? 0,
  };
};

const parseInviteScVal = (raw: unknown): MockInvite | null => {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  const [guardian, vaultId, accepted, expiresAt] = raw as unknown[];
  if (vaultId == null) return null;
  return {
    guardian: String(guardian ?? ""),
    vaultId: Number(vaultId),
    accepted: Boolean(accepted),
    expiresAt: Number(expiresAt ?? 0),
  };
};

const initialize = async (customContractId?: string): Promise<string | null> => {
  if (customContractId) {
    contractId = customContractId;
  } else {
    contractId = (import.meta.env.VITE_STELLAR_CONTRACT_ADDRESS as string | undefined) || "";
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

const getInjectedListen = (): ((callback: (event: StellarWalletChangeEvent) => void) => unknown) | null => {
  if (typeof window === "undefined") return null;
  const injected = window.freighterApi || window.freighter;
  if (injected && typeof injected.listen === "function") {
    return injected.listen;
  }
  return null;
};

const loadListen = async (): Promise<((callback: (event: StellarWalletChangeEvent) => void) => unknown) | null> => {
  const freighter = await loadFreighter();
  if (typeof freighter.listen === "function") {
    return freighter.listen;
  }
  return getInjectedListen();
};

const startPollingWatcher = (listener: StellarWalletChangeListener): (() => void) => {
  if (typeof window === "undefined" || typeof window.setInterval !== "function") {
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

const getMockStorage = <T,>(key: string, defaults: T): T => {
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

const saveMockStorage = <T,>(key: string, data: T) => {
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

/* c8 ignore start -- legacy helpers superseded by invokeSorobanContract */
const executeSorobanQuery = async (
  functionName: string,
  args: any[]
): Promise<any> => {
  const sdk = await loadStellarSdk();
  const server = new sdk.rpc.Server(sorobanRpcUrl);
  const contractAddress = getContractId();
  
  const sourceAddress = activeAccount || "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const sourceAccount = new sdk.Account(sourceAddress, "0");
  
  const scArgs = args.map(arg => {
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
  
  if (simulation.results && simulation.results.length > 0) {
    const result = simulation.results[0];
    if (result.retval) {
      return sdk.scValToNative(result.retval);
    }
  }
  return null;
};

const executeSorobanCall = async (
  functionName: string,
  args: any[]
): Promise<any> => {
  if (!activeAccount) throw new Error("Wallet not connected");
  
  const sdk = await loadStellarSdk();
  const server = new sdk.rpc.Server(sorobanRpcUrl);
  const contractAddress = getContractId();
  
  // 1. Fetch source account
  const sourceAccount = await server.getAccount(activeAccount);
  
  // 2. Convert arguments
  const scArgs = args.map(arg => {
    if (typeof arg === "string" && arg.startsWith("G") && arg.length === 56) {
      return sdk.nativeToScVal(new sdk.Address(arg));
    }
    if (Array.isArray(arg)) {
      return sdk.nativeToScVal(arg.map(item => {
        if (typeof item === "string" && item.startsWith("G") && item.length === 56) {
          return new sdk.Address(item);
        }
        return item;
      }));
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
          throw new Error(`Freighter auth entry signing failed: ${signResponse.error}`);
        }
        
        if (signResponse.signedAuthEntry) {
          const signedEntryXdr = signResponse.signedAuthEntry;
          const parsedEntry = sdk.xdr.SorobanAuthorizationEntry.fromXDR(signedEntryXdr, "base64");
          result.auth[i] = parsedEntry;
        }
      }
    }
  }
  
  // 6. Assemble the transaction with simulated data
  const preparedTx = sdk.rpc.assembleTransaction(tx, simulation).build();
  
  // 7. Request Freighter user signature for transaction envelope
  const freighter = await loadFreighter();
  if (typeof freighter.signTransaction !== "function") {
    throw new Error("Freighter wallet does not support signTransaction");
  }
  const signedXdr = await freighter.signTransaction(preparedTx.toXDR(), {
    network: "TESTNET"
  });

  
  if (!signedXdr) {
    throw new Error("Transaction signing rejected or failed");
  }
  
  // 8. Submit the transaction
  const signedTx = sdk.TransactionBuilder.fromXDR(signedXdr, sdk.Networks.TESTNET);
  const response = await server.sendTransaction(signedTx);
  if (response.status === "ERROR") {
    throw new Error(`Transaction submission failed: ${JSON.stringify(response.errorResult)}`);
  }
  
  // 9. Poll for status
  let pollAttempts = 0;
  while (pollAttempts < 30) {
    const txStatus = await server.getTransaction(response.hash);
    if (txStatus.status === "SUCCESS") {
      if (simulation.results && simulation.results.length > 0 && simulation.results[0].retval) {
        return sdk.scValToNative(simulation.results[0].retval);
      }
      return null;
    } else if (txStatus.status === "FAILED") {
      throw new Error(`Transaction execution failed: ${JSON.stringify(txStatus.resultXdr)}`);
    }
    const delayMs = typeof process !== "undefined" && process.env.NODE_ENV === "test" ? 1 : 1000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    pollAttempts++;
  }
  
  throw new Error("Transaction polling timed out");
};

void executeSorobanQuery;
void executeSorobanCall;

/* c8 ignore stop */
const createVault = async (
  name: string,
  description: string,
  guardians: string[],
  approvalThreshold: number
): Promise<number> => {
  if (!activeAccount) throw new Error("Wallet not connected");

  // If contract is set up, submit a genuine Soroban transaction
  if (isConfigured()) {
    const result = await invokeSorobanContract("create_vault", [
      addressScVal(activeAccount),
      textScVal(name),
      textScVal(description),
      addressVecScVal(guardians),
      u32ScVal(approvalThreshold),
    ]);
    const vaultId = Number(result ?? 0);
    if (vaultId > 0) {
      addLiveVaultId(activeAccount, vaultId);
    }
    return vaultId;
  }

  // Fallback to Mock Database for instantaneous UI execution and debugging
  const vaults = getMockStorage<MockVault[]>("vaults", []);
  const nextId = vaults.length + 1;
  const newVault: MockVault = {
    id: nextId,
    creator: activeAccount,
    name,
    description,
    guardians: [activeAccount],
    approvalThreshold,
    isActive: true,
    createdAt: Math.floor(Date.now() / 1000),
  };

  vaults.push(newVault);
  saveMockStorage("vaults", vaults);

  // Add invites
  const invites = getMockStorage<MockInvite[]>("invites", []);
  for (const guardian of guardians) {
    if (guardian.toLowerCase() === activeAccount.toLowerCase()) continue;
    invites.push({
      guardian: guardian.trim(),
      vaultId: nextId,
      accepted: false,
      expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    });
  }
  saveMockStorage("invites", invites);

  return nextId;
};

const getVault = async (vaultId: number): Promise<StellarVaultData | null> => {
  if (isConfigured()) {
    try {
      const raw = await invokeSorobanContract("get_vault", [u64ScVal(vaultId)], {
        readonly: true,
      });
      return parseVaultScVal(raw);
    } catch (error) {
      console.error("Live Soroban get_vault failed, falling back to mock:", error);
    }
  }
  const vaults = getMockStorage<MockVault[]>("vaults", []);
  const vault = vaults.find((v) => v.id === vaultId);
  return vault || null;
};

const fetchLiveVaultsForAccount = async (account: string): Promise<StellarVaultData[]> => {
  const target = account.toLowerCase();
  const ids = new Set<number>();

  const index = getLiveVaultIndex();
  for (const id of index[target] ?? []) ids.add(id);

  try {
    const invitesRaw = await invokeSorobanContract(
      "get_invites",
      [addressScVal(account)],
      { readonly: true }
    );
    if (Array.isArray(invitesRaw)) {
      for (const inviteRaw of invitesRaw) {
        const invite = parseInviteScVal(inviteRaw);
        if (invite) ids.add(invite.vaultId);
      }
    }
  } catch (error) {
    console.error("Failed to read guardian invites from Soroban:", error);
  }

  const vaults: StellarVaultData[] = [];
  for (const id of ids) {
    try {
      const vault = await getVault(id);
      if (vault) vaults.push({ ...vault, network: "stellar" });
    } catch {
      // Skip vaults that could not be read
    }
  }
  return vaults;
};

const fetchVaultsForAccount = async (account: string): Promise<StellarVaultData[]> => {
  if (isConfigured()) {
    try {
      return await fetchLiveVaultsForAccount(account);
    } catch (error) {
      console.error("Live Soroban vault listing failed, falling back to mock:", error);
    }
  }

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

  // If contract is set up, submit a genuine Soroban transaction
  if (isConfigured()) {
    const result = await invokeSorobanContract("add_document", [
      addressScVal(activeAccount),
      u64ScVal(vaultId),
      textScVal(encryptedMetadata),
      textScVal(ipfsHash),
      symbolScVal(ACCESS_LEVEL_NAMES[requiredAccess] ?? "Read"),
      symbolScVal(RELEASE_CONDITION_NAMES[releaseCondition] ?? "Anytime"),
      addressVecScVal(guardiansList),
      textVecScVal(shares),
    ]);
    const documentId = Number(result ?? 0);
    if (documentId > 0) {
      addLiveDocId(vaultId, documentId);
    }
    return documentId;
  }

  const docs = getMockStorage<MockDocument[]>("documents", []);
  const nextId = docs.length + 1;

  const sharesMap: Record<string, string> = {};
  guardiansList.forEach((guardian, idx) => {
    sharesMap[guardian] = shares[idx];
  });

  const newDoc: MockDocument = {
    id: nextId,
    vaultId,
    encryptedMetadata,
    ipfsHash,
    uploadedBy: activeAccount,
    uploadedAt: Math.floor(Date.now() / 1000),
    requiredAccess,
    releaseCondition,
    shares: sharesMap,
  };

  docs.push(newDoc);
  saveMockStorage("documents", docs);
  return nextId;
};

const fetchLiveDocumentsForVaults = async (vaultIds: number[]): Promise<StellarDocumentData[]> => {
  const docs: StellarDocumentData[] = [];
  const index = getLiveDocIndex();

  for (const vaultId of vaultIds) {
    const documentIds = index[String(vaultId)] ?? [];
    for (const documentId of documentIds) {
      try {
        const raw = await invokeSorobanContract("get_document", [u64ScVal(documentId)], {
          readonly: true,
        });
        const doc = parseDocumentScVal(raw);
        if (doc && doc.vaultId === vaultId) docs.push(doc);
      } catch (error) {
        console.error(`Failed to read document #${documentId} from Soroban:`, error);
      }
    }
  }
  return docs;
};

const fetchDocumentsForVaults = async (vaultIds: number[]): Promise<StellarDocumentData[]> => {
  if (isConfigured() && vaultIds.length > 0) {
    try {
      return await fetchLiveDocumentsForVaults(vaultIds);
    } catch (error) {
      console.error("Live Soroban document listing failed, falling back to mock:", error);
    }
  }

  const docs = getMockStorage<MockDocument[]>("documents", []);
  const set = new Set(vaultIds);
  return docs.filter((d) => set.has(d.vaultId));
};

const requestAccess = async (documentId: number): Promise<number> => {
  if (!activeAccount) throw new Error("Wallet not connected");

  if (isConfigured()) {
    const result = await invokeSorobanContract("request_access", [
      addressScVal(activeAccount),
      u64ScVal(documentId),
    ]);
    return Number(result ?? 0);
  }

  const requests = getMockStorage<MockRequest[]>("requests", []);
  const nextId = requests.length + 1;

  const newReq: MockRequest = {
    requestId: nextId,
    documentId,
    requester: activeAccount,
    approvedBy: [],
    status: 0, // Pending
    expiresAt: Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60,
    createdAt: Math.floor(Date.now() / 1000),
    beneficiaryShares: {},
  };

  requests.push(newReq);
  saveMockStorage("requests", requests);
  return nextId;
};

const approveAccess = async (requestId: number, encryptedShareForBeneficiary?: string): Promise<void> => {
  if (!activeAccount) throw new Error("Wallet not connected");

  if (isConfigured()) {
    await invokeSorobanContract("approve_access", [
      addressScVal(activeAccount),
      u64ScVal(requestId),
      optionTextScVal(encryptedShareForBeneficiary),
    ]);
    return;
  }

  const requests = getMockStorage<MockRequest[]>("requests", []);
  const reqIdx = requests.findIndex((r) => r.requestId === requestId);
  if (reqIdx === -1) throw new Error("Request not found");

  const req = requests[reqIdx];
  if (req.approvedBy.includes(activeAccount)) {
    throw new Error("Already approved");
  }

  req.approvedBy.push(activeAccount);
  if (encryptedShareForBeneficiary) {
    req.beneficiaryShares[activeAccount] = encryptedShareForBeneficiary;
  }

  // Fetch vault approval threshold
  const docs = getMockStorage<MockDocument[]>("documents", []);
  const doc = docs.find((d) => d.id === req.documentId);
  if (doc) {
    const vaults = getMockStorage<MockVault[]>("vaults", []);
    const vault = vaults.find((v) => v.id === doc.vaultId);
    if (vault && req.approvedBy.length >= vault.approvalThreshold) {
      req.status = 1; // Approved
    }
  }

  requests[reqIdx] = req;
  saveMockStorage("requests", requests);
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

const getEncryptedGuardianShare = async (documentId: number, guardian: string): Promise<string> => {
  const docs = getMockStorage<MockDocument[]>("documents", []);
  const doc = docs.find((d) => d.id === documentId);
  return doc?.shares?.[guardian] || "";
};

const getBeneficiaryKeyShare = async (requestId: number, guardian: string): Promise<string> => {
  const requests = getMockStorage<MockRequest[]>("requests", []);
  const req = requests.find((r) => r.requestId === requestId);
  return req?.beneficiaryShares?.[guardian] || "";
};

const getPendingInvites = async (account: string): Promise<MockInvite[]> => {
  if (isConfigured()) {
    try {
      const raw = await invokeSorobanContract("get_invites", [addressScVal(account)], {
        readonly: true,
      });
      if (Array.isArray(raw)) {
        return raw
          .map(parseInviteScVal)
          .filter((invite): invite is MockInvite => invite !== null && !invite.accepted);
      }
    } catch (error) {
      console.error("Live Soroban get_invites failed, falling back to mock:", error);
    }
  }

  const invites = getMockStorage<MockInvite[]>("invites", []);
  const target = account.toLowerCase();
  return invites.filter((inv) => inv.guardian.toLowerCase() === target && !inv.accepted);
};

const acceptGuardianInvite = async (vaultId: number): Promise<void> => {
  if (!activeAccount) throw new Error("Wallet not connected");

  if (isConfigured()) {
    await invokeSorobanContract("accept_guardian_invite", [
      addressScVal(activeAccount),
      u64ScVal(vaultId),
    ]);
    return;
  }

  const invites = getMockStorage<MockInvite[]>("invites", []);
  const invIdx = invites.findIndex(
    (inv) => inv.vaultId === vaultId && inv.guardian.toLowerCase() === activeAccount!.toLowerCase()
  );

  if (invIdx !== -1) {
    invites[invIdx].accepted = true;
    saveMockStorage("invites", invites);
  }

  const vaults = getMockStorage<MockVault[]>("vaults", []);
  const vaultIdx = vaults.findIndex((v) => v.id === vaultId);
  if (vaultIdx !== -1) {
    if (!vaults[vaultIdx].guardians.includes(activeAccount)) {
      vaults[vaultIdx].guardians.push(activeAccount);
      saveMockStorage("vaults", vaults);
    }
  }
};

const registerPublicKey = async (publicKey: string): Promise<void> => {
  if (!activeAccount) throw new Error("Wallet not connected");

  if (isConfigured()) {
    await invokeSorobanContract("register_public_key", [
      addressScVal(activeAccount),
      textScVal(publicKey),
    ]);
    return;
  }

  const pubKeys = getMockStorage<Record<string, string>>("public_keys", {});
  pubKeys[activeAccount] = publicKey;
  saveMockStorage("public_keys", pubKeys);
};

const getUserPublicKey = async (user: string): Promise<string> => {
  if (isConfigured()) {
    try {
      const raw = await invokeSorobanContract("get_public_key", [addressScVal(user)], {
        readonly: true,
      });
      return typeof raw === "string" ? raw : "";
    } catch (error) {
      console.error("Live Soroban get_public_key failed, falling back to mock:", error);
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

const fetchUserTokens = async (account: string): Promise<StellarTokenData[]> => {
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

const hasVaultToken = async (account: string, vaultId: number): Promise<boolean> => {
  if (!account || !vaultId || vaultId <= 0) return false;
  try {
    const tokens = getMockStorage<MockToken[]>("tokens", []);
    const target = account.toLowerCase();
    const hasMockToken = tokens.some(
      (t) => t.vaultId === vaultId && t.owner.toLowerCase() === target
    );
    if (hasMockToken) return true;

    if (isConfigured()) {
      const hasToken = await invokeSorobanContract(
        "has_vault_token",
        [addressScVal(account), u64ScVal(vaultId)],
        { readonly: true }
      );
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
      const tokenId = await invokeSorobanContract("mint_access_token", [
        u64ScVal(vaultId),
        addressScVal(to),
        textScVal(tokenURI),
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

const registerCrossChainIdentity = async (
  stellarAddress: string,
  evmAddress: string,
  publicKey?: string
): Promise<void> => {
  const normEvm = evmAddress.toLowerCase().trim();
  const normStellar = stellarAddress.trim();

  const evmToStellar = getMockStorage<Record<string, string>>("cross_evm_to_stellar", {});
  const stellarToEvm = getMockStorage<Record<string, string>>("cross_stellar_to_evm", {});
  const evmToPubkey = getMockStorage<Record<string, string>>("cross_evm_to_pubkey", {});

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

const resolveEvmToStellar = async (evmAddress: string): Promise<string | null> => {
  const normEvm = evmAddress.toLowerCase().trim();
  const evmToStellar = getMockStorage<Record<string, string>>("cross_evm_to_stellar", {});
  return evmToStellar[normEvm] || null;
};

const resolveStellarToEvm = async (stellarAddress: string): Promise<string | null> => {
  const normStellar = stellarAddress.trim();
  const stellarToEvm = getMockStorage<Record<string, string>>("cross_stellar_to_evm", {});
  return stellarToEvm[normStellar] || null;
};

const resolveEvmToPublicKey = async (evmAddress: string): Promise<string | null> => {
  const normEvm = evmAddress.toLowerCase().trim();
  const evmToPubkey = getMockStorage<Record<string, string>>("cross_evm_to_pubkey", {});
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


export const stellarService = {
  initialize,
  clear,
  getAccount,
  connectWallet,
  getActiveNetwork,
  getNetwork,
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
  isConfigured,
  getRpcUrl,
  getContractId: getContractIdForWatcher,
  setMockStellarSdk,
  setMockFreighter,
};

declare global {
  interface Window {
    freighterApi?: {
      listen?: (callback: (event: StellarWalletChangeEvent) => void, opts?: { network?: string }) => unknown;
    };
    freighter?: {
      listen?: (callback: (event: StellarWalletChangeEvent) => void, opts?: { network?: string }) => unknown;
    };
  }
}
