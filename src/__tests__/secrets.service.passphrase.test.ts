import { describe, it, expect } from "vitest";
import {
  PBKDF2_ITERATIONS,
  deriveKeyFromPassphrase,
  encryptWithPassphrase,
  decryptWithPassphrase,
} from "../services/secrets.service";

describe(
  "Passphrase-based key derivation (issue #20)",
  { timeout: 15000 },
  () => {
    it("should use 600,000 PBKDF2 iterations by default", () => {
      expect(PBKDF2_ITERATIONS).toBe(600_000);
    });

    describe("deriveKeyFromPassphrase", () => {
      it("should derive a non-extractable AES-256-GCM CryptoKey", async () => {
        const salt = new Uint8Array(16).fill(7);
        const key = await deriveKeyFromPassphrase(
          "correct horse battery staple",
          salt
        );

        expect(key.algorithm.name).toBe("AES-GCM");
        expect((key.algorithm as AesKeyAlgorithm).length).toBe(256);
        expect(key.extractable).toBe(false);
        expect(key.usages).toEqual(
          expect.arrayContaining(["encrypt", "decrypt"])
        );
      });

      it("should reject an empty passphrase", async () => {
        const salt = new Uint8Array(16);
        await expect(deriveKeyFromPassphrase("", salt)).rejects.toThrow();
      });
    });

    describe("encryptWithPassphrase / decryptWithPassphrase round trip", () => {
      it("should encrypt and decrypt a backup payload with the correct passphrase", async () => {
        const secret = "ab12cd34ef56-vault-backup-key";
        const passphrase = "a reasonably strong passphrase";

        const encrypted = await encryptWithPassphrase(secret, passphrase);
        const decrypted = await decryptWithPassphrase(encrypted, passphrase);

        expect(decrypted).toBe(secret);
      });

      it("should never store the raw passphrase or a derived key in the payload", async () => {
        const passphrase = "super-secret-passphrase";
        const encrypted = await encryptWithPassphrase(
          "some backup data",
          passphrase
        );
        const parsed = JSON.parse(encrypted);

        expect(encrypted).not.toContain(passphrase);
        expect(parsed).toHaveProperty("salt");
        expect(parsed).toHaveProperty("iv");
        expect(parsed).toHaveProperty("ciphertext");
        expect(parsed).toHaveProperty("iterations", PBKDF2_ITERATIONS);
      });

      it("should reject decryption with the wrong passphrase", async () => {
        const encrypted = await encryptWithPassphrase(
          "vault backup contents",
          "right-passphrase"
        );
        await expect(
          decryptWithPassphrase(encrypted, "wrong-passphrase")
        ).rejects.toThrow();
      });

      it("should produce different ciphertext and salt for the same plaintext and passphrase (unique salt per encryption)", async () => {
        const plaintext = "identical-secret";
        const passphrase = "identical-passphrase";

        const first = JSON.parse(
          await encryptWithPassphrase(plaintext, passphrase)
        );
        const second = JSON.parse(
          await encryptWithPassphrase(plaintext, passphrase)
        );

        expect(first.salt).not.toBe(second.salt);
        expect(first.ciphertext).not.toBe(second.ciphertext);
      });

      it("should reject a corrupted or malformed payload", async () => {
        await expect(
          decryptWithPassphrase("not-json", "any-passphrase")
        ).rejects.toThrow();
        await expect(
          decryptWithPassphrase(
            JSON.stringify({ version: "unknown-version" }),
            "any-passphrase"
          )
        ).rejects.toThrow();
      });
    });
  }
);
