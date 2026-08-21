/**
 * Timelock Encryption engine based on Wesolowski / Pietrzak VDFs.
 *
 * Evaluation requires T sequential modular squarings over an RSA modulus N
 * (factorization discarded). The VDF output derives an AES-256-GCM key so
 * documents stay cryptographically locked until the delay elapses.
 */

import { keccak256, solidityPacked } from "ethers";
import {
  base64ToUint8Array,
  stringToUint8Array,
  uint8ArrayToBase64,
  uint8ArrayToString,
} from "./crypto";

export const TIMELOCK_VERSION = "vdf-wesolowski-aes256gcm-v1";

/** Default challenge bit-length for Fiat–Shamir (Wesolowski). */
export const DEFAULT_CHALLENGE_BITS = 128;

export interface VdfParams {
  /** RSA modulus N = p·q (factors must be discarded for soundness). */
  N: bigint;
  /** Number of sequential squarings. */
  T: number;
  /** Optional starting group element; defaults to a canonical challenge. */
  x?: bigint;
}

export interface WesolowskiProof {
  y: bigint;
  pi: bigint;
  l: bigint;
  r: bigint;
}

export interface PietrzakProof {
  y: bigint;
  /** Intermediate μ values, one per halving round (log₂ T entries). */
  mus: bigint[];
}

export interface TimelockCiphertext {
  version: string;
  N: string;
  T: number;
  x: string;
  y: string;
  pi: string;
  l: string;
  iv: string;
  ciphertext: string;
}

const MODEXP_PRECOMPILE_GAS_HINT = 200_000;

function assertPositiveBigInt(value: bigint, label: string): void {
  if (value <= 0n) {
    throw new Error(`${label} must be a positive bigint`);
  }
}

function assertValidT(T: number): void {
  if (!Number.isInteger(T) || T < 1) {
    throw new Error("T must be a positive integer");
  }
}

/**
 * Canonical starting element in (Z/NZ)* when the caller does not supply x.
 * Uses keccak of the public parameters so setups are deterministic.
 */
export function deriveChallengeElement(N: bigint, T: number): bigint {
  assertPositiveBigInt(N, "N");
  assertValidT(T);
  const digest = keccak256(
    solidityPacked(["bytes", "uint256", "uint64"], [toBytesBE(N), N, BigInt(T)])
  );
  let x = bytesToBigInt(hexToBytes(digest)) % N;
  if (x <= 1n) x = 2n;
  return x;
}

/** T sequential squarings: y = x^(2^T) mod N. */
export function evaluateVdf(x: bigint, T: number, N: bigint): bigint {
  assertPositiveBigInt(N, "N");
  assertPositiveBigInt(x, "x");
  assertValidT(T);
  let y = x % N;
  for (let i = 0; i < T; i++) {
    y = (y * y) % N;
  }
  return y;
}

/**
 * Fiat–Shamir challenge ℓ derived via keccak256 (matches on-chain verifier).
 * For moduli that fit in uint256, x/y/N are packed as 32-byte words and T as
 * uint64 — identical to `abi.encodePacked(uint256,uint256,uint64,uint256)`.
 * Larger (off-chain-only) moduli use minimal equal-width packing.
 */
export function fiatShamirChallenge(
  x: bigint,
  y: bigint,
  T: number,
  N: bigint,
  challengeBits: number = DEFAULT_CHALLENGE_BITS
): bigint {
  const onChain = byteLength(N) <= 32;
  const width = onChain ? 32 : byteLength(N);
  const digest = keccak256(
    solidityPacked(
      ["bytes", "bytes", "uint64", "bytes"],
      [
        toBytesBEPadded(x % N, width),
        toBytesBEPadded(y % N, width),
        BigInt(T),
        toBytesBEPadded(N, width),
      ]
    )
  );
  const mask = (1n << BigInt(challengeBits)) - 1n;
  let l = bytesToBigInt(hexToBytes(digest)) & mask;
  if (l < 3n) l = 3n;
  if ((l & 1n) === 0n) l += 1n;
  return l;
}

/**
 * Wesolowski proof: π = x^⌊2^T / ℓ⌋ mod N, produced during the same
 * sequential pass used for evaluation (no φ(N) trapdoor).
 */
