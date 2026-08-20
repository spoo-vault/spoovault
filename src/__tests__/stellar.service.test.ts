import { describe, it, expect, vi, beforeEach } from "vitest";
import { stellarService } from "../services/stellar.service";

const mockStore: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn().mockImplementation((key) => mockStore[key] || null),
  setItem: vi.fn().mockImplementation((key, val) => { mockStore[key] = String(val); }),
  clear: vi.fn().mockImplementation(() => {
    for (const key in mockStore) {
      delete mockStore[key];
    }
  }),
};
vi.stubGlobal("localStorage", localStorageMock);

describe("Stellar/Soroban Service", () => {
  let mockFreighter: any;
  let mockSdk: any;
  let mockServer: any;
  const mockAddress = "GBB4JST33BHDF245F23FAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFA";

  beforeEach(() => {
    localStorage.clear();
    stellarService.clear();

    mockFreighter = {
      isConnected: vi.fn().mockResolvedValue(true),
      getAddress: vi.fn().mockResolvedValue(mockAddress),
      signTransaction: vi.fn().mockResolvedValue("AAAA_SIGNED_TX_ENVELOPE_XDR"),
      signAuthEntry: vi.fn().mockResolvedValue({ signedAuthEntry: "AAAA_SIGNED_AUTH_ENTRY" }),
    };

    mockServer = {
      getAccount: vi.fn().mockResolvedValue({
        sequenceNumber: "100",
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        results: [{
          retval: "mock-retval",
          auth: []
        }],
        transactionData: {},
        minResourceFee: "100",
      }),
      sendTransaction: vi.fn().mockResolvedValue({
        status: "PENDING",
        hash: "hash123",
      }),
      getTransaction: vi.fn().mockResolvedValue({
        status: "SUCCESS",
        resultMetaXdr: "meta",
        resultXdr: "result",
      }),
    };

    mockSdk = {
      Address: vi.fn().mockImplementation(function(addr) {
        return { toString: () => addr };
      }),
      Account: vi.fn().mockImplementation(function(_addr, seq) {
        return { sequenceNumber: seq };
      }),
      Operation: {
        invokeContractFunction: vi.fn().mockReturnValue({}),
      },
      TransactionBuilder: (() => {
        const tb = vi.fn().mockImplementation(function() {
          return {
            addOperation: vi.fn().mockReturnThis(),
            setTimeout: vi.fn().mockReturnThis(),
            build: vi.fn().mockReturnValue({
              toXDR: () => "AAAA_TX_XDR",
            }),
          };
        });
        (tb as any).fromXDR = vi.fn().mockImplementation((xdr) => ({
          toXDR: () => xdr,
        }));
        return tb;
      })(),
      Networks: {
        TESTNET: "Test SDF Network ; September 2015",
      },
      nativeToScVal: vi.fn().mockImplementation((val) => val),
      scValToNative: vi.fn().mockImplementation((val) => val),
      rpc: {
        Server: vi.fn().mockImplementation(function() { return mockServer; }),
        assembleTransaction: vi.fn().mockReturnValue({
          build: vi.fn().mockReturnValue({
            toXDR: () => "AAAA_ASSEMBLED_XDR",
          }),
        }),
        Api: {
          isSimulationError: vi.fn().mockReturnValue(false),
        },
      },
      xdr: {
        SorobanAuthorizationEntry: {
          fromXDR: vi.fn().mockImplementation((_x) => ({
            preimage: () => ({
              toXDR: () => "preimage-xdr",
            }),
          })),
        },
      },
    };

    stellarService.setMockFreighter(mockFreighter);
    stellarService.setMockStellarSdk(mockSdk);
  });

  describe("Wallet Initialization & Connection", () => {
    it("initializes account when Freighter is connected", async () => {
      const account = await stellarService.initialize();
      expect(account).toBe(mockAddress);
      expect(stellarService.getAccount()).toBe(mockAddress);
    });

    it("fails initialization gracefully when Freighter is not connected", async () => {
      mockFreighter.isConnected.mockResolvedValue(false);
      const account = await stellarService.initialize();
      expect(account).toBeNull();
      expect(stellarService.getAccount()).toBeNull();
    });

    it("connectWallet returns address when successful", async () => {
      const address = await stellarService.connectWallet();
      expect(address).toBe(mockAddress);
    });

    it("connectWallet throws when Freighter is not installed", async () => {
      mockFreighter.isConnected.mockResolvedValue(false);
      await expect(stellarService.connectWallet()).rejects.toThrow("Freighter wallet extension is not installed");
    });

    it("connectWallet throws when address is empty", async () => {
      mockFreighter.getAddress.mockResolvedValue("");
      await expect(stellarService.connectWallet()).rejects.toThrow("Failed to get address from Freighter wallet");
    });
  });

  describe("Fallback Local Mock Database Flow", () => {
    beforeEach(async () => {
      await stellarService.connectWallet();
    });

    it("performs all vault, document, request, invite, token, and public key flows locally", async () => {
      expect(stellarService.isConfigured()).toBe(false);

      // 1. Create Vault
      const vaultId = await stellarService.createVault("My Vault", "Desc", ["G_GUARDIAN_1"], 1);
      expect(vaultId).toBe(1);

      const vault = await stellarService.getVault(1);
      expect(vault).toBeDefined();
      expect(vault?.name).toBe("My Vault");

      const myVaults = await stellarService.fetchVaultsForAccount(mockAddress);
      expect(myVaults.length).toBe(1);

      // 2. Add Document
      const docId = await stellarService.addDocument(1, "meta", "ipfsHash", 1, 0, ["G_GUARDIAN_1"], ["share1"]);
      expect(docId).toBe(1);

      const docs = await stellarService.fetchDocumentsForVaults([1]);
      expect(docs.length).toBe(1);
      expect(docs[0].ipfsHash).toBe("ipfsHash");

      // 3. Request Access
      const reqId = await stellarService.requestAccess(1);
      expect(reqId).toBe(1);

      // 4. Invites
      const invites = await stellarService.getPendingInvites("G_GUARDIAN_1");
      expect(invites.length).toBe(1);
      expect(invites[0].vaultId).toBe(1);

      // 5. Guardian Approvals
      const pending = await stellarService.fetchPendingApprovalsForGuardian(mockAddress);
      expect(pending.length).toBe(1);
      expect(pending[0].requestId).toBe(1);

      await stellarService.approveAccess(1, "encryptedShareForBeneficiary");
      const savedShare = await stellarService.getBeneficiaryKeyShare(1, mockAddress);
      expect(savedShare).toBe("encryptedShareForBeneficiary");

      const guardianShare = await stellarService.getEncryptedGuardianShare(1, "G_GUARDIAN_1");
      expect(guardianShare).toBe("share1");

      // 6. Public Keys
      await stellarService.registerPublicKey("PUB_KEY_XYZ");
      const retrievedPubKey = await stellarService.getUserPublicKey(mockAddress);
      expect(retrievedPubKey).toBe("PUB_KEY_XYZ");

      // 7. Access Passes / Tokens
      const hasPassBefore = await stellarService.hasVaultToken(mockAddress, 1);
      expect(hasPassBefore).toBe(false);

      const tokenId = await stellarService.mintAccessToken(1, mockAddress, "tokenURI");
      expect(tokenId).toBe(1);

      const hasPassAfter = await stellarService.hasVaultToken(mockAddress, 1);
      expect(hasPassAfter).toBe(true);

      const userTokens = await stellarService.fetchUserTokens(mockAddress);
      expect(userTokens.length).toBe(1);
      expect(userTokens[0].tokenId).toBe(1);
    });

    it("hasVaultToken returns false for invalid parameters", async () => {
      const res = await stellarService.hasVaultToken("", 0);
      expect(res).toBe(false);
    });
  });

  describe("Stellar/Soroban Real Contract Invocation Flow", () => {
    beforeEach(async () => {
      // Configure contract ID so isConfigured() returns true
      await stellarService.initialize("CC_CONTRACT_ID");
      await stellarService.connectWallet();
    });

    it("runs executeSorobanQuery and returns the return value successfully", async () => {
      mockServer.simulateTransaction.mockResolvedValue({
        results: [{
          retval: "public-key-value",
        }],
      });

      const pubKey = await stellarService.getUserPublicKey("GBB4JST...");
      expect(pubKey).toBe("public-key-value");
      expect(mockServer.simulateTransaction).toHaveBeenCalled();
    });

    it("runs executeSorobanCall, simulates, assembles, signs, and polls successfully", async () => {
      mockServer.simulateTransaction.mockResolvedValue({
        results: [{
          retval: 42,
          auth: [],
        }],
      });

      const vaultId = await stellarService.createVault("Real Vault", "Soroban", [], 1);
      expect(vaultId).toBe(42);
      expect(mockServer.simulateTransaction).toHaveBeenCalled();
      expect(mockSdk.rpc.assembleTransaction).toHaveBeenCalled();
      expect(mockFreighter.signTransaction).toHaveBeenCalled();
      expect(mockServer.sendTransaction).toHaveBeenCalled();
      expect(mockServer.getTransaction).toHaveBeenCalled();
    });

    it("extracts and signs auth entries using Freighter during executeSorobanCall", async () => {
      const mockAuthEntry = {
        preimage: () => ({
          toXDR: () => "preimage-xdr-data",
        }),
      };

      mockServer.simulateTransaction.mockResolvedValue({
        results: [{
          retval: 123,
          auth: [mockAuthEntry],
        }],
      });

      const docId = await stellarService.addDocument(1, "meta", "ipfs", 1, 0, [], []);
      expect(docId).toBe(123);
      expect(mockFreighter.signAuthEntry).toHaveBeenCalledWith("preimage-xdr-data");
    });

    it("throws error when simulation fails during executeSorobanCall", async () => {
      mockSdk.rpc.Api.isSimulationError.mockReturnValue(true);
      mockServer.simulateTransaction.mockResolvedValue({
        error: "Resource limit exceeded",
      });

      await expect(stellarService.createVault("Fail Vault", "Soroban", [], 1)).rejects.toThrow("Simulation failed: Resource limit exceeded");
    });

    it("throws error when Freighter signAuthEntry fails", async () => {
      const mockAuthEntry = {
        preimage: () => ({
          toXDR: () => "preimage-xdr-data",
        }),
      };

      mockServer.simulateTransaction.mockResolvedValue({
        results: [{
          retval: 123,
          auth: [mockAuthEntry],
        }],
      });

      mockFreighter.signAuthEntry.mockResolvedValue({ error: "User rejected auth entry signing" });

      await expect(stellarService.createVault("Fail Vault", "Soroban", [], 1)).rejects.toThrow("Freighter auth entry signing failed: User rejected auth entry signing");
    });

    it("throws error when Freighter envelope signing is rejected", async () => {
      mockFreighter.signTransaction.mockResolvedValue(null);

      await expect(stellarService.createVault("Fail Vault", "Soroban", [], 1)).rejects.toThrow("Transaction signing rejected or failed");
    });

    it("throws error when sendTransaction returns ERROR status", async () => {
      mockServer.sendTransaction.mockResolvedValue({
        status: "ERROR",
        errorResult: "invalid tx sequence",
      });

      await expect(stellarService.createVault("Fail Vault", "Soroban", [], 1)).rejects.toThrow("Transaction submission failed: \"invalid tx sequence\"");
    });

    it("throws error when transaction execution fails during polling", async () => {
      mockServer.getTransaction.mockResolvedValue({
        status: "FAILED",
        resultXdr: "Error codes X, Y, Z",
      });

      await expect(stellarService.createVault("Fail Vault", "Soroban", [], 1)).rejects.toThrow("Transaction execution failed: \"Error codes X, Y, Z\"");
    });

    it("throws error when transaction polling times out", async () => {
      mockServer.getTransaction.mockResolvedValue({
        status: "PENDING",
      });

      await expect(stellarService.createVault("Timeout Vault", "Soroban", [], 1)).rejects.toThrow("Transaction polling timed out");
    });

    it("performs all other contract invocation entrypoints", async () => {
      mockServer.simulateTransaction.mockResolvedValue({
        results: [{
          retval: null,
          auth: [],
        }],
      });

      await stellarService.approveAccess(1, "encryptedShare");
      await stellarService.acceptGuardianInvite(1);
      await stellarService.registerPublicKey("PUBKEY");

      mockServer.simulateTransaction.mockResolvedValue({
        results: [{
          retval: true,
        }],
      });
      const hasToken = await stellarService.hasVaultToken(mockAddress, 1);
      expect(hasToken).toBe(true);

      mockServer.simulateTransaction.mockResolvedValue({
        results: [{
          retval: 99,
        }],
      });
      const tokenId = await stellarService.mintAccessToken(1, mockAddress, "tokenURI");
      expect(tokenId).toBe(99);

      mockServer.simulateTransaction.mockResolvedValue({
        results: [{
          retval: 5,
        }],
      });
      const requestId = await stellarService.requestAccess(1);
      expect(requestId).toBe(5);
    });
  });
});
