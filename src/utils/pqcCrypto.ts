/**
 * Post-Quantum Hybrid Encryption Layer (ML-KEM-768 + ECDH P-256/X25519).
 *
 * Implements the dual-encapsulation scheme requested in issue #96:
 *
 *   1. Classical KEM: ephemeral ECDH (Web Crypto, P-256 - same machinery as
 *      the existing ECIES layer, X25519-compatible key encapsulation shape).
 *   2. Post-quantum KEM: ML-KEM-768 (FIPS-203, NIST standardized) via the
 *      zero-dependency `mlkem` TypeScript implementation.
 *   3. Combined AES-256-GCM key: K = HKDF-SHA256(K_ecdh || K_mlkem, salt, info)
 *
 * An attacker must break BOTH KEMs to recover the plaintext, so harvested
 * ciphertexts stay safe against "harvest now, decrypt later" attacks even
 * if one of the two algorithms falls.
 *
 * The existing ECIES payloads (`ecies-p256-aes256gcm-v1`) and legacy
 * TweetNaCl payloads remain fully backwards compatible: use
 * {decryptPayloadAuto} to transparently handle every version.
 */

import { createMlKem768 } from "mlkem";
import {
  base64ToUint8Array,
  uint8ArrayToBase64,
  stringToUint8Array,
  uint8ArrayToString,
  generateECIESKeyPair,
  exportECIESPublicKey,
  importECIESPublicKey,
  importECIESPrivateKey,
  encryptWithPublicKey,
  decryptWithPrivateKey,
  type EncryptedPayload,
} from "./crypto";

/** Version marker for hybrid ML-KEM-768 + ECDH payloads. */
export const PQC_HYBRID_VERSION = "ecies-p256-mlkem768-hybrid-v1";

const HKDF_SALT = "SpooVault-PQC-Hybrid-v1";
const HKDF_INFO = "mlkem768+ecdh-p256/aes-256-gcm";

export interface MlKem768KeyPair {
  /** Raw encapsulation key (1184 bytes for ML-KEM-768). */
  publicKey: Uint8Array;
  /** Raw decapsulation secret key (2400 bytes for ML-KEM-768). */
  secretKey: Uint8Array;
}

export interface HybridKeyPairBase64 {
  /** ECDH P-256 public key in SPKI base64 (existing ECIES format). */
  eciesPublicKey: string;
  /** ECDH P-256 private key in PKCS#8 base64 (existing ECIES format). */
  eciesPrivateKey: string;
  /** ML-KEM-768 encapsulation key, raw bytes in base64. */
  pqcPublicKey: string;
  /** ML-KEM-768 decapsulation key, raw bytes in base64. */
  pqcSecretKey: string;
}

export interface HybridRecipientKeys {
  eciesPublicKey: string;
  pqcPublicKey: string;
}

export interface HybridRecipientSecrets {
  eciesPrivateKey: string;
  pqcSecretKey: string;
}

let mlKemInstance: Promise<Awaited<ReturnType<typeof createMlKem768>>> | null = null;

async function getMlKem768() {
  if (!mlKemInstance) {
    mlKemInstance = createMlKem768();
  }
  return mlKemInstance;
}

