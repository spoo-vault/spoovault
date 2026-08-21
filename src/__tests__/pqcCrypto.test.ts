import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import {
  encryptWithPublicKey,
  decryptWithPrivateKey,
  encryptHybridWithPublicKeys,
  decryptHybridWithPrivateKeys,
  encryptHybridX25519WithPublicKeys,
  generateECIESKeyPairBase64,
  generateHybridKeyPairBase64,
  ECIES_VERSION,
  HYBRID_PQC_VERSION,
  HYBRID_PQC_X25519_VERSION,
  uint8ArrayToBase64,
  ML_KEM_768_PUBLIC_KEY_BYTES,
  ML_KEM_768_SECRET_KEY_BYTES,
  ML_KEM_768_CIPHERTEXT_BYTES,
  ML_KEM_768_SHARED_SECRET_BYTES,
} from "../utils/crypto";
import {
  generateMlKem768KeyPair,
  generateMlKem768KeyPairBase64,
  mlKem768Encapsulate,
  mlKem768Decapsulate,
  bytesEqual,
} from "../utils/pqcCrypto";

describe("Post-Quantum Hybrid Dual Encapsulation (ML-KEM-768 + ECDH)", () => {
  describe("ML-KEM-768 primitives", () => {
    it("generates keys with FIPS 203 sizes", async () => {
      const { publicKey, secretKey } = await generateMlKem768KeyPair();
      expect(publicKey.length).toBe(ML_KEM_768_PUBLIC_KEY_BYTES);
      expect(secretKey.length).toBe(ML_KEM_768_SECRET_KEY_BYTES);
    });

    it("encapsulates and decapsulates to the same shared secret", async () => {
      const kp = await generateMlKem768KeyPairBase64();
      const { ciphertext, sharedSecret } = await mlKem768Encapsulate(kp.publicKey);
      expect(ciphertext.length).toBe(ML_KEM_768_CIPHERTEXT_BYTES);
      expect(sharedSecret.length).toBe(ML_KEM_768_SHARED_SECRET_BYTES);

      const recovered = await mlKem768Decapsulate(ciphertext, kp.secretKey);
      expect(bytesEqual(recovered, sharedSecret)).toBe(true);
    });
  });

  describe("Hybrid P-256 + ML-KEM-768", () => {
    it("encrypts and decrypts with dual encapsulation", async () => {
      const { classical, pqc } = await generateHybridKeyPairBase64();
      const message = "Harvest-now decrypt-later resistant vault share 🔐";

      const sealed = await encryptHybridWithPublicKeys(message, {
        classicalPublicKey: classical.publicKey,
        pqcPublicKey: pqc.publicKey,
      });
      const parsed = JSON.parse(sealed);

      expect(parsed.version).toBe(HYBRID_PQC_VERSION);
      expect(parsed.pqcCiphertext).toBeDefined();
      expect(parsed.pqcPublicKey).toBe(pqc.publicKey);
      expect(parsed.ephemPublicKey).toBeDefined();
      expect(parsed.iv).toBeDefined();

      const opened = await decryptHybridWithPrivateKeys(sealed, {
        classicalPrivateKey: classical.privateKey,
        pqcPrivateKey: pqc.secretKey,
      });
      expect(opened).toBe(message);
    });

    it("fails if only the classical key is available (PQC still required)", async () => {
      const alice = await generateHybridKeyPairBase64();
      const otherPqc = await generateMlKem768KeyPairBase64();
      const sealed = await encryptHybridWithPublicKeys("secret", {
        classicalPublicKey: alice.classical.publicKey,
        pqcPublicKey: alice.pqc.publicKey,
      });

      await expect(
        decryptHybridWithPrivateKeys(sealed, {
          classicalPrivateKey: alice.classical.privateKey,
          pqcPrivateKey: otherPqc.secretKey,
        })
      ).rejects.toThrow(/Failed to decrypt hybrid/);
    });

    it("fails if only the ML-KEM key is available (ECDH still required)", async () => {
      const alice = await generateHybridKeyPairBase64();
      const otherClassical = await generateECIESKeyPairBase64();
      const sealed = await encryptHybridWithPublicKeys("secret", {
        classicalPublicKey: alice.classical.publicKey,
        pqcPublicKey: alice.pqc.publicKey,
      });

      await expect(
        decryptHybridWithPrivateKeys(sealed, {
          classicalPrivateKey: otherClassical.privateKey,
          pqcPrivateKey: alice.pqc.secretKey,
        })
      ).rejects.toThrow(/Failed to decrypt hybrid/);
    });

    it("keeps classical ECIES fully backwards compatible", async () => {
      const receiver = await generateECIESKeyPairBase64();
      const message = "classic-only payload";
      const sealed = await encryptWithPublicKey(message, receiver.publicKey);
      const parsed = JSON.parse(sealed);
      expect(parsed.version).toBe(ECIES_VERSION);
      expect(parsed.pqcCiphertext).toBeUndefined();

      const opened = await decryptWithPrivateKey(sealed, receiver.privateKey);
      expect(opened).toBe(message);

      // Hybrid decrypt helper also accepts classical payloads via fallback
      const viaHybridHelper = await decryptHybridWithPrivateKeys(sealed, {
        classicalPrivateKey: receiver.privateKey,
        pqcPrivateKey: (await generateMlKem768KeyPairBase64()).secretKey,
      });
      expect(viaHybridHelper).toBe(message);
    });

    it("does not decrypt hybrid payloads via classical-only decryptWithPrivateKey", async () => {
      const { classical, pqc } = await generateHybridKeyPairBase64();
      const sealed = await encryptHybridWithPublicKeys("hybrid-only", {
        classicalPublicKey: classical.publicKey,
        pqcPublicKey: pqc.publicKey,
      });

      await expect(
        decryptWithPrivateKey(sealed, classical.privateKey)
      ).rejects.toThrow(/Unsupported encryption version/);
    });
  });

  describe("Hybrid X25519 + ML-KEM-768", () => {
    it("encrypts and decrypts with X25519 classical half", async () => {
      const classical = nacl.box.keyPair();
      const pqc = await generateMlKem768KeyPairBase64();
      const message = "x25519 hybrid document";

      const sealed = await encryptHybridX25519WithPublicKeys(message, {
        classicalPublicKey: uint8ArrayToBase64(classical.publicKey),
        pqcPublicKey: pqc.publicKey,
      });
      const parsed = JSON.parse(sealed);
      expect(parsed.version).toBe(HYBRID_PQC_X25519_VERSION);
      expect(parsed.pqcCiphertext).toBeDefined();

      const opened = await decryptHybridWithPrivateKeys(sealed, {
        classicalPrivateKey: uint8ArrayToBase64(classical.secretKey),
        pqcPrivateKey: pqc.secretKey,
      });
      expect(opened).toBe(message);
    });
  });

  describe("Benchmarks: CPU and key-size overhead", () => {
    it("documents key sizes and encrypt/decrypt timings", async () => {
      const rounds = 5;
      const message = "benchmark-payload-" + "x".repeat(256);

      const classicalTimes: number[] = [];
      const hybridTimes: number[] = [];

      let classicalPayloadBytes = 0;
      let hybridPayloadBytes = 0;

      for (let i = 0; i < rounds; i++) {
        const classical = await generateECIESKeyPairBase64();
        const t0 = performance.now();
        const cSealed = await encryptWithPublicKey(message, classical.publicKey);
        await decryptWithPrivateKey(cSealed, classical.privateKey);
        classicalTimes.push(performance.now() - t0);
        classicalPayloadBytes = cSealed.length;

        const hybrid = await generateHybridKeyPairBase64();
        const t1 = performance.now();
        const hSealed = await encryptHybridWithPublicKeys(message, {
          classicalPublicKey: hybrid.classical.publicKey,
          pqcPublicKey: hybrid.pqc.publicKey,
        });
        await decryptHybridWithPrivateKeys(hSealed, {
          classicalPrivateKey: hybrid.classical.privateKey,
          pqcPrivateKey: hybrid.pqc.secretKey,
        });
        hybridTimes.push(performance.now() - t1);
        hybridPayloadBytes = hSealed.length;
      }

      const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const report = {
        classicalAvgMs: Number(avg(classicalTimes).toFixed(2)),
        hybridAvgMs: Number(avg(hybridTimes).toFixed(2)),
        classicalPayloadChars: classicalPayloadBytes,
        hybridPayloadChars: hybridPayloadBytes,
        payloadOverheadRatio: Number(
          (hybridPayloadBytes / Math.max(classicalPayloadBytes, 1)).toFixed(2)
        ),
        mlKemPublicKeyBytes: ML_KEM_768_PUBLIC_KEY_BYTES,
        mlKemSecretKeyBytes: ML_KEM_768_SECRET_KEY_BYTES,
        mlKemCiphertextBytes: ML_KEM_768_CIPHERTEXT_BYTES,
        mlKemSharedSecretBytes: ML_KEM_768_SHARED_SECRET_BYTES,
      };

      // eslint-disable-next-line no-console
      console.log("[PQC hybrid benchmark]", report);

      expect(report.hybridPayloadChars).toBeGreaterThan(report.classicalPayloadChars);
      expect(report.hybridAvgMs).toBeGreaterThan(0);
      expect(report.classicalAvgMs).toBeGreaterThan(0);
    });
  });
});
