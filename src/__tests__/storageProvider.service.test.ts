import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../services/ipfs.service", () => {
  const fetchFile = vi.fn();
  return {
    ipfsService: {
      isConfigured: vi.fn(() => true),
      getURL: vi.fn((hash: string) => `https://gateway.pinata.cloud/ipfs/${hash}`),
      getGatewayPool: vi.fn(() => ["https://gateway.pinata.cloud/ipfs/"]),
      fetchFile,
      // fetchDocument routes through fetchFileWithPIR (PIR-aware; a no-op
      // passthrough to fetchFile when PIR is disabled). Delegating to the
      // same fetchFile mock keeps every existing fetchFile-based test valid
      // unchanged; tests that care about PIR-specific behavior (decoyCids)
      // assert on fetchFileWithPIR directly instead.
      fetchFileWithPIR: vi.fn((hash: string, init?: RequestInit) => fetchFile(hash, init)),
      uploadFile: vi.fn(),
      uploadStream: vi.fn(),
      unpin: vi.fn(),
    },
  };
});

import {
  BACKUP_REFS_STORAGE_KEY,
  DEFAULT_BACKUP_PROVIDERS,
  StorageProviderFetchError,
  createStorageProviderService,
} from "../services/storageProvider.service";
import { ipfsService } from "../services/ipfs.service";

type Env = Record<string, string | undefined>;
const env = (): Env => import.meta.env as unknown as Env;

const TEST_KEY_HEX = "ab".repeat(32);
const PLAINTEXT = new TextEncoder().encode("permanent vault backup payload");

const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = { "Content-Type": "application/json" }
): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });

interface MemoryRefStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  read: (key: string) => unknown;
}

const makeRefStore = (): MemoryRefStore => {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    read: (key) => {
      const raw = map.get(key);
      return raw ? JSON.parse(raw) : undefined;
    },
  };
};

const makeService = (
  overrides: Parameters<typeof createStorageProviderService>[0] = {}
) => {
  const fetchMock = vi.fn();
  const refStore = makeRefStore();
  const service = createStorageProviderService({
    lighthouseApiKey: "lh-test-key",
    fetchFn: fetchMock as unknown as typeof fetch,
    refStore: refStore as unknown as Storage,
    ...overrides,
  });
  return { service, fetchMock, refStore };
};

