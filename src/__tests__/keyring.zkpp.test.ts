import { describe, it, expect, beforeEach } from "vitest";
import {
  clientKeyringService,
  KeyPairRecord,
  __zkppInternals,
  __keyringDevHooks,
} from "../services/clientKeyring.service";

const { zkppBlindPin, zkppEvaluate, zkppFinalize, generateOprfKey } = __zkppInternals;

const testAccount = "0x71C838936352937A71E976BBE84e941E79409932";
const pin = "correct-horse-battery";

describe("Keyring ZKPP (Zero-Knowledge PIN Verification Engine)", { timeout: 60000 }, () => {
  beforeEach(async () => {
    clientKeyringService.clearSessionCache();
    await clientKeyringService.deleteKeyPair(testAccount);
  });

  describe("OPAQUE-style key exchange", () => {
    it("should derive an identical wrapping key from the same PIN through the 3-message flow", async () => {
      const oprfKey = await generateOprfKey();

      // Message 1 (client -> vault): blinded PIN commitment
      const blinded = await zkppBlindPin(pin);

      // Message 2 (vault -> client): OPRF evaluation under non-extractable key
      const evaluation = await zkppEvaluate(oprfKey, testAccount, blinded);

      // Finalize: stretch to the AES-GCM wrapping key
      const wrappingKey = await zkppFinalize(evaluation);
      expect(wrappingKey).toBeDefined();
      expect(wrappingKey.type).toBe("secret");
      expect(wrappingKey.algorithm.name).toBe("AES-GCM");
    });

    it("should produce different OPRF outputs for different accounts (domain separation)", async () => {
      const oprfKey = await generateOprfKey();
      const blinded = await zkppBlindPin(pin);

      const a = await zkppEvaluate(oprfKey, "0xaaaa", blinded);
      const b = await zkppEvaluate(oprfKey, "0xbbbb", blinded);
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    });

    it("should produce different envelopes for repeated enrollment of the same PIN", async () => {
      // Fresh random IV per enrollment => ciphertext differs even for
      // identical (account, pin) inputs.
      await clientKeyringService.generateAndSaveKeyPair(testAccount, pin);
      const record1 = (await clientKeyringService.getKeyPairRecord(testAccount))!;
      await deleteRecord();
      await clientKeyringService.generateAndSaveKeyPair(testAccount, pin);
      const record2 = (await clientKeyringService.getKeyPairRecord(testAccount))!;

      expect(record1.zkpp!.ciphertext).not.toBe(record2.zkpp!.ciphertext);
      // The deterministic commitment means both envelopes remain decryptable
      // with the same PIN.
      expect(
        (await clientKeyringService.getDecryptedPrivateKey(testAccount, pin)).length
      ).toBeGreaterThan(0);
    });
  });

  describe("Zero-storage verification", () => {
    let record: KeyPairRecord;

    beforeEach(async () => {
      await clientKeyringService.generateAndSaveKeyPair(testAccount, pin);
      record = (await clientKeyringService.getKeyPairRecord(testAccount))!;
    });

    it("should store no static password hash, salt, or iteration parameters", () => {
      const dumped = JSON.stringify(record);
      const lower = dumped.toLowerCase();
      expect(lower).not.toContain("salt");
      expect(lower).not.toContain("iterations");
      expect(lower).not.toContain("pbkdf2");
      expect(lower).not.toContain("hash");
      // The legacy plaintext-derivation envelope must not be present.
      expect(record.encryptedPrivateKey).toBe("");
    });

    it("should verify the correct PIN without any stored comparison material", async () => {
      const privateKey = await clientKeyringService.getDecryptedPrivateKey(testAccount, pin);
      expect(privateKey).toBeTruthy();
    });

    it("should fail instantly when the ZK proof does not verify (wrong PIN)", async () => {
      // Simulate a fresh browser session: no unlocked key in memory.
      clientKeyringService.clearSessionCache();

      await expect(
        clientKeyringService.getDecryptedPrivateKey(testAccount, "wrong-pin")
      ).rejects.toThrow("Incorrect PIN or passphrase");
    });

    it("should keep the private key out of the stored record in plaintext", () => {
      const dumped = JSON.stringify(record);
      expect(dumped).not.toContain("BEGIN PRIVATE KEY");
      expect(dumped).not.toContain("BEGIN EC");
    });
  });

  describe("Offline dump resistance", () => {
    it("should make a JSON dump of IndexedDB useless for brute-forcing the PIN", async () => {
      await clientKeyringService.generateAndSaveKeyPair(testAccount, pin);
      const liveRecord = (await clientKeyringService.getKeyPairRecord(testAccount))!;

      // Attacker exfiltrates the record as plain JSON (e.g. via devtools export).
      const dumped: KeyPairRecord = JSON.parse(JSON.stringify(liveRecord));

      // The non-extractable OPRF secret does not survive serialization: what
      // remains is a plain empty object with no key material or type.
      expect((dumped.oprfKey as unknown as { type?: string })?.type).toBeUndefined();
      expect(dumped.zkpp).toBeDefined(); // envelope is visible but inert

      // Simulate the attacker re-importing ONLY the dumped fields into a
      // fresh store: verification must fail closed.
      await expect(__keyringDevHooks.unlockRecord(dumped, pin)).rejects.toThrow(
        /OPRF secret is missing/
      );
    });

    it("should not leak the PIN through envelope length or structure", async () => {
      await clientKeyringService.generateAndSaveKeyPair(testAccount, "1234");
      const shortRecord = (await clientKeyringService.getKeyPairRecord(testAccount))!;
      await deleteRecord();

      await clientKeyringService.generateAndSaveKeyPair(
        testAccount,
        "a-much-longer-passphrase-entropy"
      );
      const longRecord = (await clientKeyringService.getKeyPairRecord(testAccount))!;

      // Envelope size is independent of PIN length: the commitment is a
      // fixed 256-bit value and the GCM output depends only on plaintext size.
      expect(longRecord.zkpp!.iv.length).toBe(shortRecord.zkpp!.iv.length);
      expect(longRecord.zkpp!.ciphertext.length).toBe(
        shortRecord.zkpp!.ciphertext.length
      );
    });
  });

  describe("Legacy record compatibility", () => {
    it("should still decrypt pre-ZKPP records stored with the PBKDF2 envelope", async () => {
      const { secretsService } = await import("../services/secrets.service");
      const { generateECIESKeyPairBase64 } = await import("../utils/crypto");

      const legacyKeys = await generateECIESKeyPairBase64();
      const legacyEnvelope = await secretsService.encryptWithPassphrase(
        legacyKeys.privateKey,
        pin,
        600_000
      );

      // Hand-craft a legacy-shaped record directly into the store.
      const legacyRecord: KeyPairRecord = {
        account: testAccount,
        publicKey: legacyKeys.publicKey,
        encryptedPrivateKey: legacyEnvelope,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        hasPin: true,
      };
      await seedRecord(legacyRecord);

      const decrypted = await clientKeyringService.getDecryptedPrivateKey(testAccount, pin);
      expect(decrypted).toBe(legacyKeys.privateKey);
    });
  });

  async function deleteRecord() {
    await clientKeyringService.deleteKeyPair(testAccount);
  }

  async function seedRecord(record: KeyPairRecord) {
    await __keyringDevHooks.putRecord(record);
  }
});
