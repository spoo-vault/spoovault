import { describe, it, expect, beforeEach } from "vitest";
import { clientKeyringService } from "../services/clientKeyring.service";
import { generateECIESKeyPairBase64, encryptWithPublicKey, decryptWithPrivateKey } from "../utils/crypto";

describe("ClientKeyringService (IndexedDB & Secure Key Management)", () => {
  const testAccount = "0x71C838936352937A71E976BBE84e941E79409932";
  const testAccount2 = "0x2546BcD3c84621e976D8185a91A922aE77ECEc30";

  beforeEach(async () => {
    clientKeyringService.clearSessionCache();
    await clientKeyringService.deleteKeyPair(testAccount);
    await clientKeyringService.deleteKeyPair(testAccount2);
  });

  describe("Key Generation & Storage", () => {
    it("should report hasKeyPair as false before key is created", async () => {
      const exists = await clientKeyringService.hasKeyPair(testAccount);
      expect(exists).toBe(false);
    });

    it("should generate and store a new keypair in zero-prompt (default derivation) mode", async () => {
      const { publicKey } = await clientKeyringService.generateAndSaveKeyPair(testAccount);
      expect(publicKey).toBeDefined();
      expect(publicKey.length).toBeGreaterThan(0);

      const exists = await clientKeyringService.hasKeyPair(testAccount);
      expect(exists).toBe(true);

      const storedPub = await clientKeyringService.getStoredPublicKey(testAccount);
      expect(storedPub).toBe(publicKey);

      const record = await clientKeyringService.getKeyPairRecord(testAccount);
      expect(record?.hasPin).toBe(false);
      expect(record?.encryptedPrivateKey).toBeDefined();
      // Ensure private key is NOT in plaintext
      expect(record?.encryptedPrivateKey).not.toContain("BEGIN PRIVATE KEY");
    });

    it("should generate and store a new keypair with a custom user PIN/passphrase", async () => {
      const pin = "secure-pin-9876";
      await clientKeyringService.generateAndSaveKeyPair(testAccount, pin);

      const record = await clientKeyringService.getKeyPairRecord(testAccount);
      expect(record?.hasPin).toBe(true);

      // Decrypt with correct PIN
      clientKeyringService.clearSessionCache();
      const privateKey = await clientKeyringService.getDecryptedPrivateKey(testAccount, pin);
      expect(privateKey).toBeDefined();
      expect(privateKey.length).toBeGreaterThan(0);
    });

    it("should fail decryption when incorrect PIN is provided", async () => {
      const correctPin = "my-secret-pin-4321";
      await clientKeyringService.generateAndSaveKeyPair(testAccount, correctPin);

      // Clear session cache to force decryption from storage
      clientKeyringService.clearSessionCache();

      await expect(
        clientKeyringService.getDecryptedPrivateKey(testAccount, "wrong-pin-0000")
      ).rejects.toThrow("Incorrect PIN or passphrase");
    });

    it("should save existing keypair directly and validate key formats", async () => {
      const generated = await generateECIESKeyPairBase64();
      await clientKeyringService.saveKeyPair(
        testAccount,
        generated.publicKey,
        generated.privateKey,
        "pin-123"
      );

      const storedPub = await clientKeyringService.getStoredPublicKey(testAccount);
      expect(storedPub).toBe(generated.publicKey);

      clientKeyringService.clearSessionCache();
      const decryptedPriv = await clientKeyringService.getDecryptedPrivateKey(testAccount, "pin-123");
      expect(decryptedPriv).toBe(generated.privateKey);
    });
  });

  describe("Session Caching & Lock Operations", () => {
    it("should cache decrypted private key in active session to prevent repeated PIN prompts", async () => {
      const pin = "session-test-pin";
      await clientKeyringService.generateAndSaveKeyPair(testAccount, pin);

      expect(clientKeyringService.isUnlocked(testAccount)).toBe(true);

      // Subsequent call without PIN should succeed from session cache
      const cachedPriv = await clientKeyringService.getDecryptedPrivateKey(testAccount);
      expect(cachedPriv).toBeDefined();
    });

    it("should lock account and clear session cache properly", async () => {
      await clientKeyringService.generateAndSaveKeyPair(testAccount, "some-pin");
      expect(clientKeyringService.isUnlocked(testAccount)).toBe(true);

      clientKeyringService.lockAccount(testAccount);
      expect(clientKeyringService.isUnlocked(testAccount)).toBe(false);

      // Calling without PIN should fail now
      await expect(
        clientKeyringService.getDecryptedPrivateKey(testAccount)
      ).rejects.toThrow("Incorrect PIN or passphrase");
    });

    it("should clear entire session cache with clearSessionCache()", async () => {
      await clientKeyringService.generateAndSaveKeyPair(testAccount);
      await clientKeyringService.generateAndSaveKeyPair(testAccount2);

      expect(clientKeyringService.isUnlocked(testAccount)).toBe(true);
      expect(clientKeyringService.isUnlocked(testAccount2)).toBe(true);

      clientKeyringService.clearSessionCache();

      expect(clientKeyringService.isUnlocked(testAccount)).toBe(false);
      expect(clientKeyringService.isUnlocked(testAccount2)).toBe(false);
    });
  });

  describe("End-to-End Keyring Encryption & Decryption", () => {
    it("should encrypt with keyring public key and decrypt with keyring private key", async () => {
      const { publicKey } = await clientKeyringService.generateAndSaveKeyPair(testAccount);
      const secretShare = "3-4f8a9b2c1d0e3f4a5b6c7d8e9f0a1b2c";

      const encrypted = await encryptWithPublicKey(secretShare, publicKey);
      const privateKey = await clientKeyringService.getDecryptedPrivateKey(testAccount);
      const decrypted = await decryptWithPrivateKey(encrypted, privateKey);

      expect(decrypted).toBe(secretShare);
    });
  });

  describe("Backup Export & Import", () => {
    it("should export a passphrase-encrypted backup and import it successfully", async () => {
      const backupPassphrase = "Backup-Super-Secret-Passphrase-2026";
      const { publicKey } = await clientKeyringService.generateAndSaveKeyPair(testAccount, "pin-111");

      const backupJson = await clientKeyringService.exportKeyBackup(
        testAccount,
        backupPassphrase,
        "pin-111"
      );

      const parsed = JSON.parse(backupJson);
      expect(parsed.version).toBe("spoovault-keyring-backup-v1");
      expect(parsed.account).toBe(testAccount.toLowerCase());
      expect(parsed.publicKey).toBe(publicKey);

      // Delete key from storage
      await clientKeyringService.deleteKeyPair(testAccount);
      expect(await clientKeyringService.hasKeyPair(testAccount)).toBe(false);

      // Restore from backup
      const restored = await clientKeyringService.importKeyBackup(
        testAccount,
        backupJson,
        backupPassphrase,
        "new-pin-222"
      );

      expect(restored.publicKey).toBe(publicKey);
      expect(await clientKeyringService.hasKeyPair(testAccount)).toBe(true);

      clientKeyringService.clearSessionCache();
      const restoredPriv = await clientKeyringService.getDecryptedPrivateKey(testAccount, "new-pin-222");
      expect(restoredPriv).toBeDefined();
    }, 20000);

    it("should reject backup import if backup passphrase is incorrect", async () => {

      const backupPassphrase = "Real-Passphrase-123";
      await clientKeyringService.generateAndSaveKeyPair(testAccount);

      const backupJson = await clientKeyringService.exportKeyBackup(
        testAccount,
        backupPassphrase
      );

      await expect(
        clientKeyringService.importKeyBackup(
          testAccount,
          backupJson,
          "Wrong-Passphrase-999"
        )
      ).rejects.toThrow("Incorrect backup passphrase");
    }, 20000);
  });


  describe("Account List & Deletion", () => {
    it("should list accounts and delete properly", async () => {
      await clientKeyringService.generateAndSaveKeyPair(testAccount);
      await clientKeyringService.generateAndSaveKeyPair(testAccount2);

      const accounts = await clientKeyringService.listAccounts();
      expect(accounts).toContain(testAccount.toLowerCase());
      expect(accounts).toContain(testAccount2.toLowerCase());

      await clientKeyringService.deleteKeyPair(testAccount);
      expect(await clientKeyringService.hasKeyPair(testAccount)).toBe(false);
      expect(await clientKeyringService.hasKeyPair(testAccount2)).toBe(true);
    });
  });
});
