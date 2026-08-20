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

// ---------------------------------------------------------------------------
// Lightweight freighter shim – replaced by real API when package is present
// ---------------------------------------------------------------------------
interface SignTransactionOptions {
  networkPassphrase?: string;
  accountToSign?: string;
}

type FreighterShim = {
  isConnected: () => Promise<boolean>;
  getAddress: () => Promise<string>;
  signTransaction: (transactionXdr: string, opts?: SignTransactionOptions) => Promise<string>;
  getNetwork?: () => Promise<string>;
  getNetworkDetails?: () => Promise<{ networkPassphrase?: string }>;
};

let _freighter: FreighterShim | null = null;
let _freighterModuleOverride: unknown = undefined;

// Test seam: lets Vitest inject a fake @stellar/freighter-api module (or a
// rejected promise) without a browser extension being installed. Undefined in
// production, so the normal lazy import is used. Resets the cached shim so a
// subsequent loadFreighter() rebuilds it from the injected module.
export const __setFreighterModuleForTesting = (moduleOrRejection: unknown): void => {
  _freighterModuleOverride = moduleOrRejection;
  _freighter = null;
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

    const resolveAddress = async (): Promise<string> => {
      if (typeof api.getAddress === "function") return (await api.getAddress()) || "";
      if (typeof api.getPublicKey === "function") return (await api.getPublicKey()) || "";
      if (typeof api.getUserInfo === "function") {
        const info = await api.getUserInfo();
        return info?.publicKey || "";
      }
      return "";
    };

    _freighter = {
      isConnected: api.isConnected,
      getAddress: resolveAddress,
      signTransaction: api.signTransaction,
      getNetwork: api.getNetwork,
      getNetworkDetails: api.getNetworkDetails,
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
    };
  }
  return _freighter;
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

// Fallback Mock Storage for local development when Freighter/Soroban is not deployed
const getMockStorage = <T,>(key: string, defaults: T): T => {
  try {
    const raw = localStorage.getItem(`spoovault-stellar-mock-${key}`);
    return raw ? (JSON.parse(raw) as T) : defaults;
  } catch {
    return defaults;
  }
};

const saveMockStorage = <T,>(key: string, data: T) => {
  try {
    localStorage.setItem(`spoovault-stellar-mock-${key}`, JSON.stringify(data));
  } catch {
    // ignore storage issues
  }
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

export const stellarService = {
  initialize,
  clear,
  getAccount,
  connectWallet,
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
  isConfigured,
};