export function proveWesolowski(
  x: bigint,
  T: number,
  N: bigint,
  challengeBits: number = DEFAULT_CHALLENGE_BITS
): WesolowskiProof {
  assertPositiveBigInt(N, "N");
  assertPositiveBigInt(x, "x");
  assertValidT(T);

  const xMod = x % N;
  let y = xMod;
  for (let i = 0; i < T; i++) {
    y = (y * y) % N;
  }

  const l = fiatShamirChallenge(xMod, y, T, N, challengeBits);

  // Build π via MSB-first square-and-multiply of q = ⌊2^T / ℓ⌋ while
  // tracking r = 2^T mod ℓ — O(T) group ops, same delay as Eval.
  let pi = 1n;
  let rem = 1n;
  for (let i = 0; i < T; i++) {
    const doubled = rem << 1n;
    const bit = doubled >= l ? 1n : 0n;
    rem = doubled % l;
    pi = (pi * pi) % N;
    if (bit === 1n) {
      pi = (pi * xMod) % N;
    }
  }

  return { y, pi, l, r: rem };
}

/** Verify Wesolowski proof: π^ℓ · x^r ≡ y (mod N), r = 2^T mod ℓ. */
export function verifyWesolowski(
  x: bigint,
  T: number,
  N: bigint,
  proof: WesolowskiProof,
  challengeBits: number = DEFAULT_CHALLENGE_BITS
): boolean {
  assertPositiveBigInt(N, "N");
  assertValidT(T);

  const xMod = x % N;
  const expectedL = fiatShamirChallenge(xMod, proof.y, T, N, challengeBits);
  if (proof.l !== expectedL) return false;

  const r = modPow(2n, BigInt(T), proof.l);
  if (proof.r !== r) return false;

  const left = (modPow(proof.pi, proof.l, N) * modPow(xMod, r, N)) % N;
  return left === proof.y % N;
}

/**
 * Pietrzak proof (μ values for each T → T/2 round). T must be a power of two.
 * Verification is O(log T) group exponentiations.
 */
export function provePietrzak(x: bigint, T: number, N: bigint): PietrzakProof {
  assertPositiveBigInt(N, "N");
  assertPositiveBigInt(x, "x");
  if (!Number.isInteger(T) || T < 2 || (T & (T - 1)) !== 0) {
    throw new Error("Pietrzak VDF requires T to be a power of two >= 2");
  }

  const xMod = x % N;
  const y = evaluateVdf(xMod, T, N);
  const mus: bigint[] = [];
  let curX = xMod;
  let curY = y;
  let curT = T;

  while (curT > 1) {
    const half = curT >> 1;
    // μ = curX^(2^half) mod N
    const mu = evaluateVdf(curX, half, N);
    mus.push(mu);

    const r = pietrzakChallenge(curX, curY, mu, curT, N);
    curX = (modPow(curX, r, N) * mu) % N;
    curY = (modPow(mu, r, N) * curY) % N;
    curT = half;
  }

  return { y, mus };
}

/** O(log T) Pietrzak verification. */
export function verifyPietrzak(
  x: bigint,
  T: number,
  N: bigint,
  proof: PietrzakProof
): boolean {
  assertPositiveBigInt(N, "N");
  if (!Number.isInteger(T) || T < 2 || (T & (T - 1)) !== 0) {
    return false;
  }
  const expectedRounds = Math.log2(T);
  if (proof.mus.length !== expectedRounds) return false;

  let curX = x % N;
  let curY = proof.y % N;
  let curT = T;

  for (const mu of proof.mus) {
    if (mu <= 0n || mu >= N) return false;
    const half = curT >> 1;
    const r = pietrzakChallenge(curX, curY, mu, curT, N);
    curX = (modPow(curX, r, N) * mu) % N;
    curY = (modPow(mu, r, N) * curY) % N;
    curT = half;
  }

  return curT === 1 && (curX * curX) % N === curY;
}

