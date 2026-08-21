import { ethers } from "ethers";
import { stellarService } from "./stellar.service";
import { TtlCache } from "../utils/ttlCache";

export interface VaultData {
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

export interface DocumentData {
  id: number;
  vaultId: number;
  encryptedMetadata: string;
  ipfsHash: string;
  uploadedBy: string;
  uploadedAt: number;
  requiredAccess: number;
}

export interface TokenData {
  tokenId: number;
  owner: string;
  vaultId: number | null;
  tokenURI: string;
  mintedAt: number | null;
}

export interface ActivityEvent {
  action: string;
  actor: string;
  timestamp: number;
  status: "success" | "pending";
  txHash?: string;
  network?: "avalanche" | "stellar";
}

export interface AccessRequestData {
  requestId: number;
  documentId: number;
  requester: string;
  status: number;
  expiresAt: number;
  createdAt: number;
}

export interface PendingApprovalData {
  requestId: number;
  documentId: number;
  vaultId: number;
  vaultName: string;
  requester: string;
  createdAt: number;
  expiresAt: number;
}

export interface GuardianInviteData {
  guardian: string;
  vaultId: number;
  accepted: boolean;
  expiresAt: number;
}

export interface VaultReleaseState {
  emergencyMode: boolean;
  inactivityPeriod: number;
  lastProofOfLife: number;
  postDeathUnlocked: boolean;
}

const CONTRACT_ABI = [
  "function createVault(string name, string description, address[] guardians, uint256 approvalThreshold) external returns (uint256)",
  "function addDocument(uint256 vaultId, string encryptedMetadata, string ipfsHash, uint8 requiredAccess) external returns (uint256)",
  "function addDocument(uint256 vaultId, string encryptedMetadata, string ipfsHash, uint8 requiredAccess, address[] guardiansList, string[] shares) external returns (uint256)",
  "function addDocumentWithReleaseCondition(uint256 vaultId, string encryptedMetadata, string ipfsHash, uint8 requiredAccess, uint8 releaseCondition) external returns (uint256)",
  "function addDocumentWithReleaseCondition(uint256 vaultId, string encryptedMetadata, string ipfsHash, uint8 requiredAccess, uint8 releaseCondition, address[] guardiansList, string[] shares) external returns (uint256)",
  "function configureVaultRelease(uint256 vaultId, uint256 inactivityPeriod) external",
  "function proveLife(uint256 vaultId) external",
  "function setEmergencyMode(uint256 vaultId, bool enabled) external",
  "function setBeneficiary(uint256 vaultId, address beneficiary) external",
  "function getBeneficiary(uint256 vaultId) external view returns (address)",
  "function getVaultReleaseState(uint256 vaultId) external view returns (bool emergencyMode, uint256 inactivityPeriod, uint256 lastProofOfLife, bool postDeathUnlocked)",
  "function documentReleaseCondition(uint256 documentId) external view returns (uint8)",
  "function requestAccess(uint256 documentId) external returns (uint256)",
  "function approveAccess(uint256 requestId) external",
  "function approveAccess(uint256 requestId, string encryptedShareForBeneficiary) external",
  "function acceptGuardianInvite(uint256 vaultId) external",
  "function accessRequests(uint256 requestId) external view returns (uint256 requestId, uint256 documentId, address requester, uint8 status, uint256 expiresAt, uint256 createdAt)",
  "function latestRequestId(uint256 documentId, address user) external view returns (uint256)",
  "function hasApprovedRequest(uint256 requestId, address approver) external view returns (bool)",
  "function getPendingInvites(address user) external view returns (tuple(address guardian, uint256 vaultId, bool accepted, uint256 expiresAt)[])",
  "function revokeAccess(uint256 documentId, address user) external",
  "function mintAccessToken(uint256 vaultId, address to, string tokenURI) external returns (uint256)",
  "function burnAccessToken(uint256 tokenId) external",
  "function getVault(uint256 vaultId) external view returns (uint256, address, string, string, address[], uint256, bool, uint256)",
  "function documents(uint256 documentId) external view returns (uint256, uint256, string, string, address, uint256, uint8)",
  "function hasActiveAccess(uint256 documentId, address user) external view returns (bool)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function tokenURI(uint256 tokenId) external view returns (string)",
  "function totalSupply() external view returns (uint256)",
  "function registerPublicKey(string publicKey) external",
  "function userPublicKeys(address user) external view returns (string)",
  "function getEncryptedGuardianShare(uint256 documentId, address guardian) external view returns (string)",
  "function getBeneficiaryKeyShare(uint256 requestId, address guardian) external view returns (string)",
  "event VaultCreated(uint256 indexed vaultId, address indexed creator, string name)",
  "event GuardianAdded(uint256 indexed vaultId, address indexed guardian)",
  "event GuardianRemoved(uint256 indexed vaultId, address indexed guardian)",
  "event DocumentAdded(uint256 indexed documentId, uint256 indexed vaultId, string ipfsHash)",
  "event AccessRequested(uint256 indexed requestId, uint256 indexed documentId, address indexed requester)",
  "event AccessApproved(uint256 indexed requestId, address indexed approver)",
  "event AccessGranted(uint256 indexed requestId, uint256 indexed documentId, address indexed requester)",
  "event NFTMinted(uint256 indexed tokenId, address indexed to, uint256 indexed vaultId)",
  "event NFTBurned(uint256 indexed tokenId)",
  "event DocumentReleaseConditionSet(uint256 indexed documentId, uint8 condition)",
  "event PublicKeyRegistered(address indexed user, string publicKey)",
  "event GuardianSharesSaved(uint256 indexed documentId)",
  "event ShareSubmittedForBeneficiary(uint256 indexed requestId, address indexed guardian, string encryptedShare)",
  "event BeneficiarySet(uint256 indexed vaultId, address indexed beneficiary)",
];

let provider: ethers.Provider | null = null;
let fallbackProviders: ethers.JsonRpcProvider[] = [];
let readContract: ethers.Contract | null = null;
let writeContract: ethers.Contract | null = null;
let verifiedAddress: string | null = null;
let hasVerifiedCode = false;

// Read-only view calls (hasActiveAccess, getVault) are idempotent within a short
// window, so cache them for a bounded TTL instead of re-hitting the RPC endpoint
// on every render/navigation. See invalidation calls in the write paths below.
const VIEW_CALL_TTL_MS = 10_000;
const hasActiveAccessCache = new TtlCache<boolean>(VIEW_CALL_TTL_MS);
const getVaultCache = new TtlCache<any>(VIEW_CALL_TTL_MS);

const clearAccessCache = (): void => hasActiveAccessCache.clear();
const invalidateVaultCache = (vaultId: number): void =>
  getVaultCache.invalidate(`getVault:${vaultId}`);

const FUJI_RPC_URLS = [
  "https://api.avax-test.network/ext/bc/C/rpc",
  "https://rpc.ankr.com/avalanche_fuji",
];

const MAINNET_RPC_URLS = [
  "https://api.avax.network/ext/bc/C/rpc",
  "https://rpc.ankr.com/avalanche",
];

const getContractAddress = (): string => {
  const address = import.meta.env.VITE_CONTRACT_ADDRESS as string | undefined;
  if (!address) {
    throw new Error("VITE_CONTRACT_ADDRESS is not set");
  }
  return address;
};

const getRpcCandidates = (): string[] => {
  const configured = (import.meta.env.VITE_AVALANCHE_RPC as string | undefined)?.trim();
  const chainId = Number(import.meta.env.VITE_CHAIN_ID);
  const defaults = chainId === 43114 ? MAINNET_RPC_URLS : FUJI_RPC_URLS;
  const all = configured ? [configured, ...defaults] : [...defaults];

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of all) {
    const normalized = url.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
};

const getConfiguredRpcProviders = (): ethers.JsonRpcProvider[] => {
  return getRpcCandidates().map((url) => new ethers.JsonRpcProvider(url));
};

const getReadProviders = (): ethers.Provider[] => {
  if (fallbackProviders.length > 0) {
    return [...fallbackProviders];
  }

  if (provider) {
    return [provider];
  }

  throw new Error("No read provider is initialized");
};

const extractProviderErrorMessage = (error: any): string => {
  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message;
  }
  if (typeof error?.shortMessage === "string" && error.shortMessage.trim()) {
    return error.shortMessage;
  }
  return "Unknown provider error";
};

