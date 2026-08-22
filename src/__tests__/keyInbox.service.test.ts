import { describe, it, expect, vi, beforeEach } from "vitest";
import CryptoJS from "crypto-js";

const { postMock, getMock, deleteMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  getMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock("axios", () => ({
  default: { post: postMock, get: getMock, delete: deleteMock },
}));

const BENEFICIARY = "0x71C838936352937A71E976BBE84e941E79409932";
const ISSUER = "0x2546BcD3c84621e976D8185a91A922aE77ECEc30";
const CONTRACT = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
const ENVELOPE_NAME = "spoovault-beneficiary-key-envelope";
const DEFAULT_GATEWAY = "https://gateway.pinata.cloud/ipfs/";

type KeyInboxModule = typeof import("../services/keyInbox.service");

const testEnv = (): Record<string, string | undefined> =>
  import.meta.env as unknown as Record<string, string | undefined>;

const resetIpfsEnv = (): void => {
  delete testEnv().VITE_PINATA_JWT;
  delete testEnv().VITE_PINATA_API_KEY;
  delete testEnv().VITE_PINATA_API_SECRET;
  delete testEnv().VITE_IPFS_PROXY_URL;
  delete testEnv().VITE_SPOOVUALT_PROXY_SECRET;
};

const loadService = async (): Promise<KeyInboxModule> => {
  vi.resetModules();
  return import("../services/keyInbox.service");
};

const sha256 = (value: string): string => CryptoJS.SHA256(value).toString();

const makePayload = () => ({
  version: 1,
  type: "beneficiary_key_envelope" as const,
  app: "SpooVault" as const,
  contract: CONTRACT,
  chainId: 11155111,
  vaultId: 7,
  documentId: 3,
  beneficiary: BENEFICIARY,
  issuedBy: ISSUER,
  issuedAt: "2026-08-21T10:00:00.000Z",
  key: "envelope-key-material",
});

const makeEnvelopePayload = (
  issuedAt: string,
  beneficiary = BENEFICIARY.toLowerCase()
) => ({
  version: 1,
  type: "beneficiary_key_envelope" as const,
  app: "SpooVault" as const,
  contract: CONTRACT.toLowerCase(),
  chainId: 11155111,
  vaultId: 7,
  documentId: 3,
  beneficiary,
  issuedBy: ISSUER.toLowerCase(),
  issuedAt,
  key: "envelope-key-material",
});

const makeMatchingRow = (hash: string) => ({
  ipfs_pin_hash: hash,
  date_pinned: "2026-01-01T00:00:00.000Z",
  metadata: {
    name: ENVELOPE_NAME,
    keyvalues: {
      type: "beneficiary_key_envelope",
      beneficiary: sha256(BENEFICIARY.toLowerCase()),
      contract: sha256(CONTRACT.toLowerCase()),
      chainId: "11155111",
      documentId: "3",
      vaultId: "7",
      issuedBy: sha256(ISSUER.toLowerCase()),
      issuedAt: "2026-01-01T00:00:00.000Z",
    },
  },
});

const isListUrl = (url: string): boolean =>
  url.includes("/data/pinList") || url.includes("/api/ipfs/pin-list");

describe("KeyInboxService (IPFS key envelope privacy)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIpfsEnv();
  });

  describe("hashAddress", () => {
    it("produces a 64-character lowercase hex SHA-256 digest", async () => {
      const { keyInboxService } = await loadService();
      const digest = keyInboxService.hashAddress(BENEFICIARY);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(digest).not.toContain(BENEFICIARY.toLowerCase());
    });

    it("is deterministic and case-insensitive on input addresses", async () => {
      const { keyInboxService } = await loadService();
      expect(keyInboxService.hashAddress(BENEFICIARY)).toBe(
        keyInboxService.hashAddress(BENEFICIARY.toLowerCase())
      );
      expect(
        keyInboxService.hashAddress(`  ${BENEFICIARY.toUpperCase()}  `)
      ).toBe(keyInboxService.hashAddress(BENEFICIARY));
    });

    it("matches a direct SHA-256 of the normalized address", async () => {
      const { keyInboxService } = await loadService();
      expect(keyInboxService.hashAddress(CONTRACT)).toBe(
        sha256(CONTRACT.toLowerCase())
      );
    });

    it("produces different digests for different addresses", async () => {
      const { keyInboxService } = await loadService();
      expect(keyInboxService.hashAddress(BENEFICIARY)).not.toBe(
        keyInboxService.hashAddress(ISSUER)
      );
    });
  });

  describe("isConfigured", () => {
    it("is false when no IPFS configuration is present", async () => {
      const { keyInboxService } = await loadService();
      expect(keyInboxService.isConfigured()).toBe(false);
    });

    it("is true with a Pinata JWT", async () => {
      testEnv().VITE_PINATA_JWT = "test-jwt";
      const { keyInboxService } = await loadService();
      expect(keyInboxService.isConfigured()).toBe(true);
    });

    it("is true with a proxy URL and secret", async () => {
      testEnv().VITE_IPFS_PROXY_URL = "https://proxy.example.com";
      testEnv().VITE_SPOOVUALT_PROXY_SECRET = "test-secret";
      const { keyInboxService } = await loadService();
      expect(keyInboxService.isConfigured()).toBe(true);
    });

    it("is true with API key and secret pair", async () => {
      testEnv().VITE_PINATA_API_KEY = "key";
      testEnv().VITE_PINATA_API_SECRET = "secret";
      const { keyInboxService } = await loadService();
      expect(keyInboxService.isConfigured()).toBe(true);
    });

    it("is false with an API key but no secret", async () => {
      testEnv().VITE_PINATA_API_KEY = "key";
      const { keyInboxService } = await loadService();
      expect(keyInboxService.isConfigured()).toBe(false);
    });
  });

  describe("sendKeyEnvelope", () => {
    it("rejects and performs no request when IPFS is not configured", async () => {
      const { keyInboxService } = await loadService();
      await expect(
        keyInboxService.sendKeyEnvelope(makePayload())
      ).rejects.toThrow("IPFS is not configured");
      expect(postMock).not.toHaveBeenCalled();
    });

    it("pins hashed metadata keyvalues on the direct Pinata path", async () => {
      testEnv().VITE_PINATA_JWT = "test-jwt";
      postMock.mockResolvedValueOnce({ data: { IpfsHash: "QmEnvelopeHash" } });
      const { keyInboxService } = await loadService();

      const result = await keyInboxService.sendKeyEnvelope(makePayload());

      expect(result).toBe("QmEnvelopeHash");
      expect(postMock).toHaveBeenCalledTimes(1);
      const [url, body, config] = postMock.mock.calls[0];
      expect(url).toBe("https://api.pinata.cloud/pinning/pinJSONToIPFS");

      const keyvalues = body.pinataMetadata.keyvalues;
      expect(keyvalues.type).toBe("beneficiary_key_envelope");
      expect(keyvalues.beneficiary).toBe(sha256(BENEFICIARY.toLowerCase()));
      expect(keyvalues.contract).toBe(sha256(CONTRACT.toLowerCase()));
      expect(keyvalues.issuedBy).toBe(sha256(ISSUER.toLowerCase()));
      expect(keyvalues.chainId).toBe("11155111");
      expect(keyvalues.documentId).toBe("3");
      expect(keyvalues.vaultId).toBe("7");
      expect(keyvalues.issuedAt).toBe("2026-08-21T10:00:00.000Z");

      const serializedMetadata = JSON.stringify(
        body.pinataMetadata
      ).toLowerCase();
      expect(serializedMetadata).not.toContain(BENEFICIARY.toLowerCase());
      expect(serializedMetadata).not.toContain(CONTRACT.toLowerCase());
      expect(serializedMetadata).not.toContain(ISSUER.toLowerCase());

      expect(body.pinataContent.beneficiary).toBe(BENEFICIARY.toLowerCase());
      expect(body.pinataContent.contract).toBe(CONTRACT.toLowerCase());
      expect(body.pinataContent.issuedBy).toBe(ISSUER.toLowerCase());

      expect(config.headers.Authorization).toBe("Bearer test-jwt");
      expect(config.headers["Content-Type"]).toBe("application/json");
    });

    it("uses API key and secret headers when JWT is absent", async () => {
      testEnv().VITE_PINATA_API_KEY = "pinata-key";
      testEnv().VITE_PINATA_API_SECRET = "pinata-secret";
      postMock.mockResolvedValueOnce({ data: { IpfsHash: "QmKeySecretHash" } });
      const { keyInboxService } = await loadService();

      await keyInboxService.sendKeyEnvelope(makePayload());

      const [, , config] = postMock.mock.calls[0];
      expect(config.headers.pinata_api_key).toBe("pinata-key");
      expect(config.headers.pinata_secret_api_key).toBe("pinata-secret");
      expect(config.headers.Authorization).toBeUndefined();
    });

    it("posts to the proxy endpoint with signature when configured", async () => {
      testEnv().VITE_IPFS_PROXY_URL = "https://proxy.example.com";
      testEnv().VITE_SPOOVUALT_PROXY_SECRET = "test-secret";
      postMock.mockResolvedValueOnce({ data: { IpfsHash: "QmProxyHash" } });
      const { keyInboxService } = await loadService();

      const result = await keyInboxService.sendKeyEnvelope(makePayload());

      expect(result).toBe("QmProxyHash");
      const [url, rawBody, config] = postMock.mock.calls[0];
      expect(url).toBe("https://proxy.example.com/api/ipfs/pin-json");
      const body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
      expect(body.pinataMetadata.keyvalues.beneficiary).toBe(
        sha256(BENEFICIARY.toLowerCase())
      );
      expect(body.pinataMetadata.keyvalues.issuedBy).toBe(
        sha256(ISSUER.toLowerCase())
      );
      expect(config.headers["Content-Type"]).toBe("application/json");
      expect(config.headers["X-SpooVault-Signature"]).toBeDefined();
    });

    it("rejects when the pin response has no IpfsHash", async () => {
      testEnv().VITE_PINATA_JWT = "test-jwt";
      postMock.mockResolvedValueOnce({ data: {} });
      const { keyInboxService } = await loadService();

      await expect(
        keyInboxService.sendKeyEnvelope(makePayload())
      ).rejects.toThrow("Failed to publish key envelope");
    });
  });

  describe("fetchBeneficiaryInbox", () => {
    it("rejects when IPFS is not configured", async () => {
      const { keyInboxService } = await loadService();
      await expect(
        keyInboxService.fetchBeneficiaryInbox(BENEFICIARY)
      ).rejects.toThrow("IPFS is not configured");
      expect(getMock).not.toHaveBeenCalled();
    });

    it("returns envelopes sorted newest first for hashed metadata matches", async () => {
      testEnv().VITE_PINATA_JWT = "test-jwt";
      const older = makeEnvelopePayload("2026-01-01T00:00:00.000Z");
      const newer = makeEnvelopePayload("2026-06-15T00:00:00.000Z");
      let listCalls = 0;
      getMock.mockImplementation(async (url: string) => {
        if (isListUrl(url)) {
          listCalls += 1;
          if (listCalls > 1) {
            return { data: { rows: [] } };
          }
          return {
            data: {
              rows: [makeMatchingRow("QmOlder"), makeMatchingRow("QmNewer")],
            },
          };
        }
        if (url === `${DEFAULT_GATEWAY}QmOlder`) {
          return { data: older };
        }
        return { data: newer };
      });
      const { keyInboxService } = await loadService();

      const envelopes = await keyInboxService.fetchBeneficiaryInbox(
        BENEFICIARY
      );

      expect(envelopes.map((item) => item.issuedAt)).toEqual([
        "2026-06-15T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ]);
      expect(getMock).toHaveBeenCalledWith(
        "https://api.pinata.cloud/data/pinList",
        expect.objectContaining({
          headers: { Authorization: "Bearer test-jwt" },
          params: expect.objectContaining({
            status: "pinned",
            pageLimit: 100,
            pageOffset: 0,
          }),
        })
      );
      expect(getMock).toHaveBeenCalledWith(`${DEFAULT_GATEWAY}QmOlder`, {
        timeout: 30000,
      });
      expect(getMock).toHaveBeenCalledWith(`${DEFAULT_GATEWAY}QmNewer`, {
        timeout: 30000,
      });
    });

    it("skips rows without a pin hash, wrong name, wrong type, plaintext or foreign beneficiary", async () => {
      testEnv().VITE_PINATA_JWT = "test-jwt";
      const validRow = makeMatchingRow("QmValid");
      const rows = [
        {},
        { ipfs_pin_hash: "" },
        {
          ...validRow,
          ipfs_pin_hash: "QmWrongName",
          metadata: { ...validRow.metadata, name: "other" },
        },
        {
          ipfs_pin_hash: "QmWrongType",
          metadata: {
            name: ENVELOPE_NAME,
            keyvalues: {
              type: "other_type",
              beneficiary: sha256(BENEFICIARY.toLowerCase()),
            },
          },
        },
        {
          ipfs_pin_hash: "QmPlaintext",
          metadata: {
            name: ENVELOPE_NAME,
            keyvalues: {
              type: "beneficiary_key_envelope",
              beneficiary: BENEFICIARY.toLowerCase(),
            },
          },
        },
        {
          ipfs_pin_hash: "QmForeign",
          metadata: {
            name: ENVELOPE_NAME,
            keyvalues: {
              type: "beneficiary_key_envelope",
              beneficiary: sha256(ISSUER.toLowerCase()),
            },
          },
        },
        validRow,
      ];
      let listCalls = 0;
      getMock.mockImplementation(async (url: string) => {
        if (isListUrl(url)) {
          listCalls += 1;
          if (listCalls > 1) {
            return { data: { rows: [] } };
          }
          return { data: { rows } };
        }
        return { data: makeEnvelopePayload("2026-02-02T00:00:00.000Z") };
      });
      const { keyInboxService } = await loadService();

      const hashes = await keyInboxService.fetchBeneficiaryInbox(BENEFICIARY);

      expect(hashes).toHaveLength(1);
      expect(hashes[0].beneficiary).toBe(BENEFICIARY.toLowerCase());
    });

    it("returns an empty array after a single empty listing page", async () => {
      testEnv().VITE_PINATA_JWT = "test-jwt";
      getMock.mockResolvedValue({ data: { rows: [] } });
      const { keyInboxService } = await loadService();

      const envelopes = await keyInboxService.fetchBeneficiaryInbox(
        BENEFICIARY
      );

      expect(envelopes).toEqual([]);
      expect(getMock).toHaveBeenCalledTimes(1);
    });

    it("paginates to the next page offset when no match is found yet", async () => {
      testEnv().VITE_PINATA_JWT = "test-jwt";
      let listCalls = 0;
      getMock.mockImplementation(async (url: string) => {
        if (isListUrl(url)) {
          listCalls += 1;
          if (listCalls === 1) {
            return {
              data: {
                rows: [
                  {
                    ipfs_pin_hash: "QmForeignPage",
                    metadata: {
                      name: ENVELOPE_NAME,
                      keyvalues: {
                        type: "beneficiary_key_envelope",
                        beneficiary: sha256(ISSUER.toLowerCase()),
                      },
                    },
                  },
                ],
              },
            };
          }
          if (listCalls === 2) {
            return { data: { rows: [makeMatchingRow("QmPageTwo")] } };
          }
          return { data: { rows: [] } };
        }
        return { data: makeEnvelopePayload("2026-03-03T00:00:00.000Z") };
      });
      const { keyInboxService } = await loadService();

      const envelopes = await keyInboxService.fetchBeneficiaryInbox(
        BENEFICIARY
      );

      expect(listCalls).toBe(3);
      expect(getMock).toHaveBeenCalledWith(
        "https://api.pinata.cloud/data/pinList",
        expect.objectContaining({
          params: expect.objectContaining({ pageOffset: 100 }),
        })
      );
      expect(envelopes).toHaveLength(1);
    });

    it("stops collecting matches once the requested limit is reached", async () => {
      testEnv().VITE_PINATA_JWT = "test-jwt";
      getMock.mockImplementation(async (url: string) => {
        if (isListUrl(url)) {
          return {
            data: { rows: [makeMatchingRow("QmA"), makeMatchingRow("QmB")] },
          };
        }
        return { data: makeEnvelopePayload("2026-04-04T00:00:00.000Z") };
      });
      const { keyInboxService } = await loadService();

      const envelopes = await keyInboxService.fetchBeneficiaryInbox(
        BENEFICIARY,
        { limit: 1 }
      );

      expect(envelopes).toHaveLength(1);
      expect(getMock).toHaveBeenCalledTimes(2);
    });

    it("drops envelopes whose gateway fetch fails or returns non-object data", async () => {
      testEnv().VITE_PINATA_JWT = "test-jwt";
      let listCalls = 0;
      getMock.mockImplementation(async (url: string) => {
        if (isListUrl(url)) {
          listCalls += 1;
          if (listCalls > 1) {
            return { data: { rows: [] } };
          }
          return {
            data: {
              rows: [
                makeMatchingRow("QmFails"),
                makeMatchingRow("QmNonObject"),
                makeMatchingRow("QmOk"),
              ],
            },
          };
        }
        if (url.endsWith("QmFails")) {
          throw new Error("gateway down");
        }
        if (url.endsWith("QmNonObject")) {
          return { data: "not-an-object" };
        }
        return { data: makeEnvelopePayload("2026-05-05T00:00:00.000Z") };
      });
      const { keyInboxService } = await loadService();

      const envelopes = await keyInboxService.fetchBeneficiaryInbox(
        BENEFICIARY
      );

      expect(envelopes).toHaveLength(1);
      expect(envelopes[0].issuedAt).toBe("2026-05-05T00:00:00.000Z");
    });

    it("drops envelopes whose payload beneficiary does not match the query", async () => {
      testEnv().VITE_PINATA_JWT = "test-jwt";
      getMock.mockImplementation(async (url: string) => {
        if (isListUrl(url)) {
          return { data: { rows: [makeMatchingRow("QmMismatch")] } };
        }
        return {
          data: makeEnvelopePayload(
            "2026-05-05T00:00:00.000Z",
            ISSUER.toLowerCase()
          ),
        };
      });
      const { keyInboxService } = await loadService();

      const envelopes = await keyInboxService.fetchBeneficiaryInbox(
        BENEFICIARY
      );

      expect(envelopes).toEqual([]);
    });

    it("treats invalid issuedAt timestamps as zero while sorting", async () => {
      testEnv().VITE_PINATA_JWT = "test-jwt";
      const invalidDate = makeEnvelopePayload("not-a-date");
      const validDate = makeEnvelopePayload("2026-07-07T00:00:00.000Z");
      let listCalls = 0;
      getMock.mockImplementation(async (url: string) => {
        if (isListUrl(url)) {
          listCalls += 1;
          if (listCalls > 1) {
            return { data: { rows: [] } };
          }
          return {
            data: {
              rows: [makeMatchingRow("QmInvalid"), makeMatchingRow("QmValid")],
            },
          };
        }
        if (url.endsWith("QmInvalid")) {
          return { data: invalidDate };
        }
        return { data: validDate };
      });
      const { keyInboxService } = await loadService();

      const envelopes = await keyInboxService.fetchBeneficiaryInbox(
        BENEFICIARY
      );

      expect(envelopes.map((item) => item.issuedAt)).toEqual([
        "2026-07-07T00:00:00.000Z",
        "not-a-date",
      ]);
    });

    it("lists pins through the proxy endpoint when proxy is configured", async () => {
      testEnv().VITE_IPFS_PROXY_URL = "https://proxy.example.com";
      testEnv().VITE_SPOOVUALT_PROXY_SECRET = "test-secret";
      let listCalls = 0;
      getMock.mockImplementation(async (url: string) => {
        if (isListUrl(url)) {
          listCalls += 1;
          if (listCalls > 1) {
            return { data: { rows: [] } };
          }
          return { data: { rows: [makeMatchingRow("QmProxied")] } };
        }
        return { data: makeEnvelopePayload("2026-08-08T00:00:00.000Z") };
      });
      const { keyInboxService } = await loadService();

      const envelopes = await keyInboxService.fetchBeneficiaryInbox(
        BENEFICIARY
      );

      expect(envelopes).toHaveLength(1);
      expect(getMock).toHaveBeenCalledWith(
        "https://proxy.example.com/api/ipfs/pin-list?status=pinned&pageLimit=100&pageOffset=0",
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-SpooVault-Signature": expect.any(String),
          }),
        })
      );
    });
  });

  describe("unpinKeyEnvelope", () => {
    it("calls ipfsService.unpin directly", async () => {
      testEnv().VITE_PINATA_JWT = "mock-jwt";
      deleteMock.mockResolvedValueOnce({ data: "OK", status: 200 });

      const { keyInboxService } = await loadService();
      const result = await keyInboxService.unpinKeyEnvelope("QmHashToUnpin");
      expect(result).toBe(true);
      expect(deleteMock).toHaveBeenCalledWith(
        "https://api.pinata.cloud/pinning/unpin/QmHashToUnpin",
        expect.anything()
      );
    });
  });

  describe("listAllKeyEnvelopes", () => {
    it("throws when IPFS is not configured", async () => {
      const { keyInboxService } = await loadService();
      await expect(keyInboxService.listAllKeyEnvelopes()).rejects.toThrow(
        "IPFS is not configured"
      );
    });

    it("lists all key envelopes filtering non-envelope rows", async () => {
      testEnv().VITE_PINATA_JWT = "mock-jwt";
      getMock.mockResolvedValueOnce({
        data: {
          rows: [
            makeMatchingRow("QmEnvelope1"),
            { ipfs_pin_hash: "QmOtherFile", metadata: { name: "other-file" } },
            makeMatchingRow("QmEnvelope2"),
          ],
        },
      });

      const { keyInboxService } = await loadService();
      const items = await keyInboxService.listAllKeyEnvelopes();
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.hash)).toEqual(["QmEnvelope1", "QmEnvelope2"]);
    });

    it("lists all key envelopes through proxy when configured", async () => {
      testEnv().VITE_IPFS_PROXY_URL = "https://proxy.example.com";
      testEnv().VITE_SPOOVUALT_PROXY_SECRET = "test-secret";
      getMock.mockResolvedValueOnce({
        data: {
          rows: [makeMatchingRow("QmProxyEnvelope")],
        },
      });

      const { keyInboxService } = await loadService();
      const items = await keyInboxService.listAllKeyEnvelopes();
      expect(items).toHaveLength(1);
      expect(items[0].hash).toBe("QmProxyEnvelope");
      expect(getMock).toHaveBeenCalledWith(
        "https://proxy.example.com/api/ipfs/pin-list?status=pinned&pageLimit=100&pageOffset=0",
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-SpooVault-Signature": expect.any(String),
          }),
        })
      );
    });
  });

  describe("findEnvelopeHashesForBeneficiaryAndDoc & unpinEnvelopesForBeneficiaryAndDoc", () => {
    it("throws when finding envelopes and IPFS is not configured", async () => {
      const { keyInboxService } = await loadService();
      await expect(
        keyInboxService.findEnvelopeHashesForBeneficiaryAndDoc(BENEFICIARY, 3)
      ).rejects.toThrow("IPFS is not configured");
    });

    it("finds envelope hashes matching beneficiary and documentId", async () => {
      testEnv().VITE_PINATA_JWT = "mock-jwt";
      getMock.mockResolvedValueOnce({
        data: {
          rows: [
            makeMatchingRow("QmDoc3Match"),
            {
              ipfs_pin_hash: "QmDoc4Mismatch",
              metadata: {
                name: ENVELOPE_NAME,
                keyvalues: {
                  type: "beneficiary_key_envelope",
                  beneficiary: sha256(BENEFICIARY.toLowerCase()),
                  documentId: "4",
                },
              },
            },
          ],
        },
      });

      const { keyInboxService } = await loadService();
      const hashes =
        await keyInboxService.findEnvelopeHashesForBeneficiaryAndDoc(
          BENEFICIARY,
          3
        );
      expect(hashes).toEqual(["QmDoc3Match"]);
    });

    it("unpins matching envelopes for beneficiary and documentId", async () => {
      testEnv().VITE_PINATA_JWT = "mock-jwt";
      getMock.mockResolvedValueOnce({
        data: {
          rows: [makeMatchingRow("QmToUnpin1"), makeMatchingRow("QmToUnpin2")],
        },
      });
      deleteMock.mockResolvedValue({ data: "OK", status: 200 });

      const { keyInboxService } = await loadService();
      const result = await keyInboxService.unpinEnvelopesForBeneficiaryAndDoc(
        BENEFICIARY,
        3
      );
      expect(result.unpinned).toEqual(["QmToUnpin1", "QmToUnpin2"]);
      expect(result.failed).toEqual([]);
      expect(deleteMock).toHaveBeenCalledTimes(2);
    });

    it("records failed unpins gracefully when delete fails", async () => {
      testEnv().VITE_PINATA_JWT = "mock-jwt";
      getMock.mockResolvedValueOnce({
        data: {
          rows: [makeMatchingRow("QmSuccess"), makeMatchingRow("QmFail")],
        },
      });
      deleteMock.mockImplementation(async (url: string) => {
        if (url.includes("QmFail")) {
          throw new Error("Network error");
        }
        return { data: "OK", status: 200 };
      });

      const { keyInboxService } = await loadService();
      const result = await keyInboxService.unpinEnvelopesForBeneficiaryAndDoc(
        BENEFICIARY,
        3
      );
      expect(result.unpinned).toEqual(["QmSuccess"]);
      expect(result.failed).toEqual(["QmFail"]);
    });
  });
});