function pietrzakChallenge(
  x: bigint,
  y: bigint,
  mu: bigint,
  T: number,
  N: bigint
): bigint {
  const onChain = byteLength(N) <= 32;
  const width = onChain ? 32 : byteLength(N);
  const digest = keccak256(
    solidityPacked(
      ["bytes", "bytes", "bytes", "uint64", "bytes"],
      [
        toBytesBEPadded(x % N, width),
        toBytesBEPadded(y % N, width),
        toBytesBEPadded(mu % N, width),
        BigInt(T),
        toBytesBEPadded(N, width),
      ]
    )
  );
  let r = bytesToBigInt(hexToBytes(digest)) & ((1n << 128n) - 1n);
  if (r === 0n) r = 1n;
  return r;
}

/** K = SHA-256(VDF_output) as raw 32 bytes for AES-256-GCM. */
export async function deriveKeyFromVdfOutput(y: bigint): Promise<CryptoKey> {
  const subtle = getSubtle();
  const hash = await subtle.digest("SHA-256", toArrayBuffer(toBytesBE(y)));
  return subtle.importKey("raw", hash, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Export raw AES key bytes (for tests / debugging). */
export async function hashVdfOutput(y: bigint): Promise<Uint8Array> {
  const subtle = getSubtle();
  const hash = await subtle.digest("SHA-256", toArrayBuffer(toBytesBE(y)));
  return new Uint8Array(hash);
}

/**
 * Encrypt a document under a key that is only knowable after evaluating the VDF.
 * Returns the ciphertext plus a Wesolowski proof of the committed output y.
 */
export async function encryptTimelock(
  plaintext: string | Uint8Array,
  params: VdfParams,
  challengeBits: number = DEFAULT_CHALLENGE_BITS
): Promise<TimelockCiphertext> {
  const N = params.N;
  const T = params.T;
  const x = params.x ?? deriveChallengeElement(N, T);
  const proof = proveWesolowski(x, T, N, challengeBits);
  const key = await deriveKeyFromVdfOutput(proof.y);

  const iv = new Uint8Array(12);
  getCrypto().getRandomValues(iv);
  const plainBytes =
    typeof plaintext === "string" ? stringToUint8Array(plaintext) : plaintext;

  const ciphertextBuf = await getSubtle().encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(plainBytes)
  );

  return {
    version: TIMELOCK_VERSION,
    N: N.toString(16),
    T,
    x: x.toString(16),
    y: proof.y.toString(16),
    pi: proof.pi.toString(16),
    l: proof.l.toString(16),
    iv: uint8ArrayToBase64(iv),
    ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertextBuf)),
  };
}

/**
 * Decrypt after (re)evaluating / verifying the VDF. Rejects if the attached
 * proof is invalid or the output does not match the committed y.
 */
export async function decryptTimelock(
  payload: TimelockCiphertext | string
): Promise<string> {
  const data: TimelockCiphertext =
    typeof payload === "string" ? JSON.parse(payload) : payload;

  if (data.version !== TIMELOCK_VERSION) {
    throw new Error(`Unsupported timelock version: ${data.version}`);
  }

  const N = BigInt("0x" + data.N);
  const x = BigInt("0x" + data.x);
  const y = BigInt("0x" + data.y);
  const pi = BigInt("0x" + data.pi);
  const l = BigInt("0x" + data.l);
  const T = data.T;

  // Re-evaluate the delay function — this is the sequential bottleneck.
  const evaluated = evaluateVdf(x, T, N);
  if (evaluated !== y) {
    throw new Error("VDF output mismatch — timelock not satisfied");
  }

  const proof: WesolowskiProof = {
    y,
    pi,
    l,
    r: modPow(2n, BigInt(T), l),
  };
  if (!verifyWesolowski(x, T, N, proof)) {
    throw new Error("Invalid Wesolowski VDF proof");
  }

  const key = await deriveKeyFromVdfOutput(y);
  const iv = base64ToUint8Array(data.iv);
  const ciphertext = base64ToUint8Array(data.ciphertext);

  let decrypted: ArrayBuffer;
  try {
    decrypted = await getSubtle().decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ciphertext)
    );
  } catch {
    throw new Error("AES-GCM decryption failed");
  }

  return uint8ArrayToString(new Uint8Array(decrypted));
}