const getTxWaitTimeoutMs = (): number => {
  const configured = Number(import.meta.env.VITE_TX_WAIT_TIMEOUT_MS);
  if (!Number.isNaN(configured) && configured > 0) {
    return configured;
  }
  return 180000;
};

const waitForReceipt = async (tx: any) => {
  const timeoutMs = getTxWaitTimeoutMs();

  if (tx?.hash && fallbackProviders.length > 0) {
    for (const activeProvider of fallbackProviders) {
      try {
        const mined = await activeProvider.waitForTransaction(tx.hash, 1, timeoutMs);
        if (mined) {
          return mined;
        }
      } catch {
        // Try next provider, then fallback to signer provider below.
      }
    }
  }

  const receipt = await tx.wait(1, timeoutMs);
  if (!receipt) {
    throw new Error(
      "Transaction confirmation timed out. Check your wallet, then refresh and retry."
    );
  }

  return receipt;
};

const ensureContractDeployed = async (): Promise<void> => {
  const address = getContractAddress();

  if (hasVerifiedCode && verifiedAddress === address) {
    return;
  }

  let lastError: string | null = null;
  for (const activeProvider of getReadProviders()) {
    try {
      const code = await activeProvider.getCode(address);
      if (!code || code === "0x") {
        throw new Error("Contract not found at VITE_CONTRACT_ADDRESS");
      }
      verifiedAddress = address;
      hasVerifiedCode = true;
      return;
    } catch (error) {
      lastError = extractProviderErrorMessage(error);
    }
  }
  throw new Error(lastError || "Failed to verify contract deployment");
};

const ensureReadContract = (): ethers.Contract => {
  if (!readContract) {
    throw new Error("Contract not initialized");
  }
  return readContract;
};

const ensureWriteContract = (): ethers.Contract => {
  if (!writeContract) {
    throw new Error("Write contract not initialized");
  }
  return writeContract;
};

const contractHasFunction = (contract: ethers.Contract, signature: string): boolean => {
  try {
    contract.interface.getFunction(signature);
    return true;
  } catch {
    return false;
  }
};

const getInterface = (): ethers.Interface => new ethers.Interface(CONTRACT_ABI);

const getLogChunkSize = (): number => {
  const configured = Number(import.meta.env.VITE_LOG_CHUNK_SIZE);
  if (!Number.isNaN(configured) && configured > 0) {
    return configured;
  }
  return 2000;
};

const chunkArray = <T,>(items: T[], size: number): T[][] => {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const EVENT_LOG_CACHE_PREFIX = "spoovault-event-log-cache";
const EVENT_LOG_CACHE_VERSION = 1;

type ParsedLogEntry = { log: ethers.Log; parsed: ethers.LogDescription };

interface EventLogCacheRecord {
  address: string;
  blockHash: string;
  blockNumber: number;
  data: string;
  index: number;
  removed: boolean;
  topics: string[];
  transactionHash: string;
  transactionIndex: number;
}

interface EventLogCachePayload {
  version: number;
  chainId: number;
  contractAddress: string;
  eventName: string;
  filterKey?: string;
  lastSyncedBlock: number;
  logs: EventLogCacheRecord[];
}

interface EventLogQueryOptions {
  tail?: number;
  filters?: Array<
    string | number | bigint | null | Array<string | number | bigint | null>
  >;
}

const getConfiguredChainId = (): number => {
  const configured = Number(import.meta.env.VITE_CHAIN_ID);
  if (!Number.isNaN(configured) && configured > 0) {
    return configured;
  }
  return 0;
};

const getEventLogCacheKey = (
  eventName: string,
  contractAddress: string,
  filterKey?: string
): string => {
  return [
    EVENT_LOG_CACHE_PREFIX,
    EVENT_LOG_CACHE_VERSION,
    getConfiguredChainId(),
    contractAddress.toLowerCase(),
    eventName,
    filterKey || "all",
  ].join(":");
};

const readEventLogCache = (
  eventName: string,
  contractAddress: string,
  filterKey?: string
): EventLogCachePayload | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(
      getEventLogCacheKey(eventName, contractAddress, filterKey)
    );
    if (!raw) return null;

    const parsed = JSON.parse(raw) as EventLogCachePayload;
    if (
      !parsed ||
      parsed.version !== EVENT_LOG_CACHE_VERSION ||
      parsed.chainId !== getConfiguredChainId() ||
      parsed.contractAddress.toLowerCase() !== contractAddress.toLowerCase() ||
      parsed.eventName !== eventName ||
      (filterKey && parsed.filterKey !== filterKey) ||
      !Array.isArray(parsed.logs)
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
};

const writeEventLogCache = (
  eventName: string,
  contractAddress: string,
  payload: Omit<
    EventLogCachePayload,
    "version" | "chainId" | "contractAddress" | "eventName"
  >,
  filterKey?: string
): void => {
  if (typeof window === "undefined") return;
  try {
    const value: EventLogCachePayload = {
      version: EVENT_LOG_CACHE_VERSION,
      chainId: getConfiguredChainId(),
      contractAddress: contractAddress.toLowerCase(),
      eventName,
      filterKey,
      ...payload,
    };
    window.localStorage.setItem(
      getEventLogCacheKey(eventName, contractAddress, filterKey),
      JSON.stringify(value)
    );
  } catch {
    // ignore storage write errors
  }
};

const toCacheRecord = (log: ethers.Log): EventLogCacheRecord => ({
  address: String(log.address ?? ""),
  blockHash: String(log.blockHash ?? ""),
  blockNumber: Number(log.blockNumber ?? 0),
  data: String(log.data ?? "0x"),
  index: Number((log as any).index ?? 0),
  removed: Boolean(log.removed ?? false),
  topics: Array.isArray(log.topics) ? [...log.topics] : [],
  transactionHash: String(log.transactionHash ?? ""),
  transactionIndex: Number(log.transactionIndex ?? 0),
});

const fromCacheRecord = (record: EventLogCacheRecord): ethers.Log =>
  ({
    address: record.address,
    blockHash: record.blockHash,
    blockNumber: record.blockNumber,
    data: record.data,
    index: record.index,
    removed: record.removed,
    topics: record.topics,
    transactionHash: record.transactionHash,
    transactionIndex: record.transactionIndex,
  } as unknown as ethers.Log);

const sortLogsAscending = (logs: ethers.Log[]): ethers.Log[] => {
  return [...logs].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) {
      return a.blockNumber - b.blockNumber;
    }
    return (a.index ?? 0) - (b.index ?? 0);
  });
};

