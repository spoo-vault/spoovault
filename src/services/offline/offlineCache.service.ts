import {
  getCachedDocuments,
  getCachedInvites,
  getCachedPublicKey,
  getCachedVaults,
  putDocuments,
  putInvites,
  putPublicKey,
  putVaults,
  type CachedDocument,
  type CachedInvite,
  type CachedVault,
  type OfflineNetwork,
} from "./db";

const NETWORK_ERROR_PATTERNS: RegExp[] = [
  /failed to fetch/i,
  /networkerror/i,
  /network request failed/i,
  /network error/i,
  /load failed/i,
  /err_network/i,
  /err_internet_disconnected/i,
  /enetunreach/i,
  /net::/,
  /underlying network changed/i,
  /websocket connection.*failed/i,
];

export const isOnline = (): boolean => {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
};

/**
 * Heuristic used to decide whether a thrown error is caused by missing
 * connectivity (in which case reads fall back to the IndexedDB cache and
 * writes are queued) rather than by a contract/business-logic failure.
 */
export const isNetworkFailure = (error: unknown): boolean => {
  if (!isOnline()) return true;
  if (!error) return false;

  const message =
    typeof error === "string"
      ? error
      : ((error as Error)?.message ?? "") +
        " " +
        ((error as { shortMessage?: string })?.shortMessage ?? "");

  if (!message) return false;
  return NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
};

/**
 * Thrown after a write was successfully persisted to the offline queue.
 * Pages already surface `error.message` via toast, so this gives users
 * consistent "saved offline" feedback without touching every call site.
 */
export class OfflineQueuedError extends Error {
  readonly queued = true;

  constructor(label: string) {
    super(
      `You're offline — ${label} was saved and will sync automatically when you reconnect.`
    );
    this.name = "OfflineQueuedError";
  }
}

export type CacheFallbackListener = (
  scope: string,
  source: "cache" | "queue"
) => void;

const fallbackListeners = new Set<CacheFallbackListener>();

export const onCacheFallback = (listener: CacheFallbackListener): (() => void) => {
  fallbackListeners.add(listener);
  return () => fallbackListeners.delete(listener);
};

const notifyFallback = (scope: string, source: "cache" | "queue"): void => {
  fallbackListeners.forEach((listener) => {
    try {
      listener(scope, source);
    } catch {
      // listener errors must never break the data path
    }
  });
};

interface OfflineReadOptions<T> {
  /** Human-readable scope used in telemetry/toasts. */
  scope: string;
  fetchLive: () => Promise<T>;
  readCache: () => Promise<T | null>;
  writeCache: (data: T) => Promise<void>;
}

/**
 * Read-through helper: serve live data when possible and mirror it into the
 * Dexie cache. When connectivity fails, transparently return the cached copy
 * so vault inspection keeps working with zero network.
 */
export const withOfflineFallback = async <T>(options: OfflineReadOptions<T>): Promise<T> => {
  const { scope, fetchLive, readCache, writeCache } = options;

  try {
    const data = await fetchLive();
    try {
      await writeCache(data);
    } catch {
      // cache write failures must not break live reads
    }
    return data;
  } catch (error) {
    if (!isNetworkFailure(error)) {
      throw error;
    }

    let cached: T | null = null;
    try {
      cached = await readCache();
    } catch {
      cached = null;
    }

    if (
      cached !== null &&
      cached !== undefined &&
      !(Array.isArray(cached) && cached.length === 0)
    ) {
      notifyFallback(scope, "cache");
      return cached;
    }

    throw error;
  }
};

// ---------------------------------------------------------------------------
// Typed cache accessors shared by contract.service
// ---------------------------------------------------------------------------

export interface VaultCacheInput {
  id: number;
  creator: string;
  name: string;
  description: string;
  guardians: string[];
  approvalThreshold: number;
  isActive: boolean;
  createdAt: number;
  network?: OfflineNetwork;
}

export const writeVaultsCache = async (
  account: string,
  network: OfflineNetwork,
  vaults: VaultCacheInput[]
): Promise<void> => {
  await putVaults(
    account,
    network,
    vaults.map((vault) => ({
      id: Number(vault.id),
      creator: String(vault.creator ?? ""),
      name: String(vault.name ?? ""),
      description: String(vault.description ?? ""),
      guardians: Array.isArray(vault.guardians) ? [...vault.guardians] : [],
      approvalThreshold: Number(vault.approvalThreshold ?? 0),
      isActive: Boolean(vault.isActive),
      createdAt: Number(vault.createdAt ?? 0),
    }))
  );
};

export const readVaultsCache = async (
  account: string,
  network: OfflineNetwork
): Promise<CachedVault[]> => getCachedVaults(account, network);

export interface DocumentCacheInput {
  id: number;
  vaultId: number;
  encryptedMetadata: string;
  ipfsHash: string;
  uploadedBy: string;
  uploadedAt: number;
  requiredAccess: number;
}

export const writeDocumentsCache = async (
  account: string,
  network: OfflineNetwork,
  documents: DocumentCacheInput[]
): Promise<void> => {
  await putDocuments(account, network, documents);
};

export const readDocumentsCache = async (
  account: string,
  network: OfflineNetwork
): Promise<CachedDocument[]> => getCachedDocuments(account, network);

export interface InviteCacheInput {
  guardian: string;
  vaultId: number;
  accepted: boolean;
  expiresAt: number;
}

export const writeInvitesCache = async (
  account: string,
  network: OfflineNetwork,
  invites: InviteCacheInput[]
): Promise<void> => {
  await putInvites(account, network, invites);
};

export const readInvitesCache = async (
  account: string,
  network: OfflineNetwork
): Promise<CachedInvite[]> => getCachedInvites(account, network);

export const writePublicKeyCache = async (
  address: string,
  publicKey: string,
  network: OfflineNetwork
): Promise<void> => {
  await putPublicKey(address, publicKey ?? "", network);
};

export const readPublicKeyCache = async (
  address: string,
  network: OfflineNetwork
): Promise<string | null> => {
  const cached = await getCachedPublicKey(address, network);
  return cached === null ? null : cached;
};
