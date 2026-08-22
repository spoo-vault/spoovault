import {
  insertAction,
  countActionsByStatus,
  listActionsByStatus,
  updateAction,
  type OfflineNetwork,
  type PendingActionRecord,
  type PendingActionStatus,
} from "./db";
import { isOnline } from "./offlineCache.service";
import { MSG_REGISTER_SYNC, SYNC_TAG } from "./syncConstants";

export interface CreateVaultPayload {
  name: string;
  description: string;
  guardians: string[];
  approvalThreshold: number;
}

export interface CreateDocumentDraftPayload {
  account: string;
  vaultId: number;
  vaultName?: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  lastModified?: number;
  encryptedMetadata: string;
  encryptedFileBase64: string;
  encryptedDocKey: string;
  requiredAccess: number;
  releaseCondition?: number;
  guardiansList: string[];
  shares?: string[];
}

export interface AddDocumentPayload {
  vaultId: number;
  encryptedMetadata: string;
  ipfsHash: string;
  requiredAccess: number;
  releaseCondition?: number;
  guardiansList?: string[];
  shares?: string[];
}

export interface RegisterPublicKeyPayload {
  publicKey: string;
}

export interface RequestAccessPayload {
  documentId: number;
}

export interface ActionPayloadMap {
  "create-vault": CreateVaultPayload;
  "create-document-draft": CreateDocumentDraftPayload;
  "add-document": AddDocumentPayload;
  "register-public-key": RegisterPublicKeyPayload;
  "request-access": RequestAccessPayload;
}

export interface QueueState {
  pending: number;
  failed: number;
  processing: number;
  synced: number;
  online: boolean;
}

type QueueListener = (state: QueueState) => void;

const listeners = new Set<QueueListener>();

let lastKnownState: QueueState = {
  pending: 0,
  failed: 0,
  processing: 0,
  synced: 0,
  online: true,
};

export const getEcosystem = (): OfflineNetwork => {
  if (typeof window === "undefined") return "avalanche";
  const stored = window.localStorage.getItem("spoovault-ecosystem");
  return stored === "stellar" ? "stellar" : "avalanche";
};

export const subscribeToQueue = (listener: QueueListener): (() => void) => {
  listeners.add(listener);
  listener(lastKnownState);
  return () => listeners.delete(listener);
};

const emitState = async (): Promise<void> => {
  try {
    const counts = await countActionsByStatus();
    lastKnownState = { ...counts, online: isOnline() };
    listeners.forEach((listener) => {
      try {
        listener(lastKnownState);
      } catch {
        // never let a UI subscriber break the queue
      }
    });
  } catch {
    // storage unavailable — keep previous state
  }
};

/**
 * Ask the service worker to register the background sync tag. When the
 * browser later regains connectivity it fires the `sync` event even if the
 * app has been backgrounded, and our Workbox handler wakes the page to drain
 * the queue. Returns true when Background Sync is supported and registered.
 */
export const registerBackgroundSync = async (): Promise<boolean> => {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) {
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    type SyncManagerLike = { register: (tag: string) => Promise<void> };
    const syncManager = (
      registration as ServiceWorkerRegistration & { sync?: SyncManagerLike }
    ).sync;

    if (!syncManager) {
      return false;
    }

    await syncManager.register(SYNC_TAG);

    // Belt-and-braces: also ask the worker itself to register so the tag
    // survives even if this page is closed immediately afterwards.
    try {
      const worker = registration.active;
      worker?.postMessage({ type: MSG_REGISTER_SYNC });
    } catch {
      // posting is best-effort only
    }

    return true;
  } catch {
    return false;
  }
};

export const enqueueAction = async <K extends keyof ActionPayloadMap>(
  kind: K,
  payload: ActionPayloadMap[K],
  options?: { label?: string }
): Promise<PendingActionRecord> => {
  const timestamp = Date.now();
  const record = await insertAction({
    kind,
    label:
      options?.label ??
      kind
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" "),
    payload,
    status: "pending",
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    network: getEcosystem(),
  });

  await emitState();
  void registerBackgroundSync();
  return record;
};

export const getQueuedActions = (): Promise<PendingActionRecord[]> =>
  listActionsByStatus(["pending", "processing"]);

export const getFailedActions = (): Promise<PendingActionRecord[]> =>
  listActionsByStatus(["failed"]);

export const getQueueCounts = async (): Promise<QueueState> => {
  const counts = await countActionsByStatus();
  return { ...counts, online: isOnline() };
};

export const hasPendingActions = async (): Promise<boolean> => {
  const pending = await getQueuedActions();
  return pending.length > 0;
};

export const setActionStatus = async (
  id: number,
  status: PendingActionStatus,
  options?: { error?: unknown; attempts?: number }
): Promise<void> => {
  await updateAction(id, {
    status,
    updatedAt: Date.now(),
    ...(options?.attempts !== undefined ? { attempts: options.attempts } : {}),
    ...(options?.error
      ? {
          lastError: (
            (options.error as Error)?.message ?? String(options.error)
          ).slice(0, 500),
        }
      : {}),
  });
  await emitState();
};

/** Refresh counts + online flag without mutating records (used on/offline events). */
export const refreshQueueState = (): Promise<void> => emitState();