const getPendingRequestScanDepth = (): number => {
  const configured = Number(import.meta.env.VITE_PENDING_REQUEST_SCAN_DEPTH);
  if (!Number.isNaN(configured) && configured > 0) {
    return configured;
  }
  return 1500;
};

const getFromBlock = async (): Promise<number> => {
  const configured = Number(import.meta.env.VITE_CONTRACT_DEPLOY_BLOCK);
  if (!Number.isNaN(configured) && configured > 0) {
    return configured;
  }

  let lastError: string | null = null;
  for (const activeProvider of getReadProviders()) {
    try {
      const latest = await activeProvider.getBlockNumber();
      const fallbackRange = 200000;
      return Math.max(0, latest - fallbackRange);
    } catch (error) {
      lastError = extractProviderErrorMessage(error);
    }
  }
  throw new Error(lastError || "Failed to determine fromBlock");
};

const normalizeFilterValue = (
  value: string | number | bigint | null
): string | bigint | null => {
  if (value === null) return null;
  if (typeof value === "number") return BigInt(value);
  return value;
};

const normalizeFilterValues = (
  filters: EventLogQueryOptions["filters"]
): Array<string | bigint | null | Array<string | bigint | null>> | undefined => {
  if (!filters) return undefined;
  return filters.map((filter) => {
    if (Array.isArray(filter)) {
      return filter.map((value) => normalizeFilterValue(value));
    }
    return normalizeFilterValue(filter);
  });
};

const toFilterKey = (topics: (string | string[] | null)[]): string => {
  try {
    return JSON.stringify(topics);
  } catch {
    return "all";
  }
};

const getEventLogs = async (
  eventName: string,
  options?: EventLogQueryOptions
): Promise<ParsedLogEntry[]> => {
  const address = getContractAddress();
  const iface = getInterface();
  let event: ethers.EventFragment | null = null;
  try {
    event = iface.getEvent(eventName);
  } catch {
    return [];
  }
  if (!event) {
    return [];
  }
  const normalizedFilters = normalizeFilterValues(options?.filters) ?? [];
  const topics = iface.encodeFilterTopics(event, normalizedFilters);
  const filterKey = toFilterKey(topics);
  let logs: ethers.Log[] = [];
  const fromBlock = await getFromBlock();
  const cached = readEventLogCache(eventName, address, filterKey);
  const cachedLogs = cached
    ? cached.logs.map(fromCacheRecord).filter((log) => log.blockNumber >= fromBlock)
    : [];
  let lastError: string | null = null;

  for (const activeProvider of getReadProviders()) {
    try {
      const toBlock = await activeProvider.getBlockNumber();
      const startBlock = Math.min(fromBlock, toBlock);
      const chunkSize = getLogChunkSize();
      const canUseCache =
        !!cached &&
        cached.lastSyncedBlock >= startBlock &&
        cached.lastSyncedBlock <= toBlock &&
        cachedLogs.length > 0;
      logs = canUseCache ? [...cachedLogs] : [];
      const incrementalStart = canUseCache
        ? Math.max(startBlock, cached!.lastSyncedBlock + 1)
        : startBlock;

      for (let current = incrementalStart; current <= toBlock; current += chunkSize) {
        const end = Math.min(current + chunkSize - 1, toBlock);
        const chunk = await activeProvider.getLogs({
          address,
          fromBlock: current,
          toBlock: end,
          topics,
        });
        logs.push(...chunk);
      }
      logs = sortLogsAscending(logs);
      writeEventLogCache(
        eventName,
        address,
        {
          lastSyncedBlock: toBlock,
          logs: logs.map(toCacheRecord),
        },
        filterKey
      );
      lastError = null;
      break;
    } catch (error: any) {
      lastError = extractProviderErrorMessage(error);
    }
  }

  if (lastError) {
    if (cachedLogs.length > 0) {
      logs = sortLogsAscending(cachedLogs);
      lastError = null;
    } else {
      const hint = "Log query failed. Set VITE_CONTRACT_DEPLOY_BLOCK to the contract deploy block.";
      throw new Error(`[${eventName}] ${hint} ${lastError}`);
    }
  }

  const effectiveTail = options?.tail && options.tail > 0 ? options.tail : 0;
  const logsForParsing =
    effectiveTail > 0 && logs.length > effectiveTail ? logs.slice(-effectiveTail) : logs;

  const parsedLogs = logsForParsing
    .map((log) => {
      const parsed = iface.parseLog(log);
      if (!parsed) return null;
      return { log, parsed };
    })
    .filter((entry): entry is { log: ethers.Log; parsed: ethers.LogDescription } => entry !== null);

  return parsedLogs;
};

const getBlockTimestamp = async (
  blockNumber: number,
  cache: Map<number, number>
): Promise<number> => {
  if (cache.has(blockNumber)) {
    return cache.get(blockNumber)!;
  }
  let lastError: string | null = null;

  for (const activeProvider of getReadProviders()) {
    try {
      const block = await activeProvider.getBlock(blockNumber);
      const timestamp = block ? Number(block.timestamp) : 0;
      cache.set(blockNumber, timestamp);
      return timestamp;
    } catch (error) {
      lastError = extractProviderErrorMessage(error);
    }
  }

  throw new Error(lastError || `Failed to fetch block ${blockNumber}`);
};

const normalizeAccessRequest = (value: any): AccessRequestData => ({
  requestId: Number(value.requestId ?? value[0]),
  documentId: Number(value.documentId ?? value[1]),
  requester: String(value.requester ?? value[2]),
  status: Number(value.status ?? value[3]),
  expiresAt: Number(value.expiresAt ?? value[4]),
  createdAt: Number(value.createdAt ?? value[5]),
});

const initialize = (
  providerInput: ethers.Provider,
  signerInput?: ethers.Signer
): void => {
  provider = providerInput;
  fallbackProviders = getConfiguredRpcProviders();

  const address = getContractAddress();
  readContract = new ethers.Contract(
    address,
    CONTRACT_ABI,
    fallbackProviders[0] ?? providerInput
  );
  writeContract = signerInput
    ? new ethers.Contract(address, CONTRACT_ABI, signerInput)
    : null;
};

const clear = (): void => {
  provider = null;
  fallbackProviders = [];
  readContract = null;
  writeContract = null;
  verifiedAddress = null;
  hasVerifiedCode = false;
  hasActiveAccessCache.clear();
  getVaultCache.clear();
};

const isReady = (): boolean => !!readContract;

const createVault = async (
  name: string,
  description: string,
  guardians: string[],
  approvalThreshold: number
): Promise<number> => {
  const contract = ensureWriteContract();
  const tx = await contract.createVault(
    name,
    description,
    guardians,
    approvalThreshold
  );
  const receipt = await waitForReceipt(tx);

  if (!receipt) {
    return 0;
  }

  const iface = getInterface();
  for (const log of receipt.logs ?? []) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "VaultCreated") {
        return Number(parsed.args.vaultId);
      }
    } catch {
      // ignore non-matching logs
    }
  }

  return 0;
};

