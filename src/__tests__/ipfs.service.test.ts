import { describe, it, expect, vi, beforeEach } from "vitest";

const { postMock, deleteMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock("axios", () => ({
  default: { post: postMock, delete: deleteMock },
}));

const mockFetchFile = vi.fn();
const mockGetURL = vi.fn(
  (hash: string) => `https://gateway.pinata.cloud/ipfs/${hash}`
);
const mockGetGatewayPool = vi.fn(() => ["https://gateway.pinata.cloud/ipfs/"]);

vi.mock("../services/ipfsGateway", () => ({
  ipfsGateway: {
    fetchFile: mockFetchFile,
    getURL: mockGetURL,
    getGatewayPool: mockGetGatewayPool,
  },
}));

type IpfsModule = typeof import("../services/ipfs.service");

const testEnv = (): Record<string, string | undefined> =>
  import.meta.env as unknown as Record<string, string | undefined>;

const resetIpfsEnv = (): void => {
  delete testEnv().VITE_PINATA_JWT;
  delete testEnv().VITE_PINATA_API_KEY;
  delete testEnv().VITE_PINATA_API_SECRET;
  delete testEnv().VITE_IPFS_PROXY_URL;
  delete testEnv().VITE_SPOOVUALT_PROXY_SECRET;
};

const loadService = async (): Promise<IpfsModule> => {
  vi.resetModules();
  return import("../services/ipfs.service");
};

describe("IpfsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIpfsEnv();
  });

  describe("isConfigured", () => {
    it("returns false when no credentials or proxy secret are provided", async () => {
      const { ipfsService } = await loadService();
      expect(ipfsService.isConfigured()).toBe(false);
    });

    it("returns true when VITE_PINATA_JWT is present", async () => {
      testEnv().VITE_PINATA_JWT = "mock-jwt";
      const { ipfsService } = await loadService();
      expect(ipfsService.isConfigured()).toBe(true);
    });

    it("returns true when VITE_PINATA_API_KEY and SECRET are present", async () => {
      testEnv().VITE_PINATA_API_KEY = "mock-key";
      testEnv().VITE_PINATA_API_SECRET = "mock-secret";
      const { ipfsService } = await loadService();
      expect(ipfsService.isConfigured()).toBe(true);
    });

    it("returns false when only VITE_PINATA_API_KEY is present without secret", async () => {
      testEnv().VITE_PINATA_API_KEY = "mock-key";
      const { ipfsService } = await loadService();
      expect(ipfsService.isConfigured()).toBe(false);
    });

    it("returns true when VITE_IPFS_PROXY_URL and PROXY_SECRET are present", async () => {
      testEnv().VITE_IPFS_PROXY_URL = "http://localhost:3001";
      testEnv().VITE_SPOOVUALT_PROXY_SECRET = "proxy-secret";
      const { ipfsService } = await loadService();
      expect(ipfsService.isConfigured()).toBe(true);
    });

    it("returns false when VITE_IPFS_PROXY_URL is set but PROXY_SECRET is missing", async () => {
      testEnv().VITE_IPFS_PROXY_URL = "http://localhost:3001";
      const { ipfsService } = await loadService();
      expect(ipfsService.isConfigured()).toBe(false);
    });
  });

  describe("gateway proxies", () => {
    it("forwards getURL, fetchFile, and getGatewayPool to ipfsGateway", async () => {
      const { ipfsService } = await loadService();
      const url = ipfsService.getURL("QmTestHash");
      expect(url).toBe("https://gateway.pinata.cloud/ipfs/QmTestHash");
      expect(mockGetURL).toHaveBeenCalledWith("QmTestHash");

      const pool = ipfsService.getGatewayPool();
      expect(pool).toEqual(["https://gateway.pinata.cloud/ipfs/"]);

      await ipfsService.fetchFile("QmTestHash");
      expect(mockFetchFile).toHaveBeenCalledWith("QmTestHash", undefined);
    });
  });

  describe("uploadFile", () => {
    const file = new File(["test file content"], "test.txt", {
      type: "text/plain",
    });

    it("throws when IPFS is not configured", async () => {
      const { ipfsService } = await loadService();
      await expect(ipfsService.uploadFile(file)).rejects.toThrow(
        "IPFS is not configured"
      );
    });

    it("uploads directly to Pinata with JWT headers", async () => {
      testEnv().VITE_PINATA_JWT = "mock-jwt";
      postMock.mockResolvedValueOnce({
        data: { IpfsHash: "QmDirectPinataHash", PinSize: 1234 },
      });

      const { ipfsService } = await loadService();
      const res = await ipfsService.uploadFile(file, { name: "custom-name" });
      expect(res.hash).toBe("QmDirectPinataHash");
      expect(res.size).toBe(1234);
      expect(postMock).toHaveBeenCalledWith(
        "https://api.pinata.cloud/pinning/pinFileToIPFS",
        expect.any(FormData),
        expect.objectContaining({
          headers: { Authorization: "Bearer mock-jwt" },
        })
      );
    });

    it("uploads directly to Pinata with API Key & Secret", async () => {
      testEnv().VITE_PINATA_API_KEY = "key-123";
      testEnv().VITE_PINATA_API_SECRET = "secret-456";
      postMock.mockResolvedValueOnce({
        data: { IpfsHash: "QmKeySecretHash", PinSize: 5678 },
      });

      const { ipfsService } = await loadService();
      const res = await ipfsService.uploadFile(file);
      expect(res.hash).toBe("QmKeySecretHash");
      expect(postMock).toHaveBeenCalledWith(
        "https://api.pinata.cloud/pinning/pinFileToIPFS",
        expect.any(FormData),
        expect.objectContaining({
          headers: {
            pinata_api_key: "key-123",
            pinata_secret_api_key: "secret-456",
          },
        })
      );
    });

    it("uploads via proxy with HMAC signature headers", async () => {
      testEnv().VITE_IPFS_PROXY_URL = "http://localhost:3001";
      testEnv().VITE_SPOOVUALT_PROXY_SECRET = "test-proxy-secret";
      postMock.mockResolvedValueOnce({
        data: { IpfsHash: "QmProxyUploadHash", PinSize: 999 },
      });

      const { ipfsService } = await loadService();
      const res = await ipfsService.uploadFile(file, {
        keyvalues: { tag: "test" },
      });
      expect(res.hash).toBe("QmProxyUploadHash");
      expect(postMock).toHaveBeenCalledWith(
        "http://localhost:3001/api/ipfs/pin-file",
        expect.any(FormData),
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-SpooVault-Signature": expect.stringContaining("t="),
          }),
        })
      );
    });

    it("handles upload timeout error", async () => {
      testEnv().VITE_PINATA_JWT = "mock-jwt";
      const error: any = new Error("timeout");
      error.code = "ECONNABORTED";
      postMock.mockRejectedValueOnce(error);

      const { ipfsService } = await loadService();
      await expect(ipfsService.uploadFile(file)).rejects.toThrow(
        "IPFS upload timed out. Try again with a smaller file or better network."
      );
    });

    it("handles upload cancellation error", async () => {
      testEnv().VITE_PINATA_JWT = "mock-jwt";
      const error: any = new Error("canceled");
      error.code = "ERR_CANCELED";
      postMock.mockRejectedValueOnce(error);

      const { ipfsService } = await loadService();
      await expect(ipfsService.uploadFile(file)).rejects.toThrow(
        "IPFS upload canceled."
      );
    });
  });

  describe("unpin", () => {
    it("throws when hash is empty or missing", async () => {
      testEnv().VITE_PINATA_JWT = "mock-jwt";
      const { ipfsService } = await loadService();
      await expect(ipfsService.unpin("")).rejects.toThrow(
        "IPFS hash is required for unpinning"
      );
      await expect(ipfsService.unpin("   ")).rejects.toThrow(
        "IPFS hash is required for unpinning"
      );
    });

    it("throws when IPFS is not configured", async () => {
      const { ipfsService } = await loadService();
      await expect(ipfsService.unpin("QmTestHash")).rejects.toThrow(
        "IPFS is not configured"
      );
    });

    it("unpins directly on Pinata with auth headers", async () => {
      testEnv().VITE_PINATA_JWT = "mock-jwt";
      deleteMock.mockResolvedValueOnce({ data: "OK", status: 200 });

      const { ipfsService } = await loadService();
      const res = await ipfsService.unpin("QmHashToUnpin");
      expect(res).toBe(true);
      expect(deleteMock).toHaveBeenCalledWith(
        "https://api.pinata.cloud/pinning/unpin/QmHashToUnpin",
        expect.objectContaining({
          headers: { Authorization: "Bearer mock-jwt" },
          timeout: 30000,
        })
      );
    });

    it("unpins via proxy with signed DELETE request", async () => {
      testEnv().VITE_IPFS_PROXY_URL = "http://localhost:3001";
      testEnv().VITE_SPOOVUALT_PROXY_SECRET = "test-proxy-secret";
      deleteMock.mockResolvedValueOnce({
        data: { message: "Unpinned successfully" },
        status: 200,
      });

      const { ipfsService } = await loadService();
      const res = await ipfsService.unpin("QmHashToUnpinProxy");
      expect(res).toBe(true);
      expect(deleteMock).toHaveBeenCalledWith(
        "http://localhost:3001/api/ipfs/unpin/QmHashToUnpinProxy",
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-SpooVault-Signature": expect.stringContaining("t="),
          }),
          timeout: 30000,
        })
      );
    });

    it("unpins directly on Pinata with API Key and Secret", async () => {
      testEnv().VITE_PINATA_API_KEY = "key-123";
      testEnv().VITE_PINATA_API_SECRET = "secret-456";
      deleteMock.mockResolvedValueOnce({ data: "OK", status: 200 });

      const { ipfsService } = await loadService();
      const res = await ipfsService.unpin("QmHashToUnpinKeySecret");
      expect(res).toBe(true);
      expect(deleteMock).toHaveBeenCalledWith(
        "https://api.pinata.cloud/pinning/unpin/QmHashToUnpinKeySecret",
        expect.objectContaining({
          headers: {
            pinata_api_key: "key-123",
            pinata_secret_api_key: "secret-456",
          },
          timeout: 30000,
        })
      );
    });

    it("treats 404 response as successfully unpinned", async () => {
      testEnv().VITE_PINATA_JWT = "mock-jwt";
      const error: any = new Error("Not Found");
      error.response = { status: 404, data: { error: "Pin not found" } };
      deleteMock.mockRejectedValueOnce(error);

      const { ipfsService } = await loadService();
      const res = await ipfsService.unpin("QmAlreadyUnpinned");
      expect(res).toBe(true);
    });

    it("handles unpin timeout error", async () => {
      testEnv().VITE_PINATA_JWT = "mock-jwt";
      const error: any = new Error("timeout");
      error.code = "ECONNABORTED";
      deleteMock.mockRejectedValueOnce(error);

      const { ipfsService } = await loadService();
      await expect(ipfsService.unpin("QmTimeoutHash")).rejects.toThrow(
        "IPFS unpin timed out."
      );
    });

    it("handles unpin cancellation error", async () => {
      testEnv().VITE_PINATA_JWT = "mock-jwt";
      const error: any = new Error("canceled");
      error.code = "ERR_CANCELED";
      deleteMock.mockRejectedValueOnce(error);

      const { ipfsService } = await loadService();
      await expect(ipfsService.unpin("QmCanceledHash")).rejects.toThrow(
        "IPFS unpin canceled."
      );
    });

    it("handles generic unpin error message from Pinata response", async () => {
      testEnv().VITE_PINATA_JWT = "mock-jwt";
      const error: any = new Error("Failed");
      error.response = {
        status: 500,
        data: { error: { reason: "Pinata internal failure" } },
      };
      deleteMock.mockRejectedValueOnce(error);

      const { ipfsService } = await loadService();
      await expect(ipfsService.unpin("QmFailedHash")).rejects.toThrow(
        "Pinata internal failure"
      );
    });
  });
});
