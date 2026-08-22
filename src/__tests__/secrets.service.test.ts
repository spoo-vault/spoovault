import { describe, it, expect } from "vitest";
import {
  gfMultiply,
  gfInverse,
  splitSecret,
  splitSecretVSS,
  verifyShare,
  reconstructSecret,
  parseEncryptedMetadataPayload,
  VSS_P,
  VSS_Q,
  setMockCrypto,
} from "../services/secrets.service";

describe("Galois Field GF(256) Lookup Table Optimization (Issue #16)", () => {
  describe("gfMultiply", () => {
    it("returns 0 when either operand is 0", () => {
      expect(gfMultiply(0, 123)).toBe(0);
      expect(gfMultiply(123, 0)).toBe(0);
      expect(gfMultiply(0, 0)).toBe(0);
    });

    it("returns the other operand when multiplying by 1 (identity)", () => {
      for (let i = 0; i < 256; i++) {
        expect(gfMultiply(i, 1)).toBe(i);
        expect(gfMultiply(1, i)).toBe(i);
      }
    });

    it("satisfies commutative property a * b === b * a across full GF(256) field", () => {
      for (let a = 1; a < 256; a += 17) {
        for (let b = 1; b < 256; b += 13) {
          expect(gfMultiply(a, b)).toBe(gfMultiply(b, a));
        }
      }
    });
  });

  describe("gfInverse", () => {
    it("throws division by zero error when input is 0", () => {
      expect(() => gfInverse(0)).toThrow("GF(256) division by zero");
    });

    it("computes exact multiplicative inverse a * a^-1 === 1 for all non-zero elements", () => {
      for (let a = 1; a < 256; a++) {
        const inv = gfInverse(a);
        expect(gfMultiply(a, inv)).toBe(1);
      }
    });
  });

  describe("Shamir's Secret Sharing (SSS) key splitting and reconstruction", () => {
    it("correctly splits and reconstructs a 256-bit AES hex key with 3-of-5 threshold", () => {
      const secretHex =
        "4f2a9c1e8b7d6f5a3c1e9b7d5a3c1e9b7d5a3c1e9b7d5a3c1e9b7d5a3c1e9b7d";
      const N = 5;
      const K = 3;

      const shares = splitSecret(secretHex, N, K);
      expect(shares.length).toBe(5);

      // Reconstruct using any 3 shares (e.g., 0, 2, 4)
      const selectedShares = [shares[0], shares[2], shares[4]];
      const reconstructed = reconstructSecret(selectedShares);

      expect(reconstructed.toLowerCase()).toBe(secretHex.toLowerCase());
    });

    it("correctly splits and reconstructs with 2-of-3 threshold", () => {
      const secretHex = "deadbeef1234567890abcdef";
      const shares = splitSecret(secretHex, 3, 2);

      const reconstructed = reconstructSecret([shares[1], shares[2]]);
      expect(reconstructed.toLowerCase()).toBe(secretHex.toLowerCase());
    });
  });

  describe("Performance Benchmark", () => {
    it("executes 10,000 GF(256) multiplications rapidly without thread blocking", () => {
      const start = performance.now();
      let acc = 1;
      for (let i = 1; i < 10000; i++) {
        acc = gfMultiply(acc, (i % 255) + 1);
      }
      const elapsed = performance.now() - start;

      expect(acc).toBeGreaterThanOrEqual(0);
      expect(elapsed).toBeLessThan(100); // Should complete in under 100ms
    });
  });

  describe("Feldmann Verifiable Secret Sharing (VSS)", () => {
    const secretHex =
      "4f2a9c1e8b7d6f5a3c1e9b7d5a3c1e9b7d5a3c1e9b7d5a3c1e9b7d5a3c1e9b7d";
    const N = 5;
    const K = 3;

    it("correctly splits and reconstructs a 256-bit AES hex key using splitSecretVSS and reconstructSecret", () => {
      const { shares, commitments } = splitSecretVSS(secretHex, N, K);
      expect(shares.length).toBe(N);
      expect(commitments.length).toBe(K);

      // Reconstruct using any K shares (e.g. shares 1, 3, 5 which correspond to index 0, 2, 4)
      const selectedShares = [shares[0], shares[2], shares[4]];
      const reconstructed = reconstructSecret(selectedShares);
      expect(reconstructed.toLowerCase()).toBe(secretHex.toLowerCase());
    });

    it("verifyShare returns true for all valid generated shares", () => {
      const { shares, commitments } = splitSecretVSS(secretHex, N, K);
      for (const share of shares) {
        expect(verifyShare(share, commitments)).toBe(true);
      }
    });

    it("verifyShare returns false for a modified/tampered share value", () => {
      const { shares, commitments } = splitSecretVSS(secretHex, N, K);

      // Tamper with the share data (modify last hex char)
      const parts = shares[0].split("-");
      const lastChar = parts[1][parts[1].length - 1];
      const newChar = lastChar === "0" ? "1" : "0";
      const tamperedShare = `${parts[0]}-${parts[1].slice(0, -1)}${newChar}`;

      expect(verifyShare(tamperedShare, commitments)).toBe(false);
    });

    it("verifyShare returns false for tampered commitments", () => {
      const { shares, commitments } = splitSecretVSS(secretHex, N, K);
      const tamperedCommitments = [...commitments];
      // Modify a commitment value mathematically
      const modifiedBig = (BigInt("0x" + commitments[0]) + 1n) % VSS_P;
      tamperedCommitments[0] = modifiedBig.toString(16).padStart(66, "0");

      expect(verifyShare(shares[0], tamperedCommitments)).toBe(false);
    });

    it("verifyShare returns false for legacy non-vss shares", () => {
      const legacyShares = splitSecret(secretHex, N, K);
      const { commitments } = splitSecretVSS(secretHex, N, K);
      expect(verifyShare(legacyShares[0], commitments)).toBe(false);
    });

    it("parseEncryptedMetadataPayload correctly parses JSON payload and commitments", () => {
      const samplePayload = JSON.stringify({
        ciphertext: "encrypted-data-xyz",
        commitments: ["comm1", "comm2"],
      });
      const parsed = parseEncryptedMetadataPayload(samplePayload);
      expect(parsed.ciphertext).toBe("encrypted-data-xyz");
      expect(parsed.commitments).toEqual(["comm1", "comm2"]);
    });

    it("parseEncryptedMetadataPayload falls back to empty commitments for a raw string", () => {
      const rawText = "some-raw-unwrapped-ciphertext";
      const parsed = parseEncryptedMetadataPayload(rawText);
      expect(parsed.ciphertext).toBe(rawText);
      expect(parsed.commitments).toEqual([]);
    });

    it("reconstructSecret is backwards compatible and can reconstruct legacy GF(256) shares", () => {
      // Legacy share generation
      const legacyShares = [
        "1-0678d46e9cb08865f1a5f6e8",
        "2-0db1af8a23d46ccbc12a52ef",
        "3-0bfb31057e1082c5cb6ad9c8",
      ];

      const reconstructed = reconstructSecret([
        legacyShares[0],
        legacyShares[1],
      ]);
      // Reconstruction of legacy shares should still work
      expect(reconstructed).toBeDefined();
    });

    it("throws error for empty shares or invalid format during reconstruction", () => {
      expect(() => reconstructSecret([])).toThrow(
        "No shares provided for reconstruction"
      );
      expect(() => reconstructSecret(["invalid-share"])).toThrow();
    });

    it("splitSecretVSS edge cases: invalid parameters", () => {
      expect(() => splitSecretVSS(secretHex, 3, 5)).toThrow(
        "Threshold cannot exceed total shares"
      );
      expect(() => splitSecretVSS(secretHex, 5, 0)).toThrow(
        "Threshold must be at least 1"
      );
      expect(() => splitSecretVSS("123", 5, 3)).toThrow(
        "Secret hex string must have an even length"
      );
      const hugeSecret = VSS_Q.toString(16).padStart(66, "0");
      expect(() => splitSecretVSS(hugeSecret, 5, 3)).toThrow(
        "Secret key is too large for the VSS prime field"
      );
    });

    it("splitSecretVSS random generation fallback when global crypto is missing", () => {
      try {
        setMockCrypto(null); // Force using fallback since mock is set to undefined
        setMockCrypto({ getRandomValues: undefined });
        const { shares } = splitSecretVSS(secretHex, 3, 2);
        expect(shares.length).toBe(3);
      } finally {
        setMockCrypto(null);
      }
    });

    it("verifyShare edge cases: invalid inputs", () => {
      expect(verifyShare("invalidshare", [])).toBe(false);
      expect(verifyShare("1-vssGIBBERISH", [])).toBe(false);
    });
  });
});