const getWebCrypto = (): Crypto => {
  const cryptoObj =
    (typeof window !== "undefined" ? window.crypto : undefined) ??
    (typeof globalThis !== "undefined" ? globalThis.crypto : undefined);
  if (!cryptoObj?.subtle) {
    throw new Error("Web Crypto API (crypto.subtle) is not available in this environment");
  }
  return cryptoObj;
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Generate a full hybrid recipient key pair (classical ECDH + ML-KEM-768),
 * Base64-encoded for storage/transport.
 */
export async function generateHybridKeyPairBase64(): Promise<HybridKeyPairBase64> {
  const subtle = getWebCrypto().subtle;

  const ecies = await generateECIESKeyPair();
  const [eciesPublicKey, eciesPrivateKey] = await Promise.all([
    exportECIESPublicKey(ecies.publicKey),
    subtle.exportKey("pkcs8", ecies.privateKey).then((buf) => uint8ArrayToBase64(new Uint8Array(buf))),
  ]);

  const mlkem = await getMlKem768();
  const [pqcPublicRaw, pqcSecretRaw] = mlkem.generateKeyPair();

  return {
    eciesPublicKey,
    eciesPrivateKey,
    pqcPublicKey: uint8ArrayToBase64(pqcPublicRaw),
    pqcSecretKey: uint8ArrayToBase64(pqcSecretRaw),
  };
}

/**
 * Derive the combined AES-256-GCM key from both KEM shared secrets:
 * K = HKDF-SHA256(K_ecdh || K_mlkem, salt, info).
 */
async function deriveHybridAesKey(
  ecdhSharedBits: ArrayBuffer,
  mlKemSharedSecret: Uint8Array,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  const subtle = getWebCrypto().subtle;

  const ikm = concatBytes(new Uint8Array(ecdhSharedBits), mlKemSharedSecret);
  const salt = stringToUint8Array(HKDF_SALT);
  const info = stringToUint8Array(HKDF_INFO);

  const hkdfKey = await subtle.importKey("raw", toArrayBuffer(ikm), "HKDF", false, ["deriveBits"]);
  const derived = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(info),
    },
    hkdfKey,
    256
  );

  return subtle.importKey("raw", derived, { name: "AES-GCM", length: 256 }, false, usages);
}

/**
 * Encrypt a plaintext message with the hybrid post-quantum scheme for a
 * recipient holding both an ECDH and an ML-KEM-768 key pair.
 * Returns a JSON stringified {EncryptedPayload}.
 */
export async function encryptHybrid(
  message: string,
  recipient: HybridRecipientKeys
): Promise<string> {
  const subtle = getWebCrypto().subtle;
  const mlkem = await getMlKem768();

  // 1. Classical KEM: ephemeral ECDH -> shared secret.
  const ephemeral = await generateECIESKeyPair();
  const recipientEciesPub = await importECIESPublicKey(recipient.eciesPublicKey);
  const ecdhBits = await subtle.deriveBits(
    { name: "ECDH", public: recipientEciesPub },
    ephemeral.privateKey,
    256
  );

  // 2. Post-quantum KEM: ML-KEM-768 encapsulation.
  const [pqcCiphertext, pqcSharedSecret] = mlkem.encap(base64ToUint8Array(recipient.pqcPublicKey));

  // 3. Hybrid AES-256-GCM key from both secrets.
  const aesKey = await deriveHybridAesKey(ecdhBits, pqcSharedSecret, ["encrypt"]);

  const iv = new Uint8Array(12);
  getWebCrypto().getRandomValues(iv);

  const ciphertextBuffer = await subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    aesKey,
    toArrayBuffer(stringToUint8Array(message))
  );

  const payload: EncryptedPayload = {
    version: PQC_HYBRID_VERSION,
    iv: uint8ArrayToBase64(iv),
    ephemPublicKey: await exportECIESPublicKey(ephemeral.publicKey),
    ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertextBuffer)),
    pqcPublicKey: recipient.pqcPublicKey,
    pqcCiphertext: uint8ArrayToBase64(pqcCiphertext),
  };

  return JSON.stringify(payload);
}

/**
 * Decrypt a hybrid payload using both recipient secret keys.
 * Both KEM contributions are required - a failure in either one (wrong key,
 * tampered ciphertext) prevents plaintext recovery.
 */