const addDocument = async (
  vaultId: number,
  encryptedMetadata: string,
  ipfsHash: string,
  requiredAccess: number,
  releaseCondition = 0,
  guardiansList?: string[],
  shares?: string[]
): Promise<number> => {
  const contract = ensureWriteContract();
  let tx: any;
  const hasShares = guardiansList && shares && guardiansList.length > 0 && shares.length > 0;

  if (
    releaseCondition !== 0 &&
    contractHasFunction(
      contract,
      "addDocumentWithReleaseCondition(uint256,string,string,uint8,uint8,address[],string[])"
    )
  ) {
    if (hasShares) {
      tx = await contract.addDocumentWithReleaseCondition(
        vaultId,
        encryptedMetadata,
        ipfsHash,
        requiredAccess,
        releaseCondition,
        guardiansList,
        shares
      );
    } else {
      tx = await contract.addDocumentWithReleaseCondition(
        vaultId,
        encryptedMetadata,
        ipfsHash,
        requiredAccess,
        releaseCondition
      );
    }
  } else if (releaseCondition === 0) {
    if (hasShares && contractHasFunction(contract, "addDocument(uint256,string,string,uint8,address[],string[])")) {
      tx = await contract.addDocument(
        vaultId,
        encryptedMetadata,
        ipfsHash,
        requiredAccess,
        guardiansList,
        shares
      );
    } else {
      tx = await contract.addDocument(
        vaultId,
        encryptedMetadata,
        ipfsHash,
        requiredAccess
      );
    }
  } else {
    throw new Error(
      "Current contract does not support release-condition policy uploads. Redeploy latest contract."
    );
  }

  const receipt = await waitForReceipt(tx);

  if (!receipt) {
    return 0;
  }

  const iface = getInterface();
  for (const log of receipt.logs ?? []) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "DocumentAdded") {
        return Number(parsed.args.documentId);
      }
    } catch {
      // ignore non-matching logs
    }
  }

  return 0;
};

const requestAccess = async (documentId: number): Promise<number> => {
  const contract = ensureWriteContract();
  const tx = await contract.requestAccess(documentId);
  const receipt = await waitForReceipt(tx);

  if (!receipt) {
    return 0;
  }

  const iface = getInterface();
  for (const log of receipt.logs ?? []) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "AccessRequested") {
        return Number(parsed.args.requestId);
      }
    } catch {
      // ignore non-matching logs
    }
  }

  return 0;
};

const approveAccess = async (requestId: number, encryptedShareForBeneficiary?: string): Promise<void> => {
  const contract = ensureWriteContract();
  let tx: any;
  if (encryptedShareForBeneficiary && contractHasFunction(contract, "approveAccess(uint256,string)")) {
    tx = await contract.approveAccess(requestId, encryptedShareForBeneficiary);
  } else {
    tx = await contract.approveAccess(requestId);
  }
  await waitForReceipt(tx);
};

const registerPublicKey = async (publicKey: string): Promise<void> => {
  const contract = ensureWriteContract();
  const tx = await contract.registerPublicKey(publicKey);
  await waitForReceipt(tx);
};

const getUserPublicKey = async (user: string): Promise<string> => {
  await ensureContractDeployed();
  const contract = ensureReadContract();
  try {
    return await contract.userPublicKeys(user);
  } catch {
    return "";
  }
};

const getEncryptedGuardianShare = async (documentId: number, guardian: string): Promise<string> => {
  await ensureContractDeployed();
  const contract = ensureReadContract();
  try {
    return await contract.getEncryptedGuardianShare(documentId, guardian);
  } catch {
    return "";
  }
};

const getBeneficiaryKeyShare = async (requestId: number, guardian: string): Promise<string> => {
  await ensureContractDeployed();
  const contract = ensureReadContract();
  try {
    return await contract.getBeneficiaryKeyShare(requestId, guardian);
  } catch {
    return "";
  }
};

const acceptGuardianInvite = async (vaultId: number): Promise<void> => {
  const contract = ensureWriteContract();
  const tx = await contract.acceptGuardianInvite(vaultId);
  await waitForReceipt(tx);
  // Guardian is pushed onto vault.guardians on-chain, which getVault() returns.
  invalidateVaultCache(vaultId);
};

const mintAccessToken = async (
  vaultId: number,
  to: string,
  tokenURI: string
): Promise<number> => {
  const contract = ensureWriteContract();
  const tx = await contract.mintAccessToken(vaultId, to, tokenURI);
  const receipt = await waitForReceipt(tx);

  if (!receipt) {
    return 0;
  }

  const iface = getInterface();
  for (const log of receipt.logs ?? []) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "NFTMinted") {
        // Minting a vault pass does not retroactively grant hasActiveAccess for
        // any document: access is only ever set by _grantAccess() inside
        // approveAccess, and a request already rejected for lacking a token
        // stays rejected. No cache invalidation needed here.
        return Number(parsed.args.tokenId);
      }
    } catch {
      // ignore non-matching logs
    }
  }

  return 0;
};

const burnAccessToken = async (tokenId: number): Promise<void> => {
  const contract = ensureWriteContract();
  const tx = await contract.burnAccessToken(tokenId);
  await waitForReceipt(tx);
  // Burning bumps the vault's access version on-chain, revoking every prior
  // grant for that owner+vault in O(1). We can't cheaply resolve which cached
  // (documentId, user) keys that affects from here, so clear the whole
  // hasActiveAccess cache rather than risk serving a stale "still has access".
  clearAccessCache();
};

const cachedGetVault = (contract: ethers.Contract, vaultId: number): Promise<any> =>
  getVaultCache.getOrFetch(`getVault:${vaultId}`, () => contract.getVault(vaultId));

const mapVaultData = (vault: any): VaultData => ({
  id: Number(vault[0]),
  creator: vault[1],
  name: vault[2],
  description: vault[3],
  guardians: vault[4],
  approvalThreshold: Number(vault[5]),
  isActive: vault[6],
  createdAt: Number(vault[7]),
  network: "avalanche",
});

const mapDocumentData = (doc: any): DocumentData => ({
  id: Number(doc[0]),
  vaultId: Number(doc[1]),
  encryptedMetadata: doc[2],
  ipfsHash: doc[3],
  uploadedBy: doc[4],
  uploadedAt: Number(doc[5]),
  requiredAccess: Number(doc[6]),
});

const fetchVaultsByIds = async (vaultIds: number[]): Promise<VaultData[]> => {
  await ensureContractDeployed();
  const contract = ensureReadContract();
  const uniqueIds = Array.from(new Set(vaultIds)).filter((id) => id > 0);
  if (uniqueIds.length === 0) {
    return [];
  }

  const vaults = await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        const vault = await cachedGetVault(contract, id);
        return mapVaultData(vault);
      } catch {
        return null;
      }
    })
  );

  return vaults.filter((vault): vault is VaultData => vault !== null);
};

const fetchVaults = async (): Promise<VaultData[]> => {
  await ensureContractDeployed();
  const contract = ensureReadContract();
  const logs = await getEventLogs("VaultCreated");
  const ids = Array.from(
    new Set(logs.map((entry) => Number(entry.parsed.args.vaultId)))
  );

  const vaults = await Promise.all(ids.map((id) => cachedGetVault(contract, id)));
  return vaults.map((vault) => mapVaultData(vault));
};

