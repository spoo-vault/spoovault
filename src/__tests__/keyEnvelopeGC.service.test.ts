import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isRequestExpiredOrRejected,
  unpinEnvelopesForRequest,
  evaluateAndCleanupDoc,
  runGarbageCollection,
  keyEnvelopeGCService,
} from "../services/keyEnvelopeGC.service";
import { keyInboxService } from "../services/keyInbox.service";
import { contractService } from "../services/contract.service";
import * as telemetryService from "../services/telemetry.service";

vi.mock("../services/keyInbox.service", () => ({
  keyInboxService: {
    isConfigured: vi.fn(),
    hashAddress: vi.fn((addr: string) => `hash_${addr.toLowerCase()}`),
    unpinKeyEnvelope: vi.fn(),
    listAllKeyEnvelopes: vi.fn(),
    findEnvelopeHashesForBeneficiaryAndDoc: vi.fn(),
    unpinEnvelopesForBeneficiaryAndDoc: vi.fn(),
  },
}));

vi.mock("../services/contract.service", () => ({
  contractService: {
    getLatestRequestsForUser: vi.fn(),
  },
}));

vi.mock("../services/telemetry.service", () => ({
  captureTelemetry: vi.fn(),
  captureError: vi.fn(),
}));

describe("KeyEnvelopeGCService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isRequestExpiredOrRejected", () => {
    const now = 1700000000;

    it("returns false for null or undefined request", () => {
      expect(isRequestExpiredOrRejected(null, now)).toBe(false);
      expect(isRequestExpiredOrRejected(undefined, now)).toBe(false);
    });

    it("returns true for status 2 (REJECTED)", () => {
      expect(
        isRequestExpiredOrRejected(
          {
            requestId: 1,
            documentId: 5,
            requester: "0xabc",
            status: 2,
            expiresAt: now + 1000,
            createdAt: now - 1000,
          },
          now
        )
      ).toBe(true);
    });

    it("returns true for status 3 (EXPIRED)", () => {
      expect(
        isRequestExpiredOrRejected(
          {
            requestId: 1,
            documentId: 5,
            requester: "0xabc",
            status: 3,
            expiresAt: now + 1000,
            createdAt: now - 1000,
          },
          now
        )
      ).toBe(true);
    });

    it("returns true for status 0 (PENDING) when expiresAt <= now", () => {
      expect(
        isRequestExpiredOrRejected(
          {
            requestId: 1,
            documentId: 5,
            requester: "0xabc",
            status: 0,
            expiresAt: now,
            createdAt: now - 1000,
          },
          now
        )
      ).toBe(true);

      expect(
        isRequestExpiredOrRejected(
          {
            requestId: 1,
            documentId: 5,
            requester: "0xabc",
            status: 0,
            expiresAt: now - 500,
            createdAt: now - 1000,
          },
          now
        )
      ).toBe(true);
    });

    it("returns false for status 0 (PENDING) when expiresAt > now", () => {
      expect(
        isRequestExpiredOrRejected(
          {
            requestId: 1,
            documentId: 5,
            requester: "0xabc",
            status: 0,
            expiresAt: now + 500,
            createdAt: now - 500,
          },
          now
        )
      ).toBe(false);
    });

    it("returns false for status 1 (APPROVED)", () => {
      expect(
        isRequestExpiredOrRejected(
          {
            requestId: 1,
            documentId: 5,
            requester: "0xabc",
            status: 1,
            expiresAt: now - 1000,
            createdAt: now - 2000,
          },
          now
        )
      ).toBe(false);
    });
  });

  describe("unpinEnvelopesForRequest", () => {
    it("returns skipped when params are invalid", async () => {
      const res = await unpinEnvelopesForRequest({
        documentId: 0,
        beneficiary: "",
      });
      expect(res.skipped).toBe(true);
      expect(res.reason).toBe("invalid_params");
    });

    it("returns skipped when IPFS is not configured", async () => {
      vi.mocked(keyInboxService.isConfigured).mockReturnValue(false);
      const res = await unpinEnvelopesForRequest({
        documentId: 5,
        beneficiary: "0xBeneficiary",
      });
      expect(res.skipped).toBe(true);
      expect(res.reason).toBe("ipfs_not_configured");
    });

    it("unpins matching envelopes and logs telemetry", async () => {
      vi.mocked(keyInboxService.isConfigured).mockReturnValue(true);
      vi.mocked(
        keyInboxService.unpinEnvelopesForBeneficiaryAndDoc
      ).mockResolvedValueOnce({
        unpinned: ["QmHash1", "QmHash2"],
        failed: [],
      });

      const res = await unpinEnvelopesForRequest({
        documentId: 5,
        beneficiary: "0xBeneficiary",
        reason: "request_expired",
      });

      expect(res.unpinned).toEqual(["QmHash1", "QmHash2"]);
      expect(res.failed).toEqual([]);
      expect(telemetryService.captureTelemetry).toHaveBeenCalledWith(
        "info",
        "ipfs.unpin.gc",
        expect.stringContaining("Unpinned 2 key envelope(s) for Document #5"),
        expect.objectContaining({
          documentId: 5,
          unpinnedCount: 2,
          reason: "request_expired",
        })
      );
    });

    it("handles partial failure and logs error telemetry", async () => {
      vi.mocked(keyInboxService.isConfigured).mockReturnValue(true);
      vi.mocked(
        keyInboxService.unpinEnvelopesForBeneficiaryAndDoc
      ).mockResolvedValueOnce({
        unpinned: ["QmHash1"],
        failed: ["QmFailHash"],
      });

      const res = await unpinEnvelopesForRequest({
        documentId: 5,
        beneficiary: "0xBeneficiary",
      });

      expect(res.unpinned).toEqual(["QmHash1"]);
      expect(res.failed).toEqual(["QmFailHash"]);
      expect(telemetryService.captureError).toHaveBeenCalledWith(
        "ipfs.unpin.gc.failed",
        expect.stringContaining("Failed to unpin 1 key envelope(s)"),
        expect.anything()
      );
    });

    it("catches thrown exceptions during unpinning", async () => {
      vi.mocked(keyInboxService.isConfigured).mockReturnValue(true);
      vi.mocked(
        keyInboxService.unpinEnvelopesForBeneficiaryAndDoc
      ).mockRejectedValueOnce(new Error("Network timeout"));

      const res = await unpinEnvelopesForRequest({
        documentId: 5,
        beneficiary: "0xBeneficiary",
      });

      expect(res.unpinned).toEqual([]);
      expect(res.reason).toBe("Network timeout");
      expect(telemetryService.captureError).toHaveBeenCalledWith(
        "ipfs.unpin.gc.error",
        expect.any(Error),
        expect.anything()
      );
    });
  });

  describe("evaluateAndCleanupDoc", () => {
    it("calls unpinEnvelopesForRequest when request is expired or rejected", async () => {
      vi.mocked(keyInboxService.isConfigured).mockReturnValue(true);
      vi.mocked(
        keyInboxService.unpinEnvelopesForBeneficiaryAndDoc
      ).mockResolvedValueOnce({
        unpinned: ["QmHash1"],
        failed: [],
      });

      const req = {
        requestId: 1,
        documentId: 5,
        requester: "0x123",
        status: 2, // REJECTED
        expiresAt: 0,
        createdAt: 0,
      };

      const result = await evaluateAndCleanupDoc(5, "0x123", req);
      expect(result).not.toBeNull();
      expect(result?.unpinned).toEqual(["QmHash1"]);
    });

    it("returns null when request is still active", async () => {
      const req = {
        requestId: 1,
        documentId: 5,
        requester: "0x123",
        status: 1, // APPROVED
        expiresAt: 0,
        createdAt: 0,
      };

      const result = await evaluateAndCleanupDoc(5, "0x123", req);
      expect(result).toBeNull();
    });
  });

  describe("runGarbageCollection", () => {
    it("returns empty report when IPFS is not configured", async () => {
      vi.mocked(keyInboxService.isConfigured).mockReturnValue(false);
      const report = await runGarbageCollection();
      expect(report.scannedCount).toBe(0);
      expect(report.unpinnedCount).toBe(0);
    });

    it("runs scoped GC for a specific account and documentIds", async () => {
      vi.mocked(keyInboxService.isConfigured).mockReturnValue(true);
      vi.mocked(contractService.getLatestRequestsForUser).mockResolvedValueOnce(
        {
          10: {
            requestId: 1,
            documentId: 10,
            requester: "0xAccount",
            status: 2, // REJECTED
            expiresAt: 0,
            createdAt: 0,
          },
          20: {
            requestId: 2,
            documentId: 20,
            requester: "0xAccount",
            status: 1, // APPROVED
            expiresAt: 0,
            createdAt: 0,
          },
        }
      );

      vi.mocked(
        keyInboxService.findEnvelopeHashesForBeneficiaryAndDoc
      ).mockResolvedValueOnce(["QmExpiredEnvelope"]);
      vi.mocked(keyInboxService.unpinKeyEnvelope).mockResolvedValueOnce(true);

      const report = await runGarbageCollection({
        account: "0xAccount",
        documentIds: [10, 20],
      });

      expect(report.scannedCount).toBe(2);
      expect(report.unpinnedCount).toBe(1);
      expect(report.unpinnedHashes).toEqual(["QmExpiredEnvelope"]);
      expect(keyInboxService.unpinKeyEnvelope).toHaveBeenCalledWith(
        "QmExpiredEnvelope"
      );
      expect(telemetryService.captureTelemetry).toHaveBeenCalledWith(
        "info",
        "ipfs.unpin.gc.sweep",
        expect.stringContaining(
          "Garbage collector swept 1 expired key envelope(s)"
        ),
        expect.anything()
      );
    });

    it("runs scoped GC in dryRun mode without calling unpinKeyEnvelope", async () => {
      vi.mocked(keyInboxService.isConfigured).mockReturnValue(true);
      vi.mocked(contractService.getLatestRequestsForUser).mockResolvedValueOnce(
        {
          10: {
            requestId: 1,
            documentId: 10,
            requester: "0xAccount",
            status: 2,
            expiresAt: 0,
            createdAt: 0,
          },
        }
      );
      vi.mocked(
        keyInboxService.findEnvelopeHashesForBeneficiaryAndDoc
      ).mockResolvedValueOnce(["QmExpiredDryRun"]);

      const report = await runGarbageCollection({
        account: "0xAccount",
        documentIds: [10],
        dryRun: true,
      });

      expect(report.dryRun).toBe(true);
      expect(report.unpinnedHashes).toEqual(["QmExpiredDryRun"]);
      expect(keyInboxService.unpinKeyEnvelope).not.toHaveBeenCalled();
    });

    it("handles unpin error during scoped GC", async () => {
      vi.mocked(keyInboxService.isConfigured).mockReturnValue(true);
      vi.mocked(contractService.getLatestRequestsForUser).mockResolvedValueOnce(
        {
          10: {
            requestId: 1,
            documentId: 10,
            requester: "0xAccount",
            status: 3,
            expiresAt: 0,
            createdAt: 0,
          },
        }
      );
      vi.mocked(
        keyInboxService.findEnvelopeHashesForBeneficiaryAndDoc
      ).mockResolvedValueOnce(["QmFailingHash"]);
      vi.mocked(keyInboxService.unpinKeyEnvelope).mockRejectedValueOnce(
        new Error("Pinata 500")
      );

      const report = await runGarbageCollection({
        account: "0xAccount",
        documentIds: [10],
      });

      expect(report.unpinnedCount).toBe(0);
      expect(report.failedHashes).toEqual(["QmFailingHash"]);
    });

    it("runs full GC sweep when no account is specified", async () => {
      vi.mocked(keyInboxService.isConfigured).mockReturnValue(true);
      const oldDate = new Date(
        Date.now() - 40 * 24 * 60 * 60 * 1000
      ).toISOString();
      const recentDate = new Date().toISOString();

      vi.mocked(keyInboxService.listAllKeyEnvelopes).mockResolvedValueOnce([
        {
          hash: "QmOldEnvelope",
          row: {
            ipfs_pin_hash: "QmOldEnvelope",
            metadata: {
              keyvalues: {
                documentId: "5",
                issuedAt: oldDate,
              },
            },
          },
        },
        {
          hash: "QmRecentEnvelope",
          row: {
            ipfs_pin_hash: "QmRecentEnvelope",
            metadata: {
              keyvalues: {
                documentId: "6",
                issuedAt: recentDate,
              },
            },
          },
        },
        {
          hash: "QmInvalidDocEnvelope",
          row: {
            ipfs_pin_hash: "QmInvalidDocEnvelope",
            metadata: {
              keyvalues: {
                documentId: "not-a-number",
              },
            },
          },
        },
      ]);
      vi.mocked(keyInboxService.unpinKeyEnvelope).mockResolvedValue(true);

      const report = await runGarbageCollection();
      expect(report.scannedCount).toBe(3);
      expect(report.unpinnedHashes).toContain("QmOldEnvelope");
      expect(report.unpinnedHashes).toContain("QmInvalidDocEnvelope");
      expect(report.unpinnedHashes).not.toContain("QmRecentEnvelope");
    });

    it("runs full GC sweep in dryRun mode", async () => {
      vi.mocked(keyInboxService.isConfigured).mockReturnValue(true);
      const oldDate = new Date(
        Date.now() - 40 * 24 * 60 * 60 * 1000
      ).toISOString();

      vi.mocked(keyInboxService.listAllKeyEnvelopes).mockResolvedValueOnce([
        {
          hash: "QmOldEnvelopeDryRun",
          row: {
            ipfs_pin_hash: "QmOldEnvelopeDryRun",
            metadata: {
              keyvalues: {
                documentId: "5",
                issuedAt: oldDate,
              },
            },
          },
        },
        {
          hash: "QmInvalidDocDryRun",
          row: {
            ipfs_pin_hash: "QmInvalidDocDryRun",
            metadata: {
              keyvalues: {
                documentId: "invalid",
              },
            },
          },
        },
      ]);

      const report = await runGarbageCollection({ dryRun: true });
      expect(report.dryRun).toBe(true);
      expect(report.unpinnedHashes).toEqual([
        "QmOldEnvelopeDryRun",
        "QmInvalidDocDryRun",
      ]);
      expect(keyInboxService.unpinKeyEnvelope).not.toHaveBeenCalled();
    });

    it("handles error during unpin in full GC sweep", async () => {
      vi.mocked(keyInboxService.isConfigured).mockReturnValue(true);
      const oldDate = new Date(
        Date.now() - 40 * 24 * 60 * 60 * 1000
      ).toISOString();

      vi.mocked(keyInboxService.listAllKeyEnvelopes).mockResolvedValueOnce([
        {
          hash: "QmOldEnvelopeFail",
          row: {
            ipfs_pin_hash: "QmOldEnvelopeFail",
            metadata: {
              keyvalues: {
                documentId: "5",
                issuedAt: oldDate,
              },
            },
          },
        },
        {
          hash: "QmInvalidEnvelopeFail",
          row: {
            ipfs_pin_hash: "QmInvalidEnvelopeFail",
            metadata: {
              keyvalues: {
                documentId: "invalid",
              },
            },
          },
        },
      ]);
      vi.mocked(keyInboxService.unpinKeyEnvelope).mockRejectedValue(
        new Error("Pinata error")
      );

      const report = await runGarbageCollection();
      expect(report.failedHashes).toEqual([
        "QmOldEnvelopeFail",
        "QmInvalidEnvelopeFail",
      ]);
      expect(report.unpinnedCount).toBe(0);
    });

    it("handles global sweep failure cleanly", async () => {
      vi.mocked(keyInboxService.isConfigured).mockReturnValue(true);
      vi.mocked(keyInboxService.listAllKeyEnvelopes).mockRejectedValueOnce(
        new Error("Fatal IPFS proxy failure")
      );

      const report = await runGarbageCollection();
      expect(report.scannedCount).toBe(0);
      expect(report.unpinnedCount).toBe(0);
      expect(telemetryService.captureError).toHaveBeenCalledWith(
        "ipfs.unpin.gc.sweep.error",
        expect.any(Error)
      );
    });

    it("handles account provided with empty documentIds", async () => {
      vi.mocked(keyInboxService.isConfigured).mockReturnValue(true);
      const report = await runGarbageCollection({
        account: "0xUser",
        documentIds: [],
      });
      expect(report.scannedCount).toBe(0);
      expect(report.unpinnedCount).toBe(0);
    });
  });

  describe("keyEnvelopeGCService export", () => {
    it("exports all required methods", () => {
      expect(keyEnvelopeGCService.isRequestExpiredOrRejected).toBeDefined();
      expect(keyEnvelopeGCService.unpinEnvelopesForRequest).toBeDefined();
      expect(keyEnvelopeGCService.evaluateAndCleanupDoc).toBeDefined();
      expect(keyEnvelopeGCService.runGarbageCollection).toBeDefined();
    });
  });
});
