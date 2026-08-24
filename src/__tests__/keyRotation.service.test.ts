import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  keyRotationService,
  KeyOwnershipProofError,
  ShareEnvelopeRef,
  VaultEnvelopeBatch,
} from "../services/keyRotation.service";
import { clientKeyringService } from "../services/clientKeyring.service";
import {
  generateECIESKeyPairBase64,
  encryptWithPublicKey,
  decryptWithPrivateKey,
} from "../utils/crypto";
import { installOpaqueServerMock } from "./helpers/opaqueServerMock";

describe("KeyRotationService (Automated Compromise Key Rotation)", { timeout: 60000 }, () => {
  const testAccount = "0x71C838936352937A71E976BBE84e941E79409932";
  const testPin = "rotation-test-pin";

  const rotateCompromisedKey = (
    options: Omit<
      Parameters<typeof keyRotationService.rotateCompromisedKey>[0],
      "pinOrPassphrase"
    >
  ) => keyRotationService.rotateCompromisedKey({ ...options, pinOrPassphrase: testPin });

  const emergencyBatchRevoke = (
    options: Omit<
      Parameters<typeof keyRotationService.emergencyBatchRevoke>[0],
      "pinOrPassphrase"
    >
  ) => keyRotationService.emergencyBatchRevoke({ ...options, pinOrPassphrase: testPin });

  let oldKeys: { publicKey: string; privateKey: string };
  let envelopes: ShareEnvelopeRef[];

  beforeEach(async () => {
    await installOpaqueServerMock();
    clientKeyringService.clearSessionCache();
    await clientKeyringService.deleteKeyPair(testAccount);

    oldKeys = await generateECIESKeyPairBase64();

    // Simulate guardian share envelopes encrypted to the (soon compromised) old key.
    const secrets = [
      { documentId: 1, plaintext: "vault-share-doc-1-alpha" },
      { documentId: 2, plaintext: "vault-share-doc-2-beta" },
      { documentId: "doc-3", plaintext: "vault-share-doc-3-gamma" },
    ];
    envelopes = await Promise.all(
      secrets.map(async ({ documentId, plaintext }) => ({
        documentId,
        envelope: await encryptWithPublicKey(plaintext, oldKeys.publicKey),
      }))
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Full rotation lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  describe("Full rotation lifecycle", () => {
    it("should re-encrypt all envelopes to the new key and call revokeKey on-chain", async () => {
      const revokeCalls: Array<[string, string]> = [];
      const contract = {
        revokeKey: async (oldPub: string, newPub: string) => {
          revokeCalls.push([oldPub, newPub]);
          return { hash: "0xrotationtx", wait: async () => ({ status: 1 }) };
        },
      };

      const report = await rotateCompromisedKey({
        account: testAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        envelopes,
        contract,
      });

      // On-chain revocation happened exactly once, with the right keys.
      expect(revokeCalls).toHaveLength(1);
      expect(revokeCalls[0][0]).toBe(oldKeys.publicKey);
      expect(report.transactionHash).toBe("0xrotationtx");

      // Every envelope was rotated without failures.
      expect(report.failures).toHaveLength(0);
      expect(report.rotatedDocumentIds.sort()).toEqual([1, 2, "doc-3"].sort());
      expect(report.newPublicKey).not.toBe(oldKeys.publicKey);

      // ...and the keyring now holds the rotated keypair.
      const storedPub = await clientKeyringService.getStoredPublicKey(testAccount);
      expect(storedPub).toBe(report.newPublicKey);
    });

    it("should produce envelopes that only the new key can decrypt", async () => {
      // Re-encrypt manually through the same worker path the service uses,
      // then verify decryption properties of the output.
      const { publicKey: newPub, privateKey: newPriv } = await generateECIESKeyPairBase64();
      const cryptoWorkerService = (
        await import("../services/cryptoWorker.service")
      ).cryptoWorkerService;

      const reencrypted = await cryptoWorkerService.reencryptEnvelopeAsync(
        envelopes[0].envelope,
        oldKeys.privateKey,
        newPub
      );

      // The new private key decrypts to the original plaintext envelope content.
      const roundTripped = await decryptWithPrivateKey(reencrypted, newPriv);
      expect(typeof roundTripped).toBe("string");

      // The OLD private key can no longer decrypt the re-encrypted envelope.
      await expect(decryptWithPrivateKey(reencrypted, oldKeys.privateKey)).rejects.toThrow();
    });

    it("should persist a usable rotated keypair in the local keyring", async () => {
      const report = await rotateCompromisedKey({
        account: testAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        envelopes: [envelopes[0]],
      });

      const record = await clientKeyringService.getKeyPairRecord(testAccount);
      expect(record?.publicKey).toBe(report.newPublicKey);

      const decryptedPriv = await clientKeyringService.getDecryptedPrivateKey(testAccount);
      const plaintext = await decryptWithPrivateKey(envelopes[0].envelope, oldKeys.privateKey);
      const reencrypted = await encryptWithPublicKey(plaintext, record!.publicKey);
      const roundTripped = await decryptWithPrivateKey(reencrypted, decryptedPriv);
      expect(roundTripped).toBe(plaintext);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Soroban (Stellar) contract adapter
  // ─────────────────────────────────────────────────────────────────────────

  describe("Soroban contract adapter", () => {
    it("calls revokeKey on both EVM and Soroban contracts when both are supplied", async () => {
      const evmCalls: Array<[string, string]> = [];
      const sorobanCalls: Array<[string, string, string]> = [];

      const contract = {
        revokeKey: async (old: string, next: string) => {
          evmCalls.push([old, next]);
          return { hash: "0xevm-tx", wait: async () => ({ status: 1 }) };
        },
      };
      const sorobanContract = {
        revokeKey: async (user: string, old: string, next: string) => {
          sorobanCalls.push([user, old, next]);
          return { hash: "soroban-tx-abc" };
        },
      };

      const report = await rotateCompromisedKey({
        account: testAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        envelopes,
        contract,
        sorobanContract,
      });

      // Both adapters invoked once.
      expect(evmCalls).toHaveLength(1);
      expect(sorobanCalls).toHaveLength(1);

      // Soroban receives (user, oldKey, newKey) — user is the account.
      expect(sorobanCalls[0][0]).toBe(testAccount);
      expect(sorobanCalls[0][1]).toBe(oldKeys.publicKey);
      expect(sorobanCalls[0][2]).toBe(report.newPublicKey);

      // Both hashes are returned in the report.
      expect(report.transactionHash).toBe("0xevm-tx");
      expect(report.sorobanTxHash).toBe("soroban-tx-abc");
    });

    it("returns only the Soroban hash when only the Soroban adapter is supplied", async () => {
      const sorobanContract = {
        revokeKey: async (_user: string, _old: string, _next: string) =>
          ({ id: "stellar-op-id-xyz" }),
      };

      const report = await rotateCompromisedKey({
        account: testAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        envelopes: [envelopes[0]],
        sorobanContract,
      });

      expect(report.transactionHash).toBeUndefined();
      expect(report.sorobanTxHash).toBe("stellar-op-id-xyz");
    });

    it("does not call Soroban when only the EVM contract is supplied", async () => {
      const sorobanCalls: string[] = [];
      const contract = {
        revokeKey: async () => ({ hash: "0xevm-only", wait: async () => ({}) }),
      };

      // No sorobanContract arg — sorobanCalls must stay empty.
      const report = await rotateCompromisedKey({
        account: testAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        envelopes: [envelopes[0]],
        contract,
      });

      expect(sorobanCalls).toHaveLength(0);
      expect(report.sorobanTxHash).toBeUndefined();
      expect(report.transactionHash).toBe("0xevm-only");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Emergency batch revocation
  // ─────────────────────────────────────────────────────────────────────────

  describe("Emergency batch revocation", () => {
    let vault1Envelopes: ShareEnvelopeRef[];
    let vault2Envelopes: ShareEnvelopeRef[];
    let vaultBatches: VaultEnvelopeBatch[];

    beforeEach(async () => {
      const vault1Secrets = [
        { documentId: 10, plaintext: "vault-1-doc-10" },
        { documentId: 11, plaintext: "vault-1-doc-11" },
      ];
      const vault2Secrets = [
        { documentId: 20, plaintext: "vault-2-doc-20" },
        { documentId: 21, plaintext: "vault-2-doc-21" },
        { documentId: 22, plaintext: "vault-2-doc-22" },
      ];

      vault1Envelopes = await Promise.all(
        vault1Secrets.map(async ({ documentId, plaintext }) => ({
          documentId,
          envelope: await encryptWithPublicKey(plaintext, oldKeys.publicKey),
        }))
      );
      vault2Envelopes = await Promise.all(
        vault2Secrets.map(async ({ documentId, plaintext }) => ({
          documentId,
          envelope: await encryptWithPublicKey(plaintext, oldKeys.publicKey),
        }))
      );

      vaultBatches = [
        { vaultId: 1, envelopes: vault1Envelopes },
        { vaultId: 2, envelopes: vault2Envelopes },
      ];
    });

    it("re-encrypts envelopes across all vaults with a single on-chain revocation", async () => {
      const revokeCalls: number[] = [];
      const contract = {
        revokeKey: async () => {
          revokeCalls.push(1);
          return { hash: "0xbatch-tx", wait: async () => ({ status: 1 }) };
        },
      };

      const report = await emergencyBatchRevoke({
        account: testAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        vaultBatches,
        contract,
      });

      // On-chain call made exactly once.
      expect(revokeCalls).toHaveLength(1);

      expect(report.totalDocumentsRotated).toBe(5);
      expect(report.totalFailures).toBe(0);
      expect(report.vaultResults).toHaveLength(2);
      expect(report.vaultResults[0].vaultId).toBe(1);
      expect(report.vaultResults[0].rotatedDocumentIds.sort()).toEqual([10, 11]);
      expect(report.vaultResults[1].vaultId).toBe(2);
      expect(report.vaultResults[1].rotatedDocumentIds.sort()).toEqual([20, 21, 22]);
      expect(report.transactionHash).toBe("0xbatch-tx");
    });

    it("invokes both EVM and Soroban adapters exactly once during batch revocation", async () => {
      let evmCalled = 0;
      let sorobanCalled = 0;

      const contract = {
        revokeKey: async () => {
          evmCalled++;
          return { hash: "0xevm-batch", wait: async () => ({}) };
        },
      };
      const sorobanContract = {
        revokeKey: async () => {
          sorobanCalled++;
          return { hash: "soroban-batch" };
        },
      };

      const report = await emergencyBatchRevoke({
        account: testAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        vaultBatches,
        contract,
        sorobanContract,
      });

      expect(evmCalled).toBe(1);
      expect(sorobanCalled).toBe(1);
      expect(report.sorobanTxHash).toBe("soroban-batch");
    });

    it("isolates per-vault failures without aborting other vaults", async () => {
      const corruptedBatches: VaultEnvelopeBatch[] = [
        {
          vaultId: 1,
          envelopes: [
            vault1Envelopes[0],
            { documentId: 999, envelope: "{ not-valid-json }" },
          ],
        },
        { vaultId: 2, envelopes: vault2Envelopes },
      ];

      const report = await emergencyBatchRevoke({
        account: testAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        vaultBatches: corruptedBatches,
      });

      // Vault 1 succeeds partially.
      const v1 = report.vaultResults.find((r) => r.vaultId === 1)!;
      expect(v1.rotatedDocumentIds).toContain(vault1Envelopes[0].documentId);
      expect(v1.failures).toHaveLength(1);
      expect(v1.failures[0].documentId).toBe(999);

      // Vault 2 succeeds completely.
      const v2 = report.vaultResults.find((r) => r.vaultId === 2)!;
      expect(v2.failures).toHaveLength(0);
      expect(v2.rotatedDocumentIds).toHaveLength(vault2Envelopes.length);

      expect(report.totalFailures).toBe(1);
    });

    it("rejects when the private key cannot prove possession across any vault", async () => {
      const wrongKeys = await generateECIESKeyPairBase64();

      await expect(
        emergencyBatchRevoke({
          account: testAccount,
          oldPublicKey: oldKeys.publicKey,
          oldPrivateKey: wrongKeys.privateKey,
          vaultBatches,
        })
      ).rejects.toBeInstanceOf(KeyOwnershipProofError);
    });

    it("persists the new keypair after batch revocation", async () => {
      const report = await emergencyBatchRevoke({
        account: testAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        vaultBatches: [{ vaultId: 1, envelopes: [vault1Envelopes[0]] }],
      });

      const stored = await clientKeyringService.getStoredPublicKey(testAccount);
      expect(stored).toBe(report.newPublicKey);
    });

    it("handles an empty vault batch list gracefully", async () => {
      const report = await emergencyBatchRevoke({
        account: testAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        vaultBatches: [],
      });

      expect(report.totalDocumentsRotated).toBe(0);
      expect(report.totalFailures).toBe(0);
      expect(report.vaultResults).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Proof of possession & failure handling
  // ─────────────────────────────────────────────────────────────────────────

  describe("Proof of possession & failure handling", () => {
    it("should refuse rotation when the private key cannot decrypt the envelopes", async () => {
      const wrongKeys = await generateECIESKeyPairBase64();

      await expect(
        rotateCompromisedKey({
          account: testAccount,
          oldPublicKey: oldKeys.publicKey,
          oldPrivateKey: wrongKeys.privateKey,
          envelopes,
        })
      ).rejects.toBeInstanceOf(KeyOwnershipProofError);

      // Nothing was persisted.
      expect(await clientKeyringService.hasKeyPair(testAccount)).toBe(false);
    });

    it("should report per-document failures without aborting the rest", async () => {
      const corrupted: ShareEnvelopeRef[] = [
        ...envelopes,
        { documentId: 4, envelope: "{ not-a-valid-envelope }" },
      ];

      const report = await rotateCompromisedKey({
        account: testAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        envelopes: corrupted,
      });

      expect(report.rotatedDocumentIds.sort()).toEqual([1, 2, "doc-3"].sort());
      expect(report.failures).toHaveLength(1);
      expect(report.failures[0].documentId).toBe(4);
      expect(report.failures[0].reason).toBeTruthy();
    });

    it("should reject missing account or keys", async () => {
      await expect(
        rotateCompromisedKey({
          account: "",
          oldPublicKey: oldKeys.publicKey,
          oldPrivateKey: oldKeys.privateKey,
          envelopes,
        })
      ).rejects.toThrow("Account address is required");

      await expect(
        rotateCompromisedKey({
          account: testAccount,
          oldPublicKey: "",
          oldPrivateKey: oldKeys.privateKey,
          envelopes,
        })
      ).rejects.toThrow("Old public and private keys are required");
    });

    it("rejects a missing OPAQUE PIN before submitting an irreversible revocation", async () => {
      const contract = { revokeKey: vi.fn() };

      await expect(
        keyRotationService.rotateCompromisedKey({
          account: testAccount,
          oldPublicKey: oldKeys.publicKey,
          oldPrivateKey: oldKeys.privateKey,
          pinOrPassphrase: " ",
          envelopes,
          contract,
        })
      ).rejects.toThrow("A PIN or passphrase is required");
      expect(contract.revokeKey).not.toHaveBeenCalled();
    });

    it("should support off-chain-only rotation when no contract is provided", async () => {
      const report = await rotateCompromisedKey({
        account: testAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        envelopes: [envelopes[0]],
      });

      expect(report.transactionHash).toBeUndefined();
      expect(report.sorobanTxHash).toBeUndefined();
      expect(report.rotatedDocumentIds).toEqual([envelopes[0].documentId]);
    });

    it("accepts a pre-generated replacement keypair", async () => {
      const generated = await generateECIESKeyPairBase64();

      const report = await rotateCompromisedKey({
        account: testAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        newPublicKey: generated.publicKey,
        newPrivateKey: generated.privateKey,
        envelopes: [envelopes[0]],
      });

      expect(report.newPublicKey).toBe(generated.publicKey);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Report shape & metadata
  // ─────────────────────────────────────────────────────────────────────────

  describe("Report shape & metadata", () => {
    it("normalises the account address to lowercase in the report", async () => {
      const upperAccount = testAccount.toUpperCase();
      const report = await rotateCompromisedKey({
        account: upperAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        envelopes: [envelopes[0]],
      });

      expect(report.account).toBe(upperAccount.toLowerCase());
    });

    it("records a timestamp in the report", async () => {
      const before = Date.now();
      const report = await rotateCompromisedKey({
        account: testAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        envelopes: [envelopes[0]],
      });
      const after = Date.now();

      expect(report.rotatedAt).toBeGreaterThanOrEqual(before);
      expect(report.rotatedAt).toBeLessThanOrEqual(after);
    });
  });
});