const fetchDocuments = async (): Promise<DocumentData[]> => {
  await ensureContractDeployed();
  const contract = ensureReadContract();
  const logs = await getEventLogs("DocumentAdded");
  const ids = Array.from(
    new Set(logs.map((entry) => Number(entry.parsed.args.documentId)))
  );

  const documents = await Promise.all(
    ids.map((id) => contract.documents(id))
  );

  return documents.map((doc) => mapDocumentData(doc));
};

const fetchDocumentsForVaults = async (vaultIds: number[]): Promise<DocumentData[]> => {
  await ensureContractDeployed();
  const contract = ensureReadContract();
  const uniqueVaultIds = Array.from(new Set(vaultIds)).filter((id) => id > 0);
  if (uniqueVaultIds.length === 0) {
    return [];
  }

  const vaultIdChunks = chunkArray(uniqueVaultIds, 20);
  const logGroups = await Promise.all(
    vaultIdChunks.map((chunk) =>
      getEventLogs("DocumentAdded", {
        filters: [null, chunk.map((id) => BigInt(id)), null],
      })
    )
  );

  const documentIds = new Set<number>();
  logGroups.flat().forEach((entry) => {
    documentIds.add(Number(entry.parsed.args.documentId));
  });

  if (documentIds.size === 0) {
    return [];
  }

  const documents = await Promise.all(
    Array.from(documentIds).map((id) => contract.documents(id))
  );
  return documents.map((doc) => mapDocumentData(doc));
};

const fetchVaultsForAccount = async (
  account: string,
  options?: { tokenVaultIds?: number[] }
): Promise<VaultData[]> => {
  if (!account) return [];
  await ensureContractDeployed();
  const contract = ensureReadContract();
  const accountLower = account.toLowerCase();

  const [createdLogs, guardianLogs] = await Promise.all([
    getEventLogs("VaultCreated", { filters: [null, accountLower] }),
    getEventLogs("GuardianAdded", { filters: [null, accountLower] }),
  ]);

  const vaultIds = new Set<number>();
  createdLogs.forEach((entry) => vaultIds.add(Number(entry.parsed.args.vaultId)));
  guardianLogs.forEach((entry) => vaultIds.add(Number(entry.parsed.args.vaultId)));

  if (options?.tokenVaultIds?.length) {
    options.tokenVaultIds
      .filter((id) => id > 0)
      .forEach((id) => vaultIds.add(id));
  } else {
    const mintedLogs = await getEventLogs("NFTMinted", {
      filters: [null, accountLower, null],
    });
    mintedLogs.forEach((entry) => vaultIds.add(Number(entry.parsed.args.vaultId)));
  }

  const candidateVaults = await fetchVaultsByIds(Array.from(vaultIds));
  if (candidateVaults.length === 0) {
    return [];
  }

  const tokenCandidates = candidateVaults.filter((vault) => {
    const isCreator = vault.creator.toLowerCase() === accountLower;
    const isGuardian = vault.guardians.some(
      (guardian) => guardian.toLowerCase() === accountLower
    );
    return !isCreator && !isGuardian;
  });

  const tokenChecks = await Promise.all(
    tokenCandidates.map(async (vault) => {
      try {
        const hasToken = await contract.hasVaultToken(account, vault.id);
        return [vault.id, Boolean(hasToken)] as const;
      } catch {
        return [vault.id, false] as const;
      }
    })
  );
  const tokenMap = new Map<number, boolean>(tokenChecks);

  return candidateVaults.filter((vault) => {
    const isCreator = vault.creator.toLowerCase() === accountLower;
    const isGuardian = vault.guardians.some(
      (guardian) => guardian.toLowerCase() === accountLower
    );
    const hasToken = tokenMap.get(vault.id) ?? false;
    return isCreator || isGuardian || hasToken;
  });
};

const getTotalSupply = async (): Promise<number> => {
  await ensureContractDeployed();
  const contract = ensureReadContract();
  const total = await contract.totalSupply();
  return Number(total);
};

const hasActiveAccess = async (
  documentId: number,
  user: string
): Promise<boolean> => {
  if (!user) return false;
  await ensureContractDeployed();
  const contract = ensureReadContract();
  try {
    const allowed = await hasActiveAccessCache.getOrFetch(
      `hasActiveAccess:avalanche:${documentId}:${user.toLowerCase()}`,
      () => contract.hasActiveAccess(documentId, user)
    );
    return Boolean(allowed);
  } catch {
    return false;
  }
};

const getActiveAccessMap = async (
  user: string,
  documentIds: number[]
): Promise<Record<number, boolean>> => {
  if (!user || documentIds.length === 0) {
    return {};
  }

  await ensureContractDeployed();
  const contract = ensureReadContract();

  const entries = await Promise.all(
    documentIds.map(async (documentId) => {
      try {
        const allowed = await hasActiveAccessCache.getOrFetch(
          `hasActiveAccess:avalanche:${documentId}:${user.toLowerCase()}`,
          () => contract.hasActiveAccess(documentId, user)
        );
        return [documentId, Boolean(allowed)] as const;
      } catch {
        return [documentId, false] as const;
      }
    })
  );

  return Object.fromEntries(entries);
};

const getLatestRequestsForUser = async (
  user: string,
  documentIds: number[]
): Promise<Record<number, AccessRequestData | null>> => {
  if (!user || documentIds.length === 0) {
    return {};
  }

  await ensureContractDeployed();
  const contract = ensureReadContract();

  const entries = await Promise.all(
    documentIds.map(async (documentId) => {
      try {
        const requestIdRaw = await contract.latestRequestId(documentId, user);
        const requestId = Number(requestIdRaw);
        if (!requestId) {
          return [documentId, null] as const;
        }

        const requestRaw = await contract.accessRequests(requestId);
        const normalized = normalizeAccessRequest(requestRaw);
        if (!normalized.requestId) {
          return [documentId, null] as const;
        }

        return [documentId, normalized] as const;
      } catch {
        return [documentId, null] as const;
      }
    })
  );

  return Object.fromEntries(entries);
};

const getDocumentReleaseCondition = async (documentId: number): Promise<number> => {
  await ensureContractDeployed();
  const contract = ensureReadContract();

  if (!contractHasFunction(contract, "documentReleaseCondition(uint256)")) {
    return 0;
  }

  try {
    const value = await contract.documentReleaseCondition(documentId);
    return Number(value);
  } catch {
    return 0;
  }
};

const getDocumentReleaseConditionMap = async (
  documentIds: number[]
): Promise<Record<number, number>> => {
  if (documentIds.length === 0) {
    return {};
  }

  await ensureContractDeployed();
  const contract = ensureReadContract();

  if (!contractHasFunction(contract, "documentReleaseCondition(uint256)")) {
    return Object.fromEntries(documentIds.map((id) => [id, 0]));
  }

  const entries = await Promise.all(
    documentIds.map(async (documentId) => {
      try {
        const value = await contract.documentReleaseCondition(documentId);
        return [documentId, Number(value)] as const;
      } catch {
        return [documentId, 0] as const;
      }
    })
  );

  return Object.fromEntries(entries);
};

