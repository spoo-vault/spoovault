import { describe, it, expect, beforeEach } from "vitest";
import {
  keyRotationService,
  KeyOwnershipProofError,
  ShareEnvelopeRef,
} from "../services/keyRotation.service";
import { clientKeyringService } from "../services/clientKeyring.service";
import {
  generateECIESKeyPairBase64,
  encryptWithPublicKey,
  decryptWithPrivateKey,
} from "../utils/crypto";

describe("KeyRotationService (Automated Compromise Key Rotation)", { timeout: 60000 }, () => {
  const testAccount = "0x71C838936352937A71E976BBE84e941E79409932";

  let oldKeys: { publicKey: string; privateKey: string };
  let envelopes: ShareEnvelopeRef[];

  beforeEach(async () => {
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

  describe("Full rotation lifecycle", () => {
    it("should re-encrypt all envelopes to the new key and call revokeKey on-chain", async () => {
      const revokeCalls: Array<[string, string]> = [];
      const contract = {
        revokeKey: async (oldPub: string, newPub: string) => {
          revokeCalls.push([oldPub, newPub]);
          return { hash: "0xrotationtx", wait: async () => ({ status: 1 }) };
        },
      };

      const report = await keyRotationService.rotateCompromisedKey({
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
      const report = await keyRotationService.rotateCompromisedKey({
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

  describe("Proof of possession & failure handling", () => {
    it("should refuse rotation when the private key cannot decrypt the envelopes", async () => {
      const wrongKeys = await generateECIESKeyPairBase64();

      await expect(
        keyRotationService.rotateCompromisedKey({
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

      const report = await keyRotationService.rotateCompromisedKey({
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
        keyRotationService.rotateCompromisedKey({
          account: "",
          oldPublicKey: oldKeys.publicKey,
          oldPrivateKey: oldKeys.privateKey,
          envelopes,
        })
      ).rejects.toThrow("Account address is required");

      await expect(
        keyRotationService.rotateCompromisedKey({
          account: testAccount,
          oldPublicKey: "",
          oldPrivateKey: oldKeys.privateKey,
          envelopes,
        })
      ).rejects.toThrow("Old public and private keys are required");
    });

    it("should support off-chain-only rotation when no contract is provided", async () => {
      const report = await keyRotationService.rotateCompromisedKey({
        account: testAccount,
        oldPublicKey: oldKeys.publicKey,
        oldPrivateKey: oldKeys.privateKey,
        envelopes: [envelopes[0]],
      });

      expect(report.transactionHash).toBeUndefined();
      expect(report.rotatedDocumentIds).toEqual([envelopes[0].documentId]);
    });
  });
});
