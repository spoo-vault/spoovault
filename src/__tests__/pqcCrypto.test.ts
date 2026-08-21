import { describe, it, expect } from "vitest";
import {
  PQC_HYBRID_VERSION,
  generateHybridKeyPairBase64,
  encryptHybrid,
  decryptHybrid,
  decryptPayloadAuto,
  benchmarkHybrid,
} from "../utils/pqcCrypto";
import {
  encryptWithPublicKey,
  decryptWithPrivateKey,
  generateECIESKeyPairBase64,
  ECIES_VERSION,
  LEGACY_X25519_VERSION,
  uint8ArrayToBase64,
  stringToUint8Array,
} from "../utils/crypto";
import nacl from "tweetnacl";

describe("Post-Quantum Hybrid Encryption (ML-KEM-768 + ECDH)", () => {
  const MESSAGE = "Top secret testament - quantum resistant 🔐";

  it("should roundtrip a hybrid encryption/decryption", async () => {
    const keys = await generateHybridKeyPairBase64();

    const payloadJson = await encryptHybrid(MESSAGE, {
      eciesPublicKey: keys.eciesPublicKey,
      pqcPublicKey: keys.pqcPublicKey,
    });
    const payload = JSON.parse(payloadJson);

    expect(payload.version).toBe(PQC_HYBRID_VERSION);
    // Schema extension required by #96
    expect(payload.pqcCiphertext).toBeTruthy();
    expect(payload.pqcPublicKey).toBeTruthy();
    expect(payload.ephemPublicKey).toBeTruthy();

    const plaintext = await decryptHybrid(payloadJson, {
      eciesPrivateKey: keys.eciesPrivateKey,
      pqcSecretKey: keys.pqcSecretKey,
    });
    expect(plaintext).toBe(MESSAGE);
  });

  it("should produce FIPS-203 sized ML-KEM-768 material", async () => {
    const keys = await generateHybridKeyPairBase64();
    // ML-KEM-768: ek 1184 bytes, dk 2400 bytes, ct 1088 bytes
    expect(keys.pqcPublicKey.length).toBe(1580); // base64(1184)
    expect(keys.pqcSecretKey.length).toBe(3200); // base64(2400)

    const payloadJson = await encryptHybrid("size probe", {
      eciesPublicKey: keys.eciesPublicKey,
      pqcPublicKey: keys.pqcPublicKey,
    });
    const payload = JSON.parse(payloadJson);
    expect(payload.pqcCiphertext.length).toBe(1452); // base64(1088) padded
  });

  it("must not decrypt when the ML-KEM contribution is missing or wrong", async () => {
    const alice = await generateHybridKeyPairBase64();
    const mallory = await generateHybridKeyPairBase64();

    const payloadJson = await encryptHybrid(MESSAGE, {
      eciesPublicKey: alice.eciesPublicKey,
      pqcPublicKey: alice.pqcPublicKey,
    });

    // Correct ECDH key but wrong PQS secret -> must fail.
    await expect(
      decryptHybrid(payloadJson, {
        eciesPrivateKey: alice.eciesPrivateKey,
        pqcSecretKey: mallory.pqcSecretKey,
      })
    ).rejects.toThrow();

    // Correct PQS secret but wrong ECDH key -> must fail.
    await expect(
      decryptHybrid(payloadJson, {
        eciesPrivateKey: mallory.eciesPrivateKey,
        pqcSecretKey: alice.pqcSecretKey,
      })
    ).rejects.toThrow();
  });

  it("should reject tampered ciphertext and tampered KEM material", async () => {
    const keys = await generateHybridKeyPairBase64();
    const payloadJson = await encryptHybrid(MESSAGE, {
      eciesPublicKey: keys.eciesPublicKey,
      pqcPublicKey: keys.pqcPublicKey,
    });
    const secrets = { eciesPrivateKey: keys.eciesPrivateKey, pqcSecretKey: keys.pqcSecretKey };

    const flipChar = (str: string) => (str[0] === "A" ? "B" : "A") + str.slice(1);

    const tamperedCiphertext = JSON.parse(payloadJson);
    tamperedCiphertext.ciphertext = flipChar(tamperedCiphertext.ciphertext);
    await expect(decryptHybrid(tamperedCiphertext, secrets)).rejects.toThrow();

    const tamperedKem = JSON.parse(payloadJson);
    tamperedKem.pqcCiphertext = flipChar(tamperedKem.pqcCiphertext);
    await expect(decryptHybrid(tamperedKem, secrets)).rejects.toThrow();
  });

  it("should stay fully backwards compatible with existing ECIES payloads", async () => {
    const eciesKeys = await generateECIESKeyPairBase64();

    // Old-style payload produced by the untouched legacy function...
    const legacyPayload = await encryptWithPublicKey(MESSAGE, eciesKeys.publicKey);
    expect(JSON.parse(legacyPayload).version).toBe(ECIES_VERSION);

    // ...still decrypts through the legacy path...
    await expect(decryptWithPrivateKey(legacyPayload, eciesKeys.privateKey)).resolves.toBe(MESSAGE);

    // ...and through the new auto dispatcher.
    await expect(
      decryptPayloadAuto(legacyPayload, { eciesPrivateKey: eciesKeys.privateKey })
    ).resolves.toBe(MESSAGE);
  });

  it("should keep legacy TweetNaCl payloads decryptable via the auto dispatcher", async () => {
    const sender = nacl.box.keyPair();
    const receiver = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const encrypted = nacl.box(stringToUint8Array(MESSAGE), nonce, sender.publicKey, receiver.secretKey);

    const legacyPayload = JSON.stringify({
      version: LEGACY_X25519_VERSION,
      nonce: uint8ArrayToBase64(nonce),
      ephemPublicKey: uint8ArrayToBase64(sender.publicKey),
      ciphertext: uint8ArrayToBase64(encrypted),
    });

    await expect(
      decryptPayloadAuto(legacyPayload, {
        eciesPrivateKey: uint8ArrayToBase64(receiver.secretKey),
      })
    ).resolves.toBe(MESSAGE);
  });

  it("should route hybrid payloads through the auto dispatcher", async () => {
    const keys = await generateHybridKeyPairBase64();
    const payloadJson = await encryptHybrid(MESSAGE, {
      eciesPublicKey: keys.eciesPublicKey,
      pqcPublicKey: keys.pqcPublicKey,
    });

    await expect(
      decryptPayloadAuto(payloadJson, {
        eciesPrivateKey: keys.eciesPrivateKey,
        pqcSecretKey: keys.pqcSecretKey,
      })
    ).resolves.toBe(MESSAGE);

    // Hybrid payload without both secrets is rejected loudly.
    await expect(
      decryptPayloadAuto(payloadJson, { eciesPrivateKey: keys.eciesPrivateKey })
    ).rejects.toThrow(/both/i);
  });

  it("should support many independent key pairs without cross-decryption", async () => {
    const a = await generateHybridKeyPairBase64();
    const b = await generateHybridKeyPairBase64();

    const forB = await encryptHybrid("for b only", {
      eciesPublicKey: b.eciesPublicKey,
      pqcPublicKey: b.pqcPublicKey,
    });

    await expect(
      decryptHybrid(forB, { eciesPrivateKey: a.eciesPrivateKey, pqcSecretKey: a.pqcSecretKey })
    ).rejects.toThrow();
    await expect(
      decryptHybrid(forB, { eciesPrivateKey: b.eciesPrivateKey, pqcSecretKey: b.pqcSecretKey })
    ).resolves.toBe("for b only");
  });

  it(
    "benchmark: documents CPU performance and key size overhead",
    async () => {
      const bench = await benchmarkHybrid();

      // Document the overhead (also visible in CI logs).
      console.log(`
=== Hybrid PQC Benchmark (#96) ===
keygen:   ${bench.keygenMs.toFixed(2)} ms
encrypt:  ${bench.encryptMs.toFixed(2)} ms
decrypt:  ${bench.decryptMs.toFixed(2)} ms
ML-KEM-768 public key:  ${bench.mlKemPublicKeyBytes} B
ML-KEM-768 secret key:  ${bench.mlKemSecretKeyBytes} B
ML-KEM-768 ciphertext:  ${bench.mlKemCiphertextBytes} B
total JSON payload:     ${bench.totalPayloadBytes} B
`);

      // Loose sanity bounds so the test stays stable on slow CI runners.
      expect(bench.keygenMs).toBeLessThan(10_000);
      expect(bench.encryptMs).toBeLessThan(10_000);
      expect(bench.decryptMs).toBeLessThan(10_000);

      // Exact FIPS-203 size documentation.
      expect(bench.mlKemPublicKeyBytes).toBe(1184);
      expect(bench.mlKemSecretKeyBytes).toBe(2400);
      expect(bench.mlKemCiphertextBytes).toBe(1088);
    },
    30_000
  );
});