const getVaultReleaseState = async (vaultId: number): Promise<VaultReleaseState> => {
  await ensureContractDeployed();
  const contract = ensureReadContract();

  const fallback: VaultReleaseState = {
    emergencyMode: false,
    inactivityPeriod: 30 * 24 * 60 * 60,
    lastProofOfLife: 0,
    postDeathUnlocked: false,
  };

  if (!contractHasFunction(contract, "getVaultReleaseState(uint256)")) {
    return fallback;
  }

  try {
    const value = await contract.getVaultReleaseState(vaultId);
    return {
      emergencyMode: Boolean(value[0]),
      inactivityPeriod: Number(value[1]),
      lastProofOfLife: Number(value[2]),
      postDeathUnlocked: Boolean(value[3]),
    };
  } catch {
    return fallback;
  }
};

const fetchVaultReleaseStates = async (
  vaultIds: number[]
): Promise<Record<number, VaultReleaseState>> => {
  if (vaultIds.length === 0) {
    return {};
  }

  const entries = await Promise.all(
    vaultIds.map(async (vaultId) => [vaultId, await getVaultReleaseState(vaultId)] as const)
  );

  return Object.fromEntries(entries);
};

const configureVaultRelease = async (
  vaultId: number,
  inactivityPeriod: number
): Promise<void> => {
  const contract = ensureWriteContract();
  if (!contractHasFunction(contract, "configureVaultRelease(uint256,uint256)")) {
    throw new Error("Current contract does not support vault release policy configuration.");
  }
  const tx = await contract.configureVaultRelease(vaultId, inactivityPeriod);
  await waitForReceipt(tx);
};

const recordProofOfLife = async (vaultId: number): Promise<void> => {
  const contract = ensureWriteContract();
  if (!contractHasFunction(contract, "proveLife(uint256)")) {
    throw new Error("Current contract does not support proof-of-life actions.");
  }
  const tx = await contract.proveLife(vaultId);
  await waitForReceipt(tx);
};

const setEmergencyMode = async (vaultId: number, enabled: boolean): Promise<void> => {
  const contract = ensureWriteContract();
  if (!contractHasFunction(contract, "setEmergencyMode(uint256,bool)")) {
    throw new Error("Current contract does not support emergency mode controls.");
  }
  const tx = await contract.setEmergencyMode(vaultId, enabled);
  await waitForReceipt(tx);
};

const setBeneficiary = async (vaultId: number, beneficiary: string): Promise<void> => {
  const contract = ensureWriteContract();
  if (!contractHasFunction(contract, "setBeneficiary(uint256,address)")) {
    throw new Error("Current contract does not support beneficiary notifications.");
  }
  const tx = await contract.setBeneficiary(vaultId, beneficiary);
  await waitForReceipt(tx);
};

const getBeneficiary = async (vaultId: number): Promise<string> => {
  await ensureContractDeployed();
  const contract = ensureReadContract();

  if (!contractHasFunction(contract, "getBeneficiary(uint256)")) {
    return ethers.ZeroAddress;
  }

  try {
    return await contract.getBeneficiary(vaultId);
  } catch {
    return ethers.ZeroAddress;
  }
};

const fetchPendingInvites = async (user: string): Promise<GuardianInviteData[]> => {
  if (!user) {
    return [];
  }

  await ensureContractDeployed();
  const contract = ensureReadContract();
  try {
    const invitesRaw = await contract.getPendingInvites(user);
    return (invitesRaw as any[]).map((invite) => ({
      guardian: String(invite.guardian ?? invite[0]),
      vaultId: Number(invite.vaultId ?? invite[1]),
      accepted: Boolean(invite.accepted ?? invite[2]),
      expiresAt: Number(invite.expiresAt ?? invite[3]),
    }));
  } catch {
    return [];
  }
};

const fetchPendingApprovalsForGuardian = async (
  guardian: string,
  limit = 10
): Promise<PendingApprovalData[]> => {
  if (!guardian) {
    return [];
  }

  await ensureContractDeployed();
  const contract = ensureReadContract();
  const requestLogs = await getEventLogs("AccessRequested", {
    tail: getPendingRequestScanDepth(),
  });

  const sortedLogs = [...requestLogs].sort((a, b) => {
    if (a.log.blockNumber !== b.log.blockNumber) {
      return b.log.blockNumber - a.log.blockNumber;
    }
    return b.log.index - a.log.index;
  });

  const now = Math.floor(Date.now() / 1000);
  const guardianLower = guardian.toLowerCase();
  const seen = new Set<number>();
  const documentCache = new Map<number, any>();
  const vaultCache = new Map<number, any>();
  const pending: PendingApprovalData[] = [];

  for (const entry of sortedLogs) {
    const requestId = Number(entry.parsed.args.requestId);
    if (!requestId || seen.has(requestId)) {
      continue;
    }
    seen.add(requestId);

    try {
      const approvedByGuardian = await contract.hasApprovedRequest(requestId, guardian);
      if (approvedByGuardian) {
        continue;
      }

      const requestRaw = await contract.accessRequests(requestId);
      const request = normalizeAccessRequest(requestRaw);
      if (!request.requestId || request.status !== 0 || request.expiresAt <= now) {
        continue;
      }

      let document = documentCache.get(request.documentId);
      if (!document) {
        document = await contract.documents(request.documentId);
        documentCache.set(request.documentId, document);
      }

      const vaultId = Number(document[1]);
      let vault = vaultCache.get(vaultId);
      if (!vault) {
        vault = await cachedGetVault(contract, vaultId);
        vaultCache.set(vaultId, vault);
      }

      const guardians: string[] = vault[4] ?? [];
      const isGuardianForVault = guardians.some(
        (address) => address.toLowerCase() === guardianLower
      );

      if (!isGuardianForVault) {
        continue;
      }

      pending.push({
        requestId,
        documentId: request.documentId,
        vaultId,
        vaultName: String(vault[2] ?? `Vault #${vaultId}`),
        requester: request.requester,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      });

      if (pending.length >= limit) {
        break;
      }
    } catch {
      // skip malformed or unavailable request entries
    }
  }

  return pending;
};

const fetchUserTokens = async (account: string): Promise<TokenData[]> => {
  await ensureContractDeployed();
  const contract = ensureReadContract();

  const accountLower = account.toLowerCase();
  const mintedLogs = await getEventLogs("NFTMinted", {
    filters: [null, accountLower, null],
  });
  const mintedByToken = new Map<number, { vaultId: number; blockNumber: number }>();
  for (const entry of mintedLogs) {
    const tokenId = Number(entry.parsed.args.tokenId);
    mintedByToken.set(tokenId, {
      vaultId: Number(entry.parsed.args.vaultId),
      blockNumber: entry.log.blockNumber,
    });
  }

  const blockCache = new Map<number, number>();

  const tokens = await Promise.all(
    Array.from(mintedByToken.entries()).map(async ([tokenId, mintedInfo]) => {
      try {
        const owner = await contract.ownerOf(tokenId);
        if (String(owner).toLowerCase() !== accountLower) {
          return null;
        }
      } catch {
        // Token likely burned or missing
        return null;
      }

      let tokenURI = "";
      try {
        tokenURI = await contract.tokenURI(tokenId);
      } catch {
        tokenURI = "";
      }

      const mintedAt = mintedInfo
        ? await getBlockTimestamp(mintedInfo.blockNumber, blockCache)
        : null;

      return {
        tokenId,
        owner: account,
        vaultId: mintedInfo ? mintedInfo.vaultId : null,
        tokenURI,
        mintedAt,
      };
    })
  );

  return tokens
    .filter((token): token is TokenData => token !== null)
    .sort((a, b) => b.tokenId - a.tokenId);
};

