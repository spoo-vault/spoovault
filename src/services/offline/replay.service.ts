import { contractService } from "../contract.service";
import { ipfsService } from "../../services/ipfs.service";
import { keyStoreService } from "../keyStore.service";
import { clientKeyringService } from "../clientKeyring.service";
import { decryptWithPrivateKey } from "../../utils/crypto";
import {
  listActionsByStatus,
  type PendingActionRecord,
} from "./db";
import { isNetworkFailure } from "./offlineCache.service";
import {
  getQueuedActions,
  setActionStatus,
  subscribeToQueue,
  type AddDocumentPayload,
  type CreateDocumentDraftPayload,
  type CreateVaultPayload,
  type RegisterPublicKeyPayload,
  type RequestAccessPayload,
} from "./offlineQueue.service";

type ActionExecutor = (
  payload: unknown,
  record: PendingActionRecord
) => Promise<void>;

const replayCreateVault: ActionExecutor = async (payload) => {
  const args = payload as CreateVaultPayload;
  const vaultId = await contractService.createVault(
    args.name,
    args.description,
    args.guardians,
    args.approvalThreshold
  );
  if (!vaultId) {
    throw new Error("Vault creation transaction did not return a vault id");
  }
};

const base64ToFile = (
  base64: string,
  fileName: string,
  fileType: string
): File => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], fileName, { type: fileType || "application/octet-stream" });
};

/**
 * Full offline draft reconciliation: decrypt the locally stored document key,
 * pin the encrypted payload to IPFS, register the document on-chain, and only
 * then persist the decryption key for the newly minted document id.
 */
const replayCreateDocumentDraft: ActionExecutor = async (payload) => {
  const draft = payload as CreateDocumentDraftPayload;

  if (!ipfsService.isConfigured()) {
    throw new Error("IPFS is not configured — cannot sync offline draft");
  }

  const privateKey = await clientKeyringService.getDecryptedPrivateKey(
    draft.account
  );
  const documentKey = await decryptWithPrivateKey(
    draft.encryptedDocKey,
    privateKey
  );

  const file = base64ToFile(
    draft.encryptedFileBase64,
    draft.fileName,
    draft.fileType
  );
  const ipfsResult = await ipfsService.uploadFile(file, {
    name: draft.fileName,
  });

  const documentId = await contractService.addDocument(
    draft.vaultId,
    draft.encryptedMetadata,
    ipfsResult.hash,
    draft.requiredAccess,
    draft.releaseCondition ?? 0,
    draft.guardiansList,
    draft.shares
  );

  if (!documentId) {
    throw new Error("Document sync did not return a document id");
  }

  keyStoreService.set(documentId, documentKey);
};

const replayAddDocument: ActionExecutor = async (payload) => {
  const args = payload as AddDocumentPayload;
  const documentId = await contractService.addDocument(
    args.vaultId,
    args.encryptedMetadata,
    args.ipfsHash,
    args.requiredAccess,
    args.releaseCondition ?? 0,
    args.guardiansList,
    args.shares
  );
  if (!documentId) {
    throw new Error("Document transaction did not return a document id");
  }
};

const replayRegisterPublicKey: ActionExecutor = async (payload) => {
  const args = payload as RegisterPublicKeyPayload;
  await contractService.registerPublicKey(args.publicKey);
};

const replayRequestAccess: ActionExecutor = async (payload) => {
  const args = payload as RequestAccessPayload;
  const requestId = await contractService.requestAccess(args.documentId);
  if (!requestId) {
    throw new Error("Access request transaction did not return a request id");
  }
};

const executors: Record<string, ActionExecutor> = {
  "create-vault": replayCreateVault,
  "create-document-draft": replayCreateDocumentDraft,
  "add-document": replayAddDocument,
  "register-public-key": replayRegisterPublicKey,
  "request-access": replayRequestAccess,
};

export interface ReplaySummary {
  attempted: number;
  synced: number;
  failed: number;
  remaining: number;
  stoppedForOffline: boolean;
}

export interface ReplayEventListener {
  (event:
    | { type: "replay-start"; total: number }
    | { type: "action-synced"; record: PendingActionRecord }
    | { type: "action-failed"; record: PendingActionRecord; error: unknown }
    | { type: "replay-complete"; summary: ReplaySummary }): void;
}

const replayListeners = new Set<ReplayEventListener>();

export const onReplayEvent = (listener: ReplayEventListener): (() => void) => {
  replayListeners.add(listener);
  return () => replayListeners.delete(listener);
};

const emit = (event: Parameters<ReplayEventListener>[0]): void => {
  replayListeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // UI listeners must never break reconciliation
    }
  });
};

let inflight: Promise<ReplaySummary> | null = null;

const drainQueue = async (): Promise<ReplaySummary> => {
  const summary: ReplaySummary = {
    attempted: 0,
    synced: 0,
    failed: 0,
    remaining: 0,
    stoppedForOffline: false,
  };

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    summary.stoppedForOffline = true;
    return summary;
  }

  const pending = await listActionsByStatus(["pending", "processing"]);
  if (pending.length === 0) {
    return summary;
  }

  emit({ type: "replay-start", total: pending.length });

  for (const record of pending) {
    const executor = executors[record.kind];
    if (!executor) {
      const unknownKindError = new Error(`Unknown action kind: ${record.kind}`);
      await setActionStatus(record.id!, "failed", {
        error: unknownKindError,
        attempts: record.attempts + 1,
      });
      summary.failed += 1;
      summary.attempted += 1;
      emit({ type: "action-failed", record, error: unknownKindError });
      continue;
    }

    await setActionStatus(record.id!, "processing", { attempts: record.attempts });

    try {
      await executor(record.payload, record);
      await setActionStatus(record.id!, "synced", {
        attempts: record.attempts + 1,
      });
      summary.synced += 1;
      emit({ type: "action-synced", record });
    } catch (error) {
      if (isNetworkFailure(error)) {
        // Connectivity dropped mid-replay: put the action back in the pending
        // queue and stop draining. It will be retried on the next reconnect.
        await setActionStatus(record.id!, "pending", {
          attempts: record.attempts + 1,
          error,
        });
        summary.stoppedForOffline = true;
        break;
      }

      await setActionStatus(record.id!, "failed", {
        attempts: record.attempts + 1,
        error,
      });
      summary.failed += 1;
      emit({ type: "action-failed", record, error });
    }

    summary.attempted += 1;
  }

  summary.remaining = Math.max(
    0,
    pending.length - summary.synced - summary.failed
  );

  emit({ type: "replay-complete", summary });
  return summary;
};

/**
 * Drain the offline action queue exactly once per invocation (single-flight).
 * Called when connectivity returns via the `online` event or the service
 * worker's background sync broadcast.
 */
export const replayPendingActions = (): Promise<ReplaySummary> => {
  if (inflight) {
    return inflight;
  }

  inflight = drainQueue().finally(() => {
    inflight = null;
  });
  return inflight;
};

/** Convenience for UI badges. */
export const watchPendingActions = (
  listener: (records: PendingActionRecord[]) => void
): (() => void) => {
  let active = true;
  const push = async () => {
    if (!active) return;
    listener(await getQueuedActions());
  };
  const unsubscribe = subscribeToQueue(() => void push());
  void push();
  return () => {
    active = false;
    unsubscribe();
  };
};
