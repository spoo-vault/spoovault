import { describe, it, expect } from "vitest";
import {
  evaluateVdf,
  proveWesolowski,
  verifyWesolowski,
  provePietrzak,
  verifyPietrzak,
  deriveKeyFromVdfOutput,
  hashVdfOutput,
  encryptTimelock,
  decryptTimelock,
  getFixedTestModulus,
  generateTestRsaModulus,
  modPow,
  fiatShamirChallenge,
  TIMELOCK_VERSION,
  toBytesBEPadded,
  byteLength,
} from "../utils/vdf";

describe("VDF Timelock Encryption Engine", () => {
  const N = getFixedTestModulus();
  const x = 5n;

  describe("Sequential squaring evaluation", () => {
    it("computes y = x^(2^T) mod N via T squarings", () => {
      const T = 8;
      const y = evaluateVdf(x, T, N);
      // Cross-check with direct modular exponentiation
      const expected = modPow(x, 1n << BigInt(T), N);
      expect(y).toBe(expected);
    });

    it("requires exactly T sequential steps (intermediate differs)", () => {
      const y7 = evaluateVdf(x, 7, N);
      const y8 = evaluateVdf(x, 8, N);
      expect(y7).not.toBe(y8);
      expect((y7 * y7) % N).toBe(y8);
    });
  });

  describe("Wesolowski proofs", () => {
    it("generates and verifies a valid Wesolowski proof", () => {
      const T = 32;
      const proof = proveWesolowski(x, T, N);
      expect(verifyWesolowski(x, T, N, proof)).toBe(true);
      expect(proof.y).toBe(evaluateVdf(x, T, N));
      expect(proof.r).toBe(modPow(2n, BigInt(T), proof.l));
    });

    it("rejects a tampered proof output", () => {
      const T = 16;
      const proof = proveWesolowski(x, T, N);
      const bad = { ...proof, y: (proof.y + 1n) % N };
      expect(verifyWesolowski(x, T, N, bad)).toBe(false);
    });

    it("rejects a tampered pi", () => {
      const T = 16;
      const proof = proveWesolowski(x, T, N);
      const bad = { ...proof, pi: (proof.pi + 1n) % N };
      expect(verifyWesolowski(x, T, N, bad)).toBe(false);
    });

    it("Fiat–Shamir challenge is deterministic and odd", () => {
      const y = evaluateVdf(x, 16, N);
      const l1 = fiatShamirChallenge(x, y, 16, N);
      const l2 = fiatShamirChallenge(x, y, 16, N);
      expect(l1).toBe(l2);
      expect(l1 % 2n).toBe(1n);
      expect(l1).toBeGreaterThanOrEqual(3n);
    });
  });

  describe("Pietrzak proofs (O(log T))", () => {
    it("generates and verifies a Pietrzak proof for power-of-two T", () => {
      const T = 16;
      const proof = provePietrzak(x, T, N);
      expect(proof.mus.length).toBe(Math.log2(T));
      expect(verifyPietrzak(x, T, N, proof)).toBe(true);
    });

    it("rejects wrong μ chain", () => {
      const T = 8;
      const proof = provePietrzak(x, T, N);
      const bad = {
        ...proof,
        mus: proof.mus.map((m, i) => (i === 0 ? (m + 1n) % N : m)),
      };
      expect(verifyPietrzak(x, T, N, bad)).toBe(false);
    });
  });

  describe("Key derivation + AES-256-GCM timelock", () => {
    it("derives a 256-bit key from VDF output", async () => {
      const y = evaluateVdf(x, 8, N);
      const keyBytes = await hashVdfOutput(y);
      expect(keyBytes.length).toBe(32);
      const key = await deriveKeyFromVdfOutput(y);
      expect(key.algorithm.name).toBe("AES-GCM");
    });

    it("encrypts and decrypts after VDF evaluation", async () => {
      const plaintext = "Dead-man switch: release inheritance docs after delay";
      const sealed = await encryptTimelock(plaintext, { N, T: 24, x });
      expect(sealed.version).toBe(TIMELOCK_VERSION);
      const opened = await decryptTimelock(sealed);
      expect(opened).toBe(plaintext);
    });

    it("cannot decrypt before the VDF output is known (wrong y)", async () => {
      const sealed = await encryptTimelock("secret-vault-doc", { N, T: 16, x });
      const forged = {
        ...sealed,
        y: ((BigInt("0x" + sealed.y) + 1n) % N).toString(16),
      };
      await expect(decryptTimelock(forged)).rejects.toThrow(
        /VDF output mismatch/
      );
    });

    it("cannot decrypt with an invalid Wesolowski proof", async () => {
      const sealed = await encryptTimelock("secret-vault-doc", { N, T: 16, x });
      const forged = {
        ...sealed,
        pi: ((BigInt("0x" + sealed.pi) + 1n) % N).toString(16),
      };
      await expect(decryptTimelock(forged)).rejects.toThrow(
        /Invalid Wesolowski/
      );
    });
  });

  describe("RSA modulus helpers", () => {
    it("builds a random test modulus of the requested size", () => {
      const { N: n, p, q } = generateTestRsaModulus(256);
      expect(p * q).toBe(n);
      expect(byteLength(n)).toBeLessThanOrEqual(32);
    });

    it("pads bigints to modulus width for on-chain encoding", () => {
      const width = byteLength(N);
      const padded = toBytesBEPadded(5n, width);
      expect(padded.length).toBe(width);
      expect(padded[width - 1]).toBe(5);
    });
  });

  describe("Benchmarks", () => {
    it("benchmarks Wesolowski prove + verify for increasing T", () => {
      const delays = [64, 256, 1024];
      const rows: { T: number; proveMs: number; verifyMs: number }[] = [];

      for (const T of delays) {
        const t0 = performance.now();
        const proof = proveWesolowski(x, T, N);
        const proveMs = performance.now() - t0;

        const t1 = performance.now();
        const ok = verifyWesolowski(x, T, N, proof);
        const verifyMs = performance.now() - t1;

        expect(ok).toBe(true);
        rows.push({
          T,
          proveMs: Number(proveMs.toFixed(2)),
          verifyMs: Number(verifyMs.toFixed(2)),
        });
      }

      // eslint-disable-next-line no-console
      console.log("[VDF benchmark]", rows);
      expect(rows[rows.length - 1].proveMs).toBeGreaterThan(0);
      // Verification is succinct (independent of T cost class vs prove)
      expect(rows[rows.length - 1].verifyMs).toBeLessThan(
        rows[rows.length - 1].proveMs + 50
      );
    });

    it("benchmarks Pietrzak prove + O(log T) verify", () => {
      const T = 256;
      const t0 = performance.now();
      const proof = provePietrzak(x, T, N);
      const proveMs = performance.now() - t0;
      const t1 = performance.now();
      const ok = verifyPietrzak(x, T, N, proof);
      const verifyMs = performance.now() - t1;
      expect(ok).toBe(true);
      // eslint-disable-next-line no-console
      console.log("[Pietrzak benchmark]", {
        T,
        rounds: proof.mus.length,
        proveMs: Number(proveMs.toFixed(2)),
        verifyMs: Number(verifyMs.toFixed(2)),
      });
      expect(proof.mus.length).toBe(8);
      expect(ok).toBe(true);
      expect(verifyMs).toBeGreaterThan(0);
      expect(proveMs).toBeGreaterThan(0);
    });
  });
});