const hasVaultToken = async (account: string, vaultId: number): Promise<boolean> => {
  if (!account || !vaultId || vaultId <= 0) return false;
  try {
    await ensureContractDeployed();
    const contract = ensureReadContract();
    const result = await contract.hasVaultToken(account, vaultId);
    return Boolean(result);
  } catch {
    try {
      const userTokens = await fetchUserTokens(account);
      return userTokens.some((t) => t.vaultId === vaultId);
    } catch {
      return false;
    }
  }
};

const getActivePassCountByVault = async (
  vaultIds: number[]
): Promise<Record<number, number>> => {
  await ensureContractDeployed();
  if (vaultIds.length === 0) {
    return {};
  }

  const targetVaultIds = new Set<number>(vaultIds);
  const vaultIdChunks = chunkArray(vaultIds, 20);
  const mintGroups = await Promise.all(
    vaultIdChunks.map((chunk) =>
      getEventLogs("NFTMinted", {
        filters: [null, null, chunk.map((id) => BigInt(id))],
      })
    )
  );
  const mintedLogs = mintGroups.flat();

  const counts: Record<number, number> = {};
  vaultIds.forEach((vaultId) => {
    counts[vaultId] = 0;
  });

  const contract = ensureReadContract();
  const tokenChecks = await Promise.all(
    mintedLogs.map(async (entry) => {
      const tokenId = Number(entry.parsed.args.tokenId);
      const vaultId = Number(entry.parsed.args.vaultId);
      if (!targetVaultIds.has(vaultId)) {
        return null;
      }
      try {
        await contract.ownerOf(tokenId);
        return vaultId;
      } catch {
        return null;
      }
    })
  );

  tokenChecks.forEach((vaultId) => {
    if (vaultId === null) return;
    counts[vaultId] = (counts[vaultId] || 0) + 1;
  });

  return counts;
};

const getRecentActivity = async (limit = 5): Promise<ActivityEvent[]> => {
  await ensureContractDeployed();
  const contract = ensureReadContract();
  const perEventTail = Math.max(limit * 6, 40);
  const network = getEcosystem();
  const [vaultLogs, documentLogs, requestLogs, nftLogs] = await Promise.all([
    getEventLogs("VaultCreated", { tail: perEventTail }),
    getEventLogs("DocumentAdded", { tail: perEventTail }),
    getEventLogs("AccessRequested", { tail: perEventTail }),
    getEventLogs("NFTMinted", { tail: perEventTail }),
  ]);

  const allLogs = [
    ...vaultLogs,
    ...documentLogs,
    ...requestLogs,
    ...nftLogs,
  ];

  allLogs.sort((a, b) => {
    if (a.log.blockNumber !== b.log.blockNumber) {
      return b.log.blockNumber - a.log.blockNumber;
    }
    return b.log.index - a.log.index;
  });

  const blockCache = new Map<number, number>();

  const limited = allLogs.slice(0, limit);
  const events = await Promise.all(
    limited.map(async (entry) => {
      const timestamp = await getBlockTimestamp(entry.log.blockNumber, blockCache);
      const name = entry.parsed.name;
      const txHash = entry.log.transactionHash;

      if (name === "VaultCreated") {
        return {
          action: "Vault Created",
          actor: entry.parsed.args.creator,
          timestamp,
          status: "success" as const,
          txHash,
          network,
        };
      }

      if (name === "DocumentAdded") {
        try {
          const doc = await contract.documents(Number(entry.parsed.args.documentId));
          return {
            action: "Document Added",
            actor: doc[4],
            timestamp,
            status: "success" as const,
            txHash,
            network,
          };
        } catch {
          return {
            action: "Document Added",
            actor: "Unknown",
            timestamp,
            status: "success" as const,
            txHash,
            network,
          };
        }
      }

      if (name === "AccessRequested") {
        return {
          action: "Access Requested",
          actor: entry.parsed.args.requester,
          timestamp,
          status: "pending" as const,
          txHash,
          network,
        };
      }

      if (name === "NFTMinted") {
        return {
          action: "NFT Minted",
          actor: entry.parsed.args.to,
          timestamp,
          status: "success" as const,
          txHash,
          network,
        };
      }

      return {
        action: "Activity",
        actor: "Unknown",
        timestamp,
        status: "success" as const,
        txHash,
        network,
      };
    })
  );

  return events;
};

const getEcosystem = (): "avalanche" | "stellar" => {
  if (typeof window === "undefined") return "avalanche";
  return (window.localStorage.getItem("spoovault-ecosystem") as "avalanche" | "stellar") || "avalanche";
};

const proxiedCreateVault = async (
  name: string,
  description: string,
  guardians: string[],
  approvalThreshold: number
): Promise<number> => {
  if (getEcosystem() === "stellar") {
    return stellarService.createVault(name, description, guardians, approvalThreshold);
  }
  return createVault(name, description, guardians, approvalThreshold);
};

const proxiedAddDocument = async (
  vaultId: number,
  encryptedMetadata: string,
  ipfsHash: string,
  requiredAccess: number,
  releaseCondition = 0,
  guardiansList?: string[],
  shares?: string[]
): Promise<number> => {
  if (getEcosystem() === "stellar") {
    return stellarService.addDocument(
      vaultId,
      encryptedMetadata,
      ipfsHash,
      requiredAccess,
      releaseCondition,
      guardiansList,
      shares
    );
  }
  return addDocument(vaultId, encryptedMetadata, ipfsHash, requiredAccess, releaseCondition, guardiansList, shares);
};

const proxiedRequestAccess = async (documentId: number): Promise<number> => {
  if (getEcosystem() === "stellar") {
    return stellarService.requestAccess(documentId);
  }
  return requestAccess(documentId);
};

const proxiedApproveAccess = async (requestId: number, encryptedShareForBeneficiary?: string): Promise<void> => {
  if (getEcosystem() === "stellar") {
    await stellarService.approveAccess(requestId, encryptedShareForBeneficiary);
  } else {
    await approveAccess(requestId, encryptedShareForBeneficiary);
  }
  // Approval can flip hasActiveAccess for the requester on both ecosystems.
  clearAccessCache();
};

const proxiedAcceptGuardianInvite = async (vaultId: number): Promise<void> => {
  if (getEcosystem() === "stellar") {
    await stellarService.acceptGuardianInvite(vaultId);
    // Stellar's hasActiveAccess check grants access directly to a document's
    // vault guardians (see proxiedHasActiveAccess below), unlike the EVM
    // contract where guardianship alone never grants document access.
    clearAccessCache();
    return;
  }
  return acceptGuardianInvite(vaultId);
};

const proxiedFetchVaultsForAccount = async (
  account: string,
  options?: { tokenVaultIds?: number[] }
): Promise<VaultData[]> => {
  if (getEcosystem() === "stellar") {
    return stellarService.fetchVaultsForAccount(account) as unknown as Promise<VaultData[]>;
  }
  return fetchVaultsForAccount(account, options);
};