export async function decryptHybrid(
  encryptedPayloadJson: string | EncryptedPayload,
  recipient: HybridRecipientSecrets
): Promise<string> {
  const payload: EncryptedPayload =
    typeof encryptedPayloadJson === "string" ? JSON.parse(encryptedPayloadJson) : encryptedPayloadJson;

  if (payload.version !== PQC_HYBRID_VERSION) {
    throw new Error(`Not a hybrid PQC payload (version: ${payload.version})`);
  }
  if (!payload.pqcCiphertext) {
    throw new Error("Missing pqcCiphertext in hybrid payload");
  }

  const subtle = getWebCrypto().subtle;
  const mlkem = await getMlKem768();

  const receiverPrivateKey = await importECIESPrivateKey(recipient.eciesPrivateKey);
  const ephemPublicKey = await importECIESPublicKey(payload.ephemPublicKey);

  const ecdhBits = await subtle.deriveBits(
    { name: "ECDH", public: ephemPublicKey },
    receiverPrivateKey,
    256
  );

  const pqcSharedSecret = mlkem.decap(
    base64ToUint8Array(payload.pqcCiphertext),
    base64ToUint8Array(recipient.pqcSecretKey)
  );

  const aesKey = await deriveHybridAesKey(ecdhBits, pqcSharedSecret, ["decrypt"]);

  const ivStr = payload.iv || payload.nonce;
  if (!ivStr) {
    throw new Error("Missing IV in hybrid encrypted payload");
  }

  try {
    const decrypted = await subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64ToUint8Array(ivStr)) },
      aesKey,
      toArrayBuffer(base64ToUint8Array(payload.ciphertext))
    );
    return uint8ArrayToString(new Uint8Array(decrypted));
  } catch {
    throw new Error("Failed to decrypt hybrid payload with provided keys");
  }
}

/**
 * Version-aware decryption entry point: handles hybrid PQC payloads plus all
 * legacy formats (ECIES P-256 and x25519-xsalsa20-poly1305), so existing
 * stored documents keep decrypting unchanged.
 *
 * For hybrid payloads pass both secret keys; for legacy payloads only
 * `eciesPrivateKey` is required.
 */
export async function decryptPayloadAuto(
  encryptedPayloadJson: string | EncryptedPayload,
  keys: Partial<HybridRecipientSecrets>
): Promise<string> {
  const payload: EncryptedPayload =
    typeof encryptedPayloadJson === "string" ? JSON.parse(encryptedPayloadJson) : encryptedPayloadJson;

  if (payload.version === PQC_HYBRID_VERSION) {
    if (!keys.eciesPrivateKey || !keys.pqcSecretKey) {
      throw new Error("Hybrid payload requires both eciesPrivateKey and pqcSecretKey");
    }
    return decryptHybrid(payload, {
      eciesPrivateKey: keys.eciesPrivateKey,
      pqcSecretKey: keys.pqcSecretKey,
    });
  }

  if (!keys.eciesPrivateKey) {
    throw new Error("eciesPrivateKey is required for legacy payloads");
  }
  return decryptWithPrivateKey(payload, keys.eciesPrivateKey);
}

/** Re-exported for callers that want a single crypto import surface. */
export { encryptWithPublicKey, decryptWithPrivateKey };

/**
 * Benchmark helper documenting CPU cost and size overhead of the hybrid
 * layer (acceptance criterion for #96). Returns machine-readable timings.
 */
export interface HybridBenchmark {
  keygenMs: number;
  encryptMs: number;
  decryptMs: number;
  mlKemPublicKeyBytes: number;
  mlKemSecretKeyBytes: number;
  mlKemCiphertextBytes: number;
  totalPayloadBytes: number;
}

export async function benchmarkHybrid(sampleMessage = "SpooVault PQC benchmark"): Promise<HybridBenchmark> {
  let t0 = performance.now();
  const keyPair = await generateHybridKeyPairBase64();
  const keygenMs = performance.now() - t0;

  t0 = performance.now();
  const payloadJson = await encryptHybrid(sampleMessage, {
    eciesPublicKey: keyPair.eciesPublicKey,
    pqcPublicKey: keyPair.pqcPublicKey,
  });
  const encryptMs = performance.now() - t0;

  t0 = performance.now();
  const plaintext = await decryptHybrid(payloadJson, {
    eciesPrivateKey: keyPair.eciesPrivateKey,
    pqcSecretKey: keyPair.pqcSecretKey,
  });
  const decryptMs = performance.now() - t0;

  if (plaintext !== sampleMessage) {
    throw new Error("Benchmark roundtrip mismatch");
  }

  return {
    keygenMs,
    encryptMs,
    decryptMs,
    mlKemPublicKeyBytes: base64ToUint8Array(keyPair.pqcPublicKey).byteLength,
    mlKemSecretKeyBytes: base64ToUint8Array(keyPair.pqcSecretKey).byteLength,
    mlKemCiphertextBytes: base64ToUint8Array(JSON.parse(payloadJson).pqcCiphertext).byteLength,
    totalPayloadBytes: payloadJson.length,
  };
}
