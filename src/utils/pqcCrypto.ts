/**
 * Post-quantum ML-KEM-768 (FIPS 203 / Kyber) primitives for SpooVault.
 *
 * Uses the `mlkem` TypeScript implementation (browser / Node compatible).
 * The issue referenced `@libertrai/kyber-ts`, which is not published on npm;
 * `mlkem` provides the equivalent NIST ML-KEM-768 API suitable for Wasm bundling.
 */

import { createMlKem768 } from "mlkem";

/** ML-KEM-768 sizes (bytes) per FIPS 203. */
export const ML_KEM_768_PUBLIC_KEY_BYTES = 1184;
export const ML_KEM_768_SECRET_KEY_BYTES = 2400;
export const ML_KEM_768_CIPHERTEXT_BYTES = 1088;
export const ML_KEM_768_SHARED_SECRET_BYTES = 32;

export interface MlKem768KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface MlKem768KeyPairBase64 {
  publicKey: string;
  secretKey: string;
}

export interface MlKem768Encapsulation {
  ciphertext: Uint8Array;
  sharedSecret: Uint8Array;
}

type MlKem768 = Awaited<ReturnType<typeof createMlKem768>>;

let kemInstance: MlKem768 | null = null;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  let sanitized = base64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  while (sanitized.length % 4 !== 0) sanitized += "=";
  const binary = atob(sanitized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Lazily initialize a shared ML-KEM-768 engine. */
export async function getMlKem768(): Promise<MlKem768> {
  if (!kemInstance) {
    kemInstance = await createMlKem768();
  }
  return kemInstance;
}

/** Generate a fresh ML-KEM-768 key pair. */
export async function generateMlKem768KeyPair(): Promise<MlKem768KeyPair> {
  const kem = await getMlKem768();
  const [publicKey, secretKey] = kem.generateKeyPair();
  return { publicKey, secretKey };
}

/** Generate ML-KEM-768 keys as Base64 strings. */
export async function generateMlKem768KeyPairBase64(): Promise<MlKem768KeyPairBase64> {
  const { publicKey, secretKey } = await generateMlKem768KeyPair();
  return {
    publicKey: toBase64(publicKey),
    secretKey: toBase64(secretKey),
  };
}

/** Encapsulate to a recipient ML-KEM-768 public key → (ct, ss). */
export async function mlKem768Encapsulate(
  recipientPublicKey: Uint8Array | string
): Promise<MlKem768Encapsulation> {
  const kem = await getMlKem768();
  const pk =
    typeof recipientPublicKey === "string"
      ? fromBase64(recipientPublicKey)
      : recipientPublicKey;
  if (pk.length !== ML_KEM_768_PUBLIC_KEY_BYTES) {
    throw new Error(
      `Invalid ML-KEM-768 public key length: expected ${ML_KEM_768_PUBLIC_KEY_BYTES}, got ${pk.length}`
    );
  }
  const [ciphertext, sharedSecret] = kem.encap(pk);
  return { ciphertext, sharedSecret };
}

/** Decapsulate ML-KEM-768 ciphertext with recipient secret key → ss. */
export async function mlKem768Decapsulate(
  ciphertext: Uint8Array | string,
  recipientSecretKey: Uint8Array | string
): Promise<Uint8Array> {
  const kem = await getMlKem768();
  const ct = typeof ciphertext === "string" ? fromBase64(ciphertext) : ciphertext;
  const sk =
    typeof recipientSecretKey === "string"
      ? fromBase64(recipientSecretKey)
      : recipientSecretKey;

  if (ct.length !== ML_KEM_768_CIPHERTEXT_BYTES) {
    throw new Error(
      `Invalid ML-KEM-768 ciphertext length: expected ${ML_KEM_768_CIPHERTEXT_BYTES}, got ${ct.length}`
    );
  }
  if (sk.length !== ML_KEM_768_SECRET_KEY_BYTES) {
    throw new Error(
      `Invalid ML-KEM-768 secret key length: expected ${ML_KEM_768_SECRET_KEY_BYTES}, got ${sk.length}`
    );
  }

  return kem.decap(ct, sk);
}

/** Concatenate byte arrays. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