const proxiedFetchDocumentsForVaults = async (vaultIds: number[]): Promise<DocumentData[]> => {
  if (getEcosystem() === "stellar") {
    return stellarService.fetchDocumentsForVaults(vaultIds) as unknown as Promise<DocumentData[]>;
  }
  return fetchDocumentsForVaults(vaultIds);
};

const proxiedFetchPendingApprovalsForGuardian = async (
  guardianAddress: string,
  _limit?: number
): Promise<PendingApprovalData[]> => {
  if (getEcosystem() === "stellar") {
    return stellarService.fetchPendingApprovalsForGuardian(guardianAddress) as unknown as Promise<PendingApprovalData[]>;
  }
  return fetchPendingApprovalsForGuardian(guardianAddress);
};

const proxiedGetEncryptedGuardianShare = async (documentId: number, guardian: string): Promise<string> => {
  if (getEcosystem() === "stellar") {
    return stellarService.getEncryptedGuardianShare(documentId, guardian);
  }
  return getEncryptedGuardianShare(documentId, guardian);
};

const proxiedGetBeneficiaryKeyShare = async (requestId: number, guardian: string): Promise<string> => {
  if (getEcosystem() === "stellar") {
    return stellarService.getBeneficiaryKeyShare(requestId, guardian);
  }
  return getBeneficiaryKeyShare(requestId, guardian);
};

const proxiedRegisterPublicKey = async (publicKey: string): Promise<void> => {
  if (getEcosystem() === "stellar") {
    return stellarService.registerPublicKey(publicKey);
  }
  return registerPublicKey(publicKey);
};

const proxiedGetUserPublicKey = async (user: string): Promise<string> => {
  if (getEcosystem() === "stellar") {
    return stellarService.getUserPublicKey(user);
  }
  return getUserPublicKey(user);
};

const proxiedFetchPendingInvites = async (account: string): Promise<any[]> => {
  if (getEcosystem() === "stellar") {
    return stellarService.getPendingInvites(account);
  }
  return fetchPendingInvites(account);
};

const proxiedHasActiveAccess = async (documentId: number, user: string): Promise<boolean> => {
  if (getEcosystem() === "stellar") {
    const account = stellarService.getAccount();
    if (!account) return false;
    return hasActiveAccessCache.getOrFetch(
      `hasActiveAccess:stellar:${documentId}:${account.toLowerCase()}`,
      async () => {
        const vaults = await stellarService.fetchVaultsForAccount(account);
        const docs = await stellarService.fetchDocumentsForVaults(vaults.map(v => v.id));
        const doc = docs.find(d => d.id === documentId);
        if (!doc) return false;
        if (doc.uploadedBy.toLowerCase() === account.toLowerCase()) return true;

        const vault = vaults.find(v => v.id === doc.vaultId);
        if (vault?.guardians.some(g => g.toLowerCase() === account.toLowerCase())) return true;

        try {
          const requestsRaw = localStorage.getItem("spoovault-stellar-mock-requests");
          if (requestsRaw) {
            const requests = JSON.parse(requestsRaw) as any[];
            return requests.some(
              r => r.documentId === documentId && r.requester.toLowerCase() === account.toLowerCase() && r.status === 1
            );
          }
        } catch {}
        return false;
      }
    );
  }
  return hasActiveAccess(documentId, user);
};

const proxiedGetActiveAccessMap = async (
  user: string,
  documentIds: number[]
): Promise<Record<number, boolean>> => {
  if (getEcosystem() === "stellar") {
    const entries = await Promise.all(
      documentIds.map(async (id) => [id, await proxiedHasActiveAccess(id, user)] as const)
    );
    return Object.fromEntries(entries);
  }
  return getActiveAccessMap(user, documentIds);
};

const proxiedGetLatestRequestsForUser = async (
  user: string,
  documentIds: number[]
): Promise<Record<number, AccessRequestData | null>> => {
  if (getEcosystem() === "stellar") {
    try {
      const requestsRaw = localStorage.getItem("spoovault-stellar-mock-requests");
      const requests = requestsRaw ? (JSON.parse(requestsRaw) as any[]) : [];
      const res: Record<number, AccessRequestData | null> = {};
      for (const id of documentIds) {
        const matched = requests.filter(
          r => r.documentId === id && r.requester.toLowerCase() === user.toLowerCase()
        );
        if (matched.length > 0) {
          matched.sort((a, b) => b.requestId - a.requestId);
          res[id] = matched[0] as AccessRequestData;
        } else {
          res[id] = null;
        }
      }
      return res;
    } catch {
      return {};
    }
  }
  return getLatestRequestsForUser(user, documentIds);
};

const proxiedFetchUserTokens = async (account: string): Promise<TokenData[]> => {
  if (getEcosystem() === "stellar") {
    return stellarService.fetchUserTokens(account) as unknown as Promise<TokenData[]>;
  }
  return fetchUserTokens(account);
};

const proxiedHasVaultToken = async (
  account: string,
  vaultId: number,
  network?: "avalanche" | "stellar"
): Promise<boolean> => {
  const targetNetwork = network || getEcosystem();
  try {
    if (targetNetwork === "stellar") {
      return await stellarService.hasVaultToken(account, vaultId);
    } else if (targetNetwork === "avalanche") {
      return await hasVaultToken(account, vaultId);
    }
    return false;
  } catch {
    return false;
  }
};

const proxiedMintAccessToken = async (
  vaultId: number,
  to: string,
  tokenURI: string
): Promise<number> => {
  if (getEcosystem() === "stellar") {
    return stellarService.mintAccessToken(vaultId, to, tokenURI);
  }
  return mintAccessToken(vaultId, to, tokenURI);
};

export const contractService = {
  initialize,
  clear,
  isReady,
  createVault: proxiedCreateVault,
  addDocument: proxiedAddDocument,
  requestAccess: proxiedRequestAccess,
  approveAccess: proxiedApproveAccess,
  acceptGuardianInvite: proxiedAcceptGuardianInvite,
  mintAccessToken: proxiedMintAccessToken,
  burnAccessToken,
  fetchVaults,
  fetchVaultsByIds,
  fetchVaultsForAccount: proxiedFetchVaultsForAccount,
  fetchDocuments,
  fetchDocumentsForVaults: proxiedFetchDocumentsForVaults,
  fetchPendingInvites: proxiedFetchPendingInvites,
  fetchUserTokens: proxiedFetchUserTokens,
  hasVaultToken: proxiedHasVaultToken,
  getActivePassCountByVault,
  getTotalSupply,
  hasActiveAccess: proxiedHasActiveAccess,
  getActiveAccessMap: proxiedGetActiveAccessMap,
  getLatestRequestsForUser: proxiedGetLatestRequestsForUser,
  getDocumentReleaseCondition,
  getDocumentReleaseConditionMap,
  getVaultReleaseState,
  fetchVaultReleaseStates,
  configureVaultRelease,
  recordProofOfLife,
  setEmergencyMode,
  setBeneficiary,
  getBeneficiary,
  fetchPendingApprovalsForGuardian: proxiedFetchPendingApprovalsForGuardian,
  getRecentActivity,
  registerPublicKey: proxiedRegisterPublicKey,
  getUserPublicKey: proxiedGetUserPublicKey,
  getEncryptedGuardianShare: proxiedGetEncryptedGuardianShare,
  getBeneficiaryKeyShare: proxiedGetBeneficiaryKeyShare,
};