/**
 * Generate a toy RSA modulus for tests / local demos.
 * Factors are returned so callers can discard them (simulate ceremony).
 */
export function generateTestRsaModulus(bits = 512): {
  N: bigint;
  p: bigint;
  q: bigint;
} {
  if (bits < 256 || bits % 2 !== 0) {
    throw new Error("bits must be even and >= 256");
  }
  const half = bits / 2;
  const p = randomPrime(half);
  let q = randomPrime(half);
  while (q === p) q = randomPrime(half);
  return { N: p * q, p, q };
}

/**
 * Deterministic 256-bit RSA modulus from two fixed primes (tests / on-chain).
 * Factors are found near 2^127 offsets and must be treated as discarded.
 */
export function fixedTestModulus256(): bigint {
  const P = findPrimeNear((1n << 127n) + 12345n);
  const Q = findPrimeNear((1n << 127n) + 67891n);
  return P * Q;
}

/** @deprecated alias — on-chain path uses 256-bit moduli. */
export function fixedTestModulus512(): bigint {
  return fixedTestModulus256();
}

let cachedFixedN: bigint | null = null;
export function getFixedTestModulus(): bigint {
  if (!cachedFixedN) {
    cachedFixedN = fixedTestModulus256();
  }
  return cachedFixedN;
}

export function estimateWesolowskiVerifyGasHint(): number {
  return MODEXP_PRECOMPILE_GAS_HINT;
}

// ─── BigInt / bytes helpers ───────────────────────────────────────────────

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n;
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

export function toBytesBE(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("negative bigint");
  if (value === 0n) return new Uint8Array([0]);
  let hex = value.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function byteLength(value: bigint): number {
  if (value === 0n) return 1;
  return Math.ceil(value.toString(16).length / 2);
}

/** Big-endian encoding padded on the left to `width` bytes (on-chain layout). */
export function toBytesBEPadded(value: bigint, width: number): Uint8Array {
  const raw = toBytesBE(value);
  if (raw.length === width) return raw;
  if (raw.length > width) return raw.slice(raw.length - width);
  const out = new Uint8Array(width);
  out.set(raw, width - raw.length);
  return out;
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = "0x";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return BigInt(hex === "0x" ? "0x0" : hex);
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bigintToHexPad(value: bigint, byteLen: number): string {
  let hex = value.toString(16);
  const target = byteLen * 2;
  if (hex.length > target) {
    hex = hex.slice(hex.length - target);
  } else {
    hex = hex.padStart(target, "0");
  }
  return "0x" + hex;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function getCrypto(): Crypto {
  const c =
    (typeof globalThis !== "undefined" ? globalThis.crypto : undefined) ??
    (typeof window !== "undefined" ? window.crypto : undefined);
  if (!c) throw new Error("Web Crypto API is not available");
  return c;
}

function getSubtle(): SubtleCrypto {
  const subtle = getCrypto().subtle;
  if (!subtle) throw new Error("crypto.subtle is not available");
  return subtle;
}

function randomPrime(bits: number): bigint {
  const bytes = Math.ceil(bits / 8);
  for (;;) {
    const buf = new Uint8Array(bytes);
    getCrypto().getRandomValues(buf);
    buf[0] |= 0x80;
    buf[buf.length - 1] |= 1;
    const candidate = bytesToBigInt(buf);
    if (isProbablePrime(candidate)) return candidate;
  }
}

function findPrimeNear(start: bigint): bigint {
  let n = start | 1n;
  while (!isProbablePrime(n)) n += 2n;
  return n;
}

/** Miller–Rabin probable-prime test. */
export function isProbablePrime(n: bigint, rounds = 16): boolean {
  if (n < 2n) return false;
  if (n === 2n || n === 3n) return true;
  if ((n & 1n) === 0n) return false;

  let d = n - 1n;
  let s = 0n;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s += 1n;
  }

  const bases = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n];
  for (let i = 0; i < rounds; i++) {
    const a = bases[i % bases.length] % n;
    if (a === 0n) continue;
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let cont = false;
    for (let r = 1n; r < s; r++) {
      x = (x * x) % n;
      if (x === n - 1n) {
        cont = true;
        break;
      }
    }
    if (!cont) return false;
  }
  return true;
}
