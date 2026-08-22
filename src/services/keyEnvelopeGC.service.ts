import { contractService, AccessRequestData } from "./contract.service";
import { keyInboxService } from "./keyInbox.service";
import { captureError, captureTelemetry } from "./telemetry.service";

export interface KeyEnvelopeGCReport {
  scannedCount: number;
  unpinnedCount: number;
  unpinnedHashes: string[];
  failedHashes: string[];
  dryRun?: boolean;
  timestamp: string;
}

export interface UnpinRequestResult {
  unpinned: string[];
  failed: string[];
  skipped?: boolean;
  reason?: string;
}

/**
 * Checks whether an access request is expired or rejected.
 * Status values:
 * 0: PENDING (expired if expiresAt <= now)
 * 1: APPROVED
 * 2: REJECTED
 * 3: EXPIRED
 */
export const isRequestExpiredOrRejected = (
  request: AccessRequestData | null | undefined,
  nowSec: number = Math.floor(Date.now() / 1000)
): boolean => {
  if (!request) {
    return false;
  }
  if (request.status === 2 || request.status === 3) {
    return true;
  }
  if (
    request.status === 0 &&
    Number.isFinite(request.expiresAt) &&
    request.expiresAt <= nowSec
  ) {
    return true;
  }
  return false;
};

/**
 * Unpins all IPFS key envelopes matching a beneficiary and documentId when
 * an access request is expired or rejected.
 */
export const unpinEnvelopesForRequest = async (params: {
  documentId: number;
  beneficiary: string;
  reason?: string;
}): Promise<UnpinRequestResult> => {
  const {
    documentId,
    beneficiary,
    reason = "request_expired_or_rejected",
  } = params;

  if (!beneficiary || !documentId || !Number.isFinite(documentId)) {
    return {
      unpinned: [],
      failed: [],
      skipped: true,
      reason: "invalid_params",
    };
  }

  if (!keyInboxService.isConfigured()) {
    return {
      unpinned: [],
      failed: [],
      skipped: true,
      reason: "ipfs_not_configured",
    };
  }

  try {
    const { unpinned, failed } =
      await keyInboxService.unpinEnvelopesForBeneficiaryAndDoc(
        beneficiary,
        documentId
      );

    if (unpinned.length > 0) {
      captureTelemetry(
        "info",
        "ipfs.unpin.gc",
        `Unpinned ${unpinned.length} key envelope(s) for Document #${documentId} (${reason})`,
        {
          documentId,
          beneficiary: keyInboxService.hashAddress(beneficiary),
          unpinnedCount: unpinned.length,
          unpinnedHashes: unpinned,
          reason,
        }
      );
    }

    if (failed.length > 0) {
      captureError(
        "ipfs.unpin.gc.failed",
        `Failed to unpin ${failed.length} key envelope(s) for Document #${documentId}`,
        {
          documentId,
          beneficiary: keyInboxService.hashAddress(beneficiary),
          failedHashes: failed,
        }
      );
    }

    return { unpinned, failed };
  } catch (error: any) {
    captureError("ipfs.unpin.gc.error", error, {
      documentId,
      beneficiary: keyInboxService.hashAddress(beneficiary),
    });
    return {
      unpinned: [],
      failed: [],
      skipped: false,
      reason: error?.message || "unpin_error",
    };
  }
};

/**
 * Evaluates an on-chain access request state and triggers automated unpinning if
 * the request is in expired or rejected status.
 */
export const evaluateAndCleanupDoc = async (
  documentId: number,
  beneficiary: string,
  request: AccessRequestData | null
): Promise<UnpinRequestResult | null> => {
  if (isRequestExpiredOrRejected(request)) {
    const reason =
      request?.status === 2 ? "request_rejected" : "request_expired";
    return unpinEnvelopesForRequest({ documentId, beneficiary, reason });
  }
  return null;
};

/**
 * Scans key envelopes and cleans up any envelopes associated with expired or rejected requests.
 */
export const runGarbageCollection = async (options?: {
  account?: string;
  documentIds?: number[];
  dryRun?: boolean;
}): Promise<KeyEnvelopeGCReport> => {
  const timestamp = new Date().toISOString();
  const dryRun = options?.dryRun === true;

  if (!keyInboxService.isConfigured()) {
    return {
      scannedCount: 0,
      unpinnedCount: 0,
      unpinnedHashes: [],
      failedHashes: [],
      dryRun,
      timestamp,
    };
  }

  const unpinnedHashes: string[] = [];
  const failedHashes: string[] = [];
  let scannedCount = 0;

  try {
    if (options?.account) {
      const account = options.account;
      const docIds = options.documentIds || [];

      if (docIds.length > 0) {
        const latestRequests = await contractService.getLatestRequestsForUser(
          account,
          docIds
        );
        for (const docId of docIds) {
          const req = latestRequests[docId] ?? null;
          scannedCount += 1;
          if (isRequestExpiredOrRejected(req)) {
            const hashes =
              await keyInboxService.findEnvelopeHashesForBeneficiaryAndDoc(
                account,
                docId
              );
            for (const hash of hashes) {
              if (dryRun) {
                unpinnedHashes.push(hash);
              } else {
                try {
                  await keyInboxService.unpinKeyEnvelope(hash);
                  unpinnedHashes.push(hash);
                } catch {
                  failedHashes.push(hash);
                }
              }
            }
          }
        }
      }
    } else {
      const allEnvelopes = await keyInboxService.listAllKeyEnvelopes({
        limit: 100,
      });
      scannedCount = allEnvelopes.length;

      for (const item of allEnvelopes) {
        const hash = item.hash;
        const keyvalues = item.row.metadata?.keyvalues || {};
        const documentId = Number(keyvalues.documentId);
        const issuedAtStr = String(keyvalues.issuedAt || "");
        const issuedAtTs = Date.parse(issuedAtStr);

        // If envelope is malformed or invalid documentId, candidate for unpin
        if (!documentId || !Number.isFinite(documentId)) {
          if (!dryRun) {
            try {
              await keyInboxService.unpinKeyEnvelope(hash);
              unpinnedHashes.push(hash);
            } catch {
              failedHashes.push(hash);
            }
          } else {
            unpinnedHashes.push(hash);
          }
          continue;
        }

        // If issuedAt is older than 30 days and not active, or unpinned candidate
        const now = Date.now();
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
        if (Number.isFinite(issuedAtTs) && now - issuedAtTs > thirtyDaysMs) {
          if (!dryRun) {
            try {
              await keyInboxService.unpinKeyEnvelope(hash);
              unpinnedHashes.push(hash);
            } catch {
              failedHashes.push(hash);
            }
          } else {
            unpinnedHashes.push(hash);
          }
        }
      }
    }

    if (unpinnedHashes.length > 0 && !dryRun) {
      captureTelemetry(
        "info",
        "ipfs.unpin.gc.sweep",
        `Garbage collector swept ${unpinnedHashes.length} expired key envelope(s)`,
        {
          scannedCount,
          unpinnedCount: unpinnedHashes.length,
          failedCount: failedHashes.length,
        }
      );
    }
  } catch (error: any) {
    captureError("ipfs.unpin.gc.sweep.error", error);
  }

  return {
    scannedCount,
    unpinnedCount: unpinnedHashes.length,
    unpinnedHashes,
    failedHashes,
    dryRun,
    timestamp,
  };
};

export const keyEnvelopeGCService = {
  isRequestExpiredOrRejected,
  unpinEnvelopesForRequest,
  evaluateAndCleanupDoc,
  runGarbageCollection,
};