describe("StorageProviderService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete env().VITE_LIGHTHOUSE_API_KEY;
    delete env().VITE_BACKUP_STORAGE_PROVIDERS;
    delete env().VITE_ARWEAVE_NODE_URL;
    delete env().VITE_LIGHTHOUSE_GATEWAY_URL;
    delete env().VITE_ARWEAVE_GATEWAY_URL;
  });

  describe("provider configuration", () => {
    it("reports filecoin configured only when a Lighthouse API key is available", async () => {
      const { service } = makeService({ lighthouseApiKey: "" });
      expect(service.isConfigured("filecoin")).toBe(false);

      const { service: configured } = makeService();
      expect(configured.isConfigured("filecoin")).toBe(true);
    });

    it("reads the Lighthouse key from the environment lazily", async () => {
      const { service } = makeService({ lighthouseApiKey: undefined });
      expect(service.isConfigured("filecoin")).toBe(false);
      env().VITE_LIGHTHOUSE_API_KEY = "env-lh-key";
      expect(service.isConfigured("filecoin")).toBe(true);
    });

    it("treats arweave as always available through the default Irys node", async () => {
      const { service } = makeService({ lighthouseApiKey: "" });
      expect(service.isConfigured("arweave")).toBe(true);
    });

    it("lists ipfs first followed by the permanent backup providers", async () => {
      const { service } = makeService();
      expect(service.listProviders()).toEqual(["ipfs", "filecoin", "arweave"]);
    });

    it("getBackupProviders skips providers that are not configured", async () => {
      const { service } = makeService({ lighthouseApiKey: "" });
      expect(service.getBackupProviders()).toEqual(["arweave"]);
    });

    it("getBackupProviders honors the VITE_BACKUP_STORAGE_PROVIDERS override", async () => {
      env().VITE_BACKUP_STORAGE_PROVIDERS = "arweave, bogus , Filecoin";
      const { service } = makeService();
      expect(service.getBackupProviders()).toEqual(["arweave", "filecoin"]);
    });

    it("getBackupProviders respects a restricted explicit list", async () => {
      const { service } = makeService({ backupProviders: ["arweave"] });
      expect(service.getBackupProviders()).toEqual(["arweave"]);
    });
  });

  describe("uploadToProvider", () => {
    it("uploads to Lighthouse with bearer auth and returns the Filecoin CID", async () => {
      const { service, fetchMock } = makeService();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ Name: "doc.svsc", Hash: "bafy-filecoin-cid", Size: 42 })
      );

      const result = await service.uploadToProvider(
        "filecoin",
        PLAINTEXT,
        "doc.svsc"
      );

      expect(result).toEqual({
        provider: "filecoin",
        reference: "bafy-filecoin-cid",
        size: 42,
        permanent: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://upload.lighthouse.storage/api/v0/upload");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer lh-test-key");
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).get("file")).toBeTruthy();
    });

    it("throws a descriptive error when the Filecoin upload fails", async () => {
      const { service, fetchMock } = makeService();
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "nope" }, 500));

      await expect(
        service.uploadToProvider("filecoin", PLAINTEXT, "doc.svsc")
      ).rejects.toThrow(/Filecoin upload failed \(500\)/);
    });

    it("uploads raw bytes to the Irys node and parses the transaction id", async () => {
      const { service, fetchMock } = makeService();
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: "arweave-tx-123" }));

      const result = await service.uploadToProvider(
        "arweave",
        PLAINTEXT,
        "doc.svsc"
      );

      expect(result).toEqual({
        provider: "arweave",
        reference: "arweave-tx-123",
        size: PLAINTEXT.byteLength,
        permanent: true,
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://node2.irys.xyz/tx");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/octet-stream");
    });

    it("accepts plain-text transaction ids from the Arweave node", async () => {
      const { service, fetchMock } = makeService();
      fetchMock.mockResolvedValueOnce(new Response("plaintext-tx-id\n"));

      const result = await service.uploadToProvider(
        "arweave",
        PLAINTEXT,
        "doc.svsc"
      );
      expect(result.reference).toBe("plaintext-tx-id");
    });

    it("uses VITE_ARWEAVE_NODE_URL when provided", async () => {
      env().VITE_ARWEAVE_NODE_URL = "https://custom.irys.node/";
      const { service, fetchMock } = makeService();
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: "tx-1" }));

      await service.uploadToProvider("arweave", PLAINTEXT, "doc.svsc");

      expect(fetchMock.mock.calls[0][0]).toBe("https://custom.irys.node/tx");
    });

    it("rejects uploads targeting the primary provider via the adapter", async () => {
      const { service } = makeService();
      await expect(
        service.uploadToProvider("ipfs", PLAINTEXT, "doc.svsc")
      ).rejects.toThrow(/primary IPFS pin/);
    });
  });

  describe("backupDocument (automated fallback upload)", () => {
    it("replicates ciphertext to every configured secondary provider and records references", async () => {
      const { service, fetchMock, refStore } = makeService();
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ Hash: "bafy-fc-copy", Size: PLAINTEXT.byteLength })
        )
        .mockResolvedValueOnce(jsonResponse({ id: "ar-tx-copy" }));

      const report = await service.backupDocument({
        ipfsHash: "QmPrimary",
        ciphertext: PLAINTEXT,
        filename: "doc.svsc",
      });

      expect(report.backups.map((b) => b.reference)).toEqual([
        "bafy-fc-copy",
        "ar-tx-copy",
      ]);
      expect(report.failures).toEqual([]);
      expect(refStore.read(BACKUP_REFS_STORAGE_KEY)).toEqual({
        QmPrimary: { filecoin: "bafy-fc-copy", arweave: "ar-tx-copy" },
      });
    });

    it("continues replicating when one provider fails and reports the failure", async () => {
      const { service, fetchMock, refStore } = makeService();
      fetchMock
        .mockRejectedValueOnce(new Error("lighthouse down"))
        .mockResolvedValueOnce(jsonResponse({ id: "ar-tx-only" }));

      const report = await service.backupDocument({
        ipfsHash: "QmPartial",
        ciphertext: PLAINTEXT,
      });

      expect(report.backups).toHaveLength(1);
      expect(report.failures).toEqual([
        { provider: "filecoin", error: "lighthouse down" },
      ]);
      expect(refStore.read(BACKUP_REFS_STORAGE_KEY)).toEqual({
        QmPartial: { arweave: "ar-tx-only" },
      });
    });

    it("encrypts the plaintext payload before replication", async () => {
      const { service, fetchMock } = makeService();
      let uploadedBytes: Uint8Array | undefined;
      const captureUpload = async (
        _url: string,
        init?: RequestInit
      ): Promise<Response> => {
        const form = init?.body as FormData;
        const file = form.get("file") as File;
        uploadedBytes = new Uint8Array(await file.arrayBuffer());
        return jsonResponse({ Hash: "bafy-enc", Size: file.size });
      };
      fetchMock
        .mockImplementationOnce(captureUpload)
        .mockResolvedValueOnce(jsonResponse({ id: "ar-enc" }));

      await service.backupDocument({
        ipfsHash: "QmEncrypted",
        plaintext: PLAINTEXT,
        keyHex: TEST_KEY_HEX,
      });

      expect(uploadedBytes).toBeDefined();
      expect(Buffer.from(uploadedBytes!).toString()).not.toContain(
        "permanent vault"
      );
      expect(uploadedBytes!.byteLength).toBeGreaterThan(PLAINTEXT.byteLength);
    });

    it("requires either ciphertext or plaintext with a key", async () => {
      const { service } = makeService();
      await expect(
        service.backupDocument({ ipfsHash: "QmNoPayload" })
      ).rejects.toThrow(/ciphertext or plaintext\+keyHex/);
    });

    it("requires the primary ipfs hash", async () => {
      const { service } = makeService();
      await expect(
        service.backupDocument({ ipfsHash: "", ciphertext: PLAINTEXT })
      ).rejects.toThrow(/requires the primary ipfsHash/);
    });

    it("performs no uploads when no backup provider is enabled", async () => {
      const { service, fetchMock } = makeService();
      const report = await service.backupDocument({
        ipfsHash: "QmNone",
        ciphertext: PLAINTEXT,
        providers: [],
      });
      expect(report.backups).toEqual([]);
      expect(report.failures).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("respects an explicit provider list", async () => {
      const { service, fetchMock } = makeService();
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: "ar-only" }));

      const report = await service.backupDocument({
        ipfsHash: "QmArOnly",
        ciphertext: PLAINTEXT,
        providers: ["arweave"],
      });

      expect(report.backups.map((b) => b.provider)).toEqual(["arweave"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("checkProofOfStorage", () => {
    it("confirms archival when active Filecoin storage deals exist", async () => {
      const { service, fetchMock } = makeService();
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          { dealId: 91, status: "active" },
          { dealId: 92, status: "queued" },
        ])
      );

      const status = await service.checkProofOfStorage("filecoin", "bafy-deal");

      expect(status.archived).toBe(true);
      expect(status.detail).toBeUndefined();
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(
        "https://api.lighthouse.storage/api/lighthouse/get_deal_status?cid=bafy-deal"
      );
    });

    it("handles the wrapped dealInfo/data response shapes", async () => {
      const { service, fetchMock } = makeService();
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ dealInfo: [{ dealId: 5, status: "StorageActive" }] })
        )
        .mockResolvedValueOnce(
          jsonResponse({ data: [{ dealId: 6, dealStatus: "proving" }] })
        );

      expect(
        (await service.checkProofOfStorage("filecoin", "cid-a")).archived
      ).toBe(true);
      expect(
        (await service.checkProofOfStorage("filecoin", "cid-b")).archived
      ).toBe(true);
    });

    it("does not treat pending Filecoin deals as proof of permanent storage", async () => {
      const { service, fetchMock } = makeService();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          deals: [
            { dealId: 7, status: "queued" },
            { dealId: 8, dealStatus: "published" },
          ],
        })
      );

      const status = await service.checkProofOfStorage("filecoin", "bafy-pending");

      expect(status.archived).toBe(false);
      expect(status.detail).toMatch(/none are active yet/);
    });

    it("reports not archived when the CID has no Filecoin deals yet", async () => {
      const { service, fetchMock } = makeService();
      fetchMock.mockResolvedValueOnce(jsonResponse([]));

      const status = await service.checkProofOfStorage("filecoin", "bafy-none");
      expect(status.archived).toBe(false);
      expect(status.detail).toMatch(/no Filecoin storage deals/);
    });

    it("confirms permanence for confirmed Arweave transactions (status 200)", async () => {
      const { service, fetchMock } = makeService();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ status: 200, blockHeight: 1234 })
      );

      const status = await service.checkProofOfStorage("arweave", "ar-tx");

      expect(status.archived).toBe(true);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("https://arweave.net/tx/ar-tx/status");
    });

    it("requires an anchored Arweave block before marking the tx archived", async () => {
      const { service, fetchMock } = makeService();
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: 200 }));

      const status = await service.checkProofOfStorage("arweave", "ar-accepted");

      expect(status.archived).toBe(false);
      expect(status.detail).toMatch(/not anchored in a block/);
    });

    it("flags pending Arweave transactions as not yet permanent", async () => {
      const { service, fetchMock } = makeService();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ status: 202 }))
        .mockResolvedValueOnce(jsonResponse({}, 404));

      const pending = await service.checkProofOfStorage("arweave", "ar-pend");
      const missing = await service.checkProofOfStorage("arweave", "ar-gone");

      expect(pending.archived).toBe(false);
      expect(pending.detail).toMatch(/status 202/);
      expect(missing.archived).toBe(false);
      expect(missing.detail).toMatch(/HTTP 404/);
    });

    it("inspects IPFS retrievability through the resilient gateway client", async () => {
      const { service } = makeService();
      const fetchFile = vi.mocked(ipfsService.fetchFile);
      fetchFile.mockResolvedValueOnce(new Response("ok"));
      fetchFile.mockRejectedValueOnce(new Error("all gateways failed"));

      const reachable = await service.checkProofOfStorage("ipfs", "QmLive");
      const unreachable = await service.checkProofOfStorage("ipfs", "QmDead");

      expect(reachable.archived).toBe(true);
      expect(unreachable.archived).toBe(false);
      expect(unreachable.detail).toMatch(/all gateways failed/);
    });

    it("never throws - network errors become archived:false details", async () => {
      const { service, fetchMock } = makeService();
      fetchMock.mockRejectedValueOnce(new Error("dns failure"));

      const status = await service.checkProofOfStorage("filecoin", "cid-x");
      expect(status.archived).toBe(false);
      expect(status.detail).toBe("dns failure");
    });
  });

  describe("backup reference registry", () => {
    it("merges references across repeated recordings and shares state between instances", () => {
      const shared = makeRefStore();
      const first = createStorageProviderService({
        refStore: shared as unknown as Storage,
      });
      const second = createStorageProviderService({
        refStore: shared as unknown as Storage,
      });

      first.recordBackupRefs("QmShared", { arweave: "ar-1" });
      first.recordBackupRefs("QmShared", { arweave: "ar-1b" });
      second.recordBackupRefs("QmShared", { filecoin: "fc-1" });

      expect(second.getBackupRefs("QmShared")).toEqual({
        arweave: "ar-1b",
        filecoin: "fc-1",
      });
      expect(first.getBackupRefs("QmUnknown")).toBeNull();
    });

    it("falls back to a no-op store when window/localStorage is unavailable", () => {
      const service = createStorageProviderService();
      expect(service.getBackupRefs("anything")).toBeNull();
      expect(() =>
        service.recordBackupRefs("anything", { arweave: "ar-x" })
      ).not.toThrow();
    });
  });

  describe("fetchDocument (fallback retrieval)", () => {
    const stubRefs = (
      service: ReturnType<typeof createStorageProviderService>,
      ipfsHash: string,
      refs: { arweave?: string; filecoin?: string }
    ) => service.recordBackupRefs(ipfsHash, refs);

    it("returns the IPFS response immediately when a gateway succeeds", async () => {
      const { service, fetchMock } = makeService();
      const primary = new Response("from-ipfs");
      vi.mocked(ipfsService.fetchFile).mockResolvedValueOnce(primary);

      const response = await service.fetchDocument("QmOk");

      expect(response).toBe(primary);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("routes reads through the PIR-aware fetch and forwards decoyCids (oblivious proxy integration point)", async () => {
      const { service } = makeService();
      const primary = new Response("from-ipfs");
      vi.mocked(ipfsService.fetchFile).mockResolvedValueOnce(primary);

      const decoyCids = ["QmSibling1", "QmSibling2"];
      const response = await service.fetchDocument("QmOk", undefined, decoyCids);

      expect(response).toBe(primary);
      expect(ipfsService.fetchFileWithPIR).toHaveBeenCalledWith("QmOk", undefined, decoyCids);
    });

    it("falls back to Arweave when every IPFS gateway fails", async () => {
      const { service, fetchMock } = makeService();
      vi.mocked(ipfsService.fetchFile).mockRejectedValueOnce(
        new Error("IpfsGatewayFetchError")
      );
      stubRefs(service, "QmArFallback", { arweave: "ar-doc" });
      fetchMock.mockResolvedValueOnce(new Response("from-arweave"));

      const response = await service.fetchDocument("QmArFallback");
      const body = await response.text();

      expect(body).toBe("from-arweave");
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("https://arweave.net/ar-doc");
    });

    it("falls back to the Filecoin gateway when there is no Arweave copy", async () => {
      const { service, fetchMock } = makeService();
      vi.mocked(ipfsService.fetchFile).mockRejectedValueOnce(
        new Error("down")
      );
      stubRefs(service, "QmFcFallback", { filecoin: "bafy-doc" });
      env().VITE_LIGHTHOUSE_GATEWAY_URL = "https://custom.gateway/ipfs/";
      fetchMock.mockResolvedValueOnce(new Response("from-filecoin"));

      const response = await service.fetchDocument("QmFcFallback");

      expect(await response.text()).toBe("from-filecoin");
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://custom.gateway/ipfs/bafy-doc"
      );
    });

    it("walks arweave then filecoin until one responds", async () => {
      const { service, fetchMock } = makeService();
      vi.mocked(ipfsService.fetchFile).mockRejectedValueOnce(new Error("down"));
      stubRefs(service, "QmBoth", {
        arweave: "ar-dead",
        filecoin: "bafy-live",
      });
      fetchMock
        .mockRejectedValueOnce(new Error("503"))
        .mockResolvedValueOnce(new Response("from-filecoin"));

      const response = await service.fetchDocument("QmBoth");
      expect(await response.text()).toBe("from-filecoin");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("throws a StorageProviderFetchError listing every attempt on total failure", async () => {
      const { service, fetchMock } = makeService();
      vi.mocked(ipfsService.fetchFile).mockRejectedValueOnce(
        new Error("gateways exhausted")
      );
      stubRefs(service, "QmDoomed", {
        arweave: "ar-broken",
        filecoin: "fc-broken",
      });
      fetchMock
        .mockRejectedValueOnce(new Error("ar 404"))
        .mockRejectedValueOnce(new Error("fc timeout"));

      let error: StorageProviderFetchError | undefined;
      try {
        await service.fetchDocument("QmDoomed");
      } catch (caught) {
        error = caught as StorageProviderFetchError;
      }

      expect(error).toBeInstanceOf(StorageProviderFetchError);
      expect(error!.reference).toBe("QmDoomed");
      expect(error!.attempts).toHaveLength(3);
      expect(error!.attempts[0]).toContain("ipfs -> gateways exhausted");
      expect(error!.attempts[1]).toContain("arweave -> ar 404");
      expect(error!.attempts[2]).toContain("filecoin -> fc timeout");
    });

    it("fails fast when no backup references were recorded", async () => {
      const { service, fetchMock } = makeService();
      vi.mocked(ipfsService.fetchFile).mockRejectedValueOnce(
        new Error("offline")
      );

      await expect(service.fetchDocument("QmNoBackups")).rejects.toThrow(
        StorageProviderFetchError
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("requires a CID", async () => {
      const { service } = makeService();
      await expect(service.fetchDocument("")).rejects.toThrow(
        /CID is required/
      );
    });
  });

  describe("verifyArchival", () => {
    it("aggregates proof-of-storage statuses for the primary and all recorded backups", async () => {
      const { service, fetchMock } = makeService();
      service.recordBackupRefs("QmVerify", {
        arweave: "ar-v",
        filecoin: "fc-v",
      });
      vi.mocked(ipfsService.fetchFile).mockResolvedValueOnce(new Response("ok"));
      fetchMock
        .mockResolvedValueOnce(jsonResponse([{ dealId: 1, status: "active" }]))
        .mockResolvedValueOnce(jsonResponse({ status: 200, blockHeight: 1234 }));

      const { statuses } = await service.verifyArchival("QmVerify");

      expect(Object.keys(statuses).sort()).toEqual([
        "arweave",
        "filecoin",
        "ipfs",
      ]);
      expect(statuses.ipfs?.archived).toBe(true);
      expect(statuses.filecoin?.archived).toBe(true);
      expect(statuses.arweave?.archived).toBe(true);
    });

    it("omits providers without recorded references instead of failing", async () => {
      const { service, fetchMock } = makeService();
      vi.mocked(ipfsService.fetchFile).mockResolvedValueOnce(new Response("ok"));

      const { statuses } = await service.verifyArchival("QmIpfsOnly");

      expect(Object.keys(statuses)).toEqual(["ipfs"]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("exposes the documented default backup order", () => {
    expect(DEFAULT_BACKUP_PROVIDERS).toEqual(["filecoin", "arweave"]);
  });
});
