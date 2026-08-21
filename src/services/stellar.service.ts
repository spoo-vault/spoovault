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
export type FreighterShim = {
  isConnected: () => Promise<boolean>;
  getAddress: () => Promise<string>;
  signTransaction?: (xdr: string, opts?: any) => Promise<string>;
  signAuthEntry?: (preimageXdr: string, opts?: any) => Promise<{ signedAuthEntry: string; error?: string }>;
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
    const mod = await import("@stellar/freighter-api") as any;
    _freighter = {
      isConnected: async () => {
        try {
          const result = await mod.isConnected();
          return typeof result === "boolean" ? result : Boolean(result?.isConnected);
        } catch {
          return false;
        }
      },
      getAddress: async () => {
        try {
          if (typeof mod.getAddress === "function") {
            return normalizeAddressValue(await mod.getAddress());
          }
          if (typeof mod.getPublicKey === "function") {
            return normalizeAddressValue(await mod.getPublicKey());
          }
          if (typeof mod.getUserInfo === "function") {
            const info = await mod.getUserInfo();
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
      signTransaction: mod.signTransaction,
      signAuthEntry: mod.signAuthEntry,
      getNetwork: typeof mod?.getNetwork === "function" ? mod.getNetwork : undefined,
      listen: typeof mod?.listen === "function" ? mod.listen : undefined,
    };
  } catch {

    // Package not installed – graceful fallback stubs
    _freighter = {
      isConnected: async () => false,
      getAddress: async () => "",
      signTransaction: async () => "",
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

export interface StellarKeeperAuthorizationData {
  keeper: string;
  expiresAt: number;
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

const isConfigured = (): boolean => {
  return !!getContractId();
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

const createVault = async (
  name: string,
  description: string,
  guardians: string[],
  approvalThreshold: number
): Promise<number> => {
  if (!activeAccount) throw new Error("Wallet not connected");

  // If contract is set up, perform genuine Soroban call
  if (isConfigured()) {
    try {
      const vaultId = await executeSorobanCall("create_vault", [
        activeAccount,
        name,
        description,
        guardians,
        approvalThreshold,
      ]);
      return Number(vaultId);
    } catch (err) {
      console.error("Soroban create_vault failed:", err);
      throw err;
    }
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
  const vaults = getMockStorage<MockVault[]>("vaults", []);
  const vault = vaults.find((v) => v.id === vaultId);
  return vault || null;
};

const fetchVaultsForAccount = async (account: string): Promise<StellarVaultData[]> => {
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

  if (isConfigured()) {
    try {
      const docId = await executeSorobanCall("add_document", [
        activeAccount,
        vaultId,
        encryptedMetadata,
        ipfsHash,
        requiredAccess,
        releaseCondition,
        guardiansList,
        shares
      ]);
      return Number(docId);
    } catch (err) {
      console.error("Soroban add_document failed:", err);
      throw err;
    }
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

const fetchDocumentsForVaults = async (vaultIds: number[]): Promise<StellarDocumentData[]> => {
  const docs = getMockStorage<MockDocument[]>("documents", []);
  const set = new Set(vaultIds);
  return docs.filter((d) => set.has(d.vaultId));
};

const requestAccess = async (documentId: number): Promise<number> => {
  if (!activeAccount) throw new Error("Wallet not connected");

  if (isConfigured()) {
    try {
      const requestId = await executeSorobanCall("request_access", [
        activeAccount,
        documentId
      ]);
      return Number(requestId);
    } catch (err) {
      console.error("Soroban request_access failed:", err);
      throw err;
    }
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
    try {
      await executeSorobanCall("approve_access", [
        activeAccount,
        requestId,
        encryptedShareForBeneficiary || null
      ]);
      return;
    } catch (err) {
      console.error("Soroban approve_access failed:", err);
      throw err;
    }
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
  const invites = getMockStorage<MockInvite[]>("invites", []);
  const target = account.toLowerCase();
  return invites.filter((inv) => inv.guardian.toLowerCase() === target && !inv.accepted);
};

const acceptGuardianInvite = async (vaultId: number): Promise<void> => {
  if (!activeAccount) throw new Error("Wallet not connected");

  if (isConfigured()) {
    try {
      await executeSorobanCall("accept_guardian_invite", [
        activeAccount,
        vaultId
      ]);
      return;
    } catch (err) {
      console.error("Soroban accept_guardian_invite failed:", err);
      throw err;
    }
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
    try {
      await executeSorobanCall("register_public_key", [
        activeAccount,
        publicKey
      ]);
      return;
    } catch (err) {
      console.error("Soroban register_public_key failed:", err);
      throw err;
    }
  }

  const pubKeys = getMockStorage<Record<string, string>>("public_keys", {});
  pubKeys[activeAccount] = publicKey;
  saveMockStorage("public_keys", pubKeys);
};

const getUserPublicKey = async (user: string): Promise<string> => {
  if (isConfigured()) {
    try {
      const pubKey = await executeSorobanQuery("get_public_key", [
        user
      ]);
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
      const hasToken = await executeSorobanQuery("has_vault_token", [
        account,
        vaultId
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
        tokenURI
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

interface MockKeeperAuthorization {
  keeper: string;
  expiresAt: number;
}

/**
 * Authorize a Web3 Keeper (Chainlink Automation / Gelato) to relay proof-of-life
 * heartbeats for `vaultId` until `expiresAt`. Soroban's native `require_auth`
 * already separates who authorizes an action from who submits/pays for the
 * transaction, so — unlike the EVM side — this needs no off-chain signature
 * scheme of its own: it's a normal owner-signed contract call.
 */
const authorizeKeeper = async (
  vaultId: number,
  keeper: string,
  expiresAt: number
): Promise<void> => {
  if (!activeAccount) throw new Error("Wallet not connected");

  if (isConfigured()) {
    try {
      await executeSorobanCall("authorize_keeper", [activeAccount, vaultId, keeper, expiresAt]);
      return;
    } catch (err) {
      console.error("Soroban authorize_keeper failed:", err);
      throw err;
    }
  }

  const authorizations = getMockStorage<Record<number, MockKeeperAuthorization>>(
    "keeper_authorizations",
    {}
  );
  authorizations[vaultId] = { keeper, expiresAt };
  saveMockStorage("keeper_authorizations", authorizations);
};

const revokeKeeperAuthorization = async (vaultId: number): Promise<void> => {
  if (!activeAccount) throw new Error("Wallet not connected");

  if (isConfigured()) {
    try {
      await executeSorobanCall("revoke_keeper", [activeAccount, vaultId]);
      return;
    } catch (err) {
      console.error("Soroban revoke_keeper failed:", err);
      throw err;
    }
  }

  const authorizations = getMockStorage<Record<number, MockKeeperAuthorization>>(
    "keeper_authorizations",
    {}
  );
  delete authorizations[vaultId];
  saveMockStorage("keeper_authorizations", authorizations);
};

const getKeeperAuthorization = async (
  vaultId: number
): Promise<StellarKeeperAuthorizationData | null> => {
  if (isConfigured()) {
    try {
      const result = await executeSorobanQuery("get_keeper_authorization", [vaultId]);
      if (!result) return null;
      return {
        keeper: String(result.keeper ?? result[0]),
        expiresAt: Number(result.expires_at ?? result[1]),
      };
    } catch (err) {
      console.error("Soroban get_keeper_authorization failed:", err);
      return null;
    }
  }

  const authorizations = getMockStorage<Record<number, MockKeeperAuthorization>>(
    "keeper_authorizations",
    {}
  );
  return authorizations[vaultId] || null;
};

/**
 * Web3 Keeper relay of a proof-of-life heartbeat, submitted using the keeper's
 * own connected account as both the transaction source and the `require_auth`
 * signer — gated by a prior {authorizeKeeper} grant on-chain.
 */
const relayProofOfLifeAsKeeper = async (vaultId: number): Promise<void> => {
  if (!activeAccount) throw new Error("Wallet not connected");

  if (!isConfigured()) {
    throw new Error("Proof-of-life relay requires a configured Soroban contract.");
  }

  try {
    await executeSorobanCall("prove_life_by_keeper", [activeAccount, vaultId]);
  } catch (err) {
    console.error("Soroban prove_life_by_keeper failed:", err);
    throw err;
  }
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
  authorizeKeeper,
  revokeKeeperAuthorization,
  getKeeperAuthorization,
  relayProofOfLifeAsKeeper,
  isConfigured,
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
