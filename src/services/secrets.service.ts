/**
 * Shamir's Secret Sharing (SSS) over Galois Field GF(256)
 *
 * Used to split the document's symmetric AES-256 key into N guardian shares
 * and reconstruct it using any K shares.
 */

// Irreducible polynomial for GF(256): x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
// The bottom bits are 0x1d (29).
const GF_POLYNOMIAL = 0x1d;

const LOG_TABLE = new Uint8Array(256);
const EXP_TABLE = new Uint8Array(512); // Doubled size to avoid % 255 in gfMultiply

// Statically pre-compute Galois Field Log and Anti-Log (Exp) lookup tables
(function initGFTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    EXP_TABLE[i + 255] = x;
    LOG_TABLE[x] = i;

    let temp = (x << 1) & 0xff;
    if (x & 0x80) {
      temp ^= GF_POLYNOMIAL;
    }
    x = temp;
  }
})();

/**
 * Multiply two numbers in GF(256) using O(1) pre-computed lookup tables
 */
export function gfMultiply(a: number, b: number): number {
  const tempA = a & 0xff;
  const tempB = b & 0xff;
  if (tempA === 0 || tempB === 0) return 0;
  return EXP_TABLE[LOG_TABLE[tempA] + LOG_TABLE[tempB]];
}

/**
 * Find multiplicative inverse of a number in GF(256) using O(1) pre-computed lookup table
 */
export function gfInverse(a: number): number {
  const val = a & 0xff;
  if (val === 0) throw new Error("GF(256) division by zero");
  return EXP_TABLE[255 - LOG_TABLE[val]];
}

/**
 * Reconstruct a single byte from K shares
 * shares is an array of [x, y] coordinates
 */
function reconstructByte(shares: Array<[number, number]>): number {
  let secret = 0;

  for (let i = 0; i < shares.length; i++) {
    const [xi, yi] = shares[i];
    let lagrange = 1;

    for (let j = 0; j < shares.length; j++) {
      if (i === j) continue;
      const [xj] = shares[j];
      // Formula: Product of (xj / (xj ^ xi))
      const numerator = xj;
      const denominator = xj ^ xi;
      lagrange = gfMultiply(lagrange, gfMultiply(numerator, gfInverse(denominator)));
    }

    secret ^= gfMultiply(yi, lagrange);
  }

  return secret;
}

let mockCrypto: any = null;
export function setMockCrypto(mock: any) {
  mockCrypto = mock;
}

/**
 * Secure 256-bit prime subgroup parameters for Feldmann VSS.
 * Q is a 256-bit prime, and P = 2Q + 1 is a safe prime.
 * G generates the unique subgroup of quadratic residues of order Q modulo P.
 */
export const VSS_Q = BigInt("115792089237316195423570985008687907853269984665640564039457584007913129658411");
export const VSS_P = BigInt("231584178474632390847141970017375815706539969331281128078915168015826259316823");
export const VSS_G = 4n;

// Modular arithmetic helpers
function modAdd(a: bigint, b: bigint, m: bigint): bigint {
  return (a + b) % m;
}

function modSub(a: bigint, b: bigint, m: bigint): bigint {
  return (a - b + m) % m;
}

function modMul(a: bigint, b: bigint, m: bigint): bigint {
  return (a * b) % m;
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let res = 1n;
  let b = base % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) {
      res = (res * b) % m;
    }
    b = (b * b) % m;
    e >>= 1n;
  }
  return res;
}

function modInverse(a: bigint, m: bigint): bigint {
  if (a % m === 0n) throw new Error("Division by zero in modular inverse");
  return modPow(a, m - 2n, m);
}

/**
 * Split a hex secret string (e.g. AES key) into N shares with threshold K using Feldmann VSS.
 * Returns both the shares (format: "x-vssHexdata") and the public coefficient commitments.
 */
export function splitSecretVSS(
  secretHex: string,
  n: number,
  k: number
): { shares: string[]; commitments: string[] } {
  if (k > n) throw new Error("Threshold cannot exceed total shares");
  if (k < 1) throw new Error("Threshold must be at least 1");

  const cleanHex = secretHex.startsWith("0x") ? secretHex.slice(2) : secretHex;
  if (cleanHex.length % 2 !== 0) {
    throw new Error("Secret hex string must have an even length");
  }

  const secretBig = BigInt("0x" + cleanHex);
  if (secretBig >= VSS_Q) {
    throw new Error("Secret key is too large for the VSS prime field");
  }

  // Coefficients: a_0 is the secret key, a_1 ... a_{k-1} are random
  const coefficients = new Array<bigint>(k);
  coefficients[0] = secretBig;

  const randomBytes = new Uint8Array(32);
  const cryptoObj =
    mockCrypto !== null ? mockCrypto : (typeof window !== "undefined" ? window.crypto : (typeof globalThis !== "undefined" ? globalThis.crypto : undefined));

  for (let i = 1; i < k; i++) {
    let randVal = 0n;
    if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
      cryptoObj.getRandomValues(randomBytes);
      let hex = "";
      for (let j = 0; j < 32; j++) {
        hex += randomBytes[j].toString(16).padStart(2, "0");
      }
      randVal = BigInt("0x" + hex) % VSS_Q;
    } else {
      let hex = "";
      for (let j = 0; j < 32; j++) {
        hex += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
      }
      randVal = BigInt("0x" + hex) % VSS_Q;
    }
    coefficients[i] = randVal;
  }

  // Calculate y_i for each x_i = 1 ... n
  const shares: string[] = [];
  const lenHex = cleanHex.length.toString(16).padStart(2, "0");
  for (let x = 1; x <= n; x++) {
    const xBig = BigInt(x);
    let y = 0n;
    let xPower = 1n;
    for (let j = 0; j < k; j++) {
      const term = modMul(coefficients[j], xPower, VSS_Q);
      y = modAdd(y, term, VSS_Q);
      xPower = modMul(xPower, xBig, VSS_Q);
    }
    const hexVal = y.toString(16).padStart(64, "0");
    shares.push(`${x}-vss${lenHex}${hexVal}`);
  }

  // Compute commitments: C_j = g^(a_j) mod P
  const commitments: string[] = [];
  for (let j = 0; j < k; j++) {
    const c = modPow(VSS_G, coefficients[j], VSS_P);
    commitments.push(c.toString(16).padStart(66, "0"));
  }

  return { shares, commitments };
}

/**
 * Split a hex secret string (e.g. AES key) into N shares with threshold K.
 * Legacy-compatible wrapper that drops the VSS commitments.
 */
export function splitSecret(secretHex: string, n: number, k: number): string[] {
  return splitSecretVSS(secretHex, n, k).shares;
}

/**
 * Verify a guardian share against VSS commitments.
 */
export function verifyShare(shareString: string, commitments: string[]): boolean {
  try {
    const parts = shareString.split("-");
    if (parts.length !== 2) return false;
    const x = BigInt(parts[0]);
    let hex = parts[1];
    if (hex.startsWith("vss")) {
      // VSS prefix is "vss" (3 chars) + length prefix (2 chars) = 5 chars
      hex = hex.slice(5);
    } else {
      return false; // Cannot verify legacy GF(256) shares
    }
    const y = BigInt("0x" + hex);

    const k = commitments.length;
    // Left-hand side: g^y mod P
    const lhs = modPow(VSS_G, y, VSS_P);

    // Right-hand side: Product of (C_j)^(x^j) mod P
    let rhs = 1n;
    for (let j = 0; j < k; j++) {
      const cj = BigInt("0x" + commitments[j]);
      const xPower = modPow(x, BigInt(j), VSS_Q);
      const term = modPow(cj, xPower, VSS_P);
      rhs = modMul(rhs, term, VSS_P);
    }

    return lhs === rhs;
  } catch {
    return false;
  }
}

/**
 * Reconstruct the hex secret string from an array of share strings.
 * Automatically handles both VSS (modulo Q) and legacy (GF(256) byte-by-byte) shares.
 */
export function reconstructSecret(shareStrings: string[]): string {
  if (shareStrings.length === 0) {
    throw new Error("No shares provided for reconstruction");
  }

  const isVSS = shareStrings[0].split("-")[1]?.startsWith("vss");

  if (!isVSS) {
    // Fallback to legacy SSS reconstruction over GF(256)
    const parsedShares: Array<{ x: number; bytes: Uint8Array }> = shareStrings.map((s) => {
      const parts = s.split("-");
      if (parts.length !== 2) {
        throw new Error(`Invalid share format: ${s}`);
      }
      const x = parseInt(parts[0], 10);
      const hex = parts[1];
      if (Number.isNaN(x) || x < 1) {
        throw new Error(`Invalid x-coordinate in share: ${s}`);
      }
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      }
      return { x, bytes };
    });

    const numBytes = parsedShares[0].bytes.length;
    for (const s of parsedShares) {
      if (s.bytes.length !== numBytes) {
        throw new Error("All shares must have the same length");
      }
    }

    const reconstructedBytes = new Uint8Array(numBytes);

    for (let byteIndex = 0; byteIndex < numBytes; byteIndex++) {
      const coordinates: Array<[number, number]> = parsedShares.map((s) => [
        s.x,
        s.bytes[byteIndex],
      ]);
      reconstructedBytes[byteIndex] = reconstructByte(coordinates);
    }

    return Array.from(reconstructedBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  // VSS reconstruction modulo Q
  let originalLen = 64;
  const parsedShares = shareStrings.map((s) => {
    const parts = s.split("-");
    if (parts.length !== 2) {
      throw new Error(`Invalid share format: ${s}`);
    }
    const x = BigInt(parts[0]);
    let hex = parts[1];
    if (hex.startsWith("vss")) {
      const lenHex = hex.slice(3, 5);
      originalLen = parseInt(lenHex, 16);
      hex = hex.slice(5);
    }
    const y = BigInt("0x" + hex);
    return { x, y };
  });

  let secret = 0n;
  for (let i = 0; i < parsedShares.length; i++) {
    const { x: xi, y: yi } = parsedShares[i];
    let lagrange = 1n;

    for (let j = 0; j < parsedShares.length; j++) {
      if (i === j) continue;
      const { x: xj } = parsedShares[j];
      const numerator = xj;
      const denominator = modSub(xj, xi, VSS_Q);
      const term = modMul(numerator, modInverse(denominator, VSS_Q), VSS_Q);
      lagrange = modMul(lagrange, term, VSS_Q);
    }

    secret = modAdd(secret, modMul(yi, lagrange, VSS_Q), VSS_Q);
  }

  return secret.toString(16).padStart(originalLen, "0");
}

/**
 * Parse JSON wrapped encrypted metadata payload carrying commitments.
 */
export function parseEncryptedMetadataPayload(payloadStr: string): {
  ciphertext: string;
  commitments: string[];
} {
  try {
    const parsed = JSON.parse(payloadStr);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.ciphertext === "string" &&
      Array.isArray(parsed.commitments)
    ) {
      return {
        ciphertext: parsed.ciphertext,
        commitments: parsed.commitments,
      };
    }
  } catch {
    // Ignore JSON parsing errors and treat as raw ciphertext
  }
  return {
    ciphertext: payloadStr,
    commitments: [],
  };
}

/**
 * Passphrase-based key derivation for backup/keyring exports (issue #20)
 *
 * Raw user passphrases were previously used directly as AES keys when
 * exporting/restoring vault backup keys, which is vulnerable to offline
 * brute-force/dictionary attacks if a backup blob is intercepted. These
 * functions derive a strong AES-256-GCM key from the passphrase via
 * PBKDF2-SHA256 (600,000 iterations, per OWASP guidance) instead.
 */

export const PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH_BYTES = 16;
const IV_LENGTH_BYTES = 12; // standard AES-GCM nonce size
const PASSPHRASE_PAYLOAD_VERSION = "pbkdf2-sha256-aes256gcm-v1";

export interface PassphraseEncryptedPayload {
  version: string;
  iterations: number;
  salt: string; // base64
  iv: string; // base64
  ciphertext: string; // base64
}

const getWebCrypto = (): Crypto => {
  const cryptoObj: Crypto | undefined =
    (typeof window !== "undefined" ? window.crypto : undefined) ??
    (typeof globalThis !== "undefined" ? globalThis.crypto : undefined);
  if (!cryptoObj?.subtle) {
    throw new Error("Web Crypto API (crypto.subtle) is not available in this environment");
  }
  return cryptoObj;
};

const getRandomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  getWebCrypto().getRandomValues(bytes);
  return bytes;
};

const utf8ToBytes = (str: string): Uint8Array => new TextEncoder().encode(str);
const bytesToUtf8 = (bytes: ArrayBuffer): string => new TextDecoder().decode(bytes);

const base64ToBytes = (base64: string): Uint8Array => {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

/**
 * Derive an AES-256-GCM CryptoKey from a user passphrase using PBKDF2
 * (SHA-256, 600,000 iterations by default). A random, unique salt must be
 * supplied per encryption so the same passphrase never derives the same
 * key twice. The derived key is non-extractable (raw bits never leave
 * the Web Crypto API).
 */
export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  if (!passphrase) {
    throw new Error("Passphrase must not be empty");
  }
  const subtle = getWebCrypto().subtle;
  const keyMaterial = await subtle.importKey(
    "raw",
    utf8ToBytes(passphrase) as BufferSource,
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt a backup/keyring payload (e.g. a hex vault key, or a reconstructed
 * guardian secret) with a user-supplied passphrase. Returns a self-describing
 * JSON payload carrying the salt, IV, and iteration count needed to re-derive
 * the same key on decrypt -- never the raw passphrase or derived key.
 */
export async function encryptWithPassphrase(
  plaintext: string,
  passphrase: string,
  iterations: number = PBKDF2_ITERATIONS
): Promise<string> {
  const salt = getRandomBytes(SALT_LENGTH_BYTES);
  const iv = getRandomBytes(IV_LENGTH_BYTES);
  const key = await deriveKeyFromPassphrase(passphrase, salt, iterations);

  const ciphertextBuffer = await getWebCrypto().subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    utf8ToBytes(plaintext) as BufferSource
  );

  const payload: PassphraseEncryptedPayload = {
    version: PASSPHRASE_PAYLOAD_VERSION,
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuffer)),
  };

  return JSON.stringify(payload);
}

/**
 * Decrypt a payload produced by encryptWithPassphrase. Re-derives the key
 * from the supplied passphrase using the embedded salt/iteration count. An
 * incorrect passphrase fails the AES-GCM authentication tag check (throws)
 * rather than silently producing garbage plaintext.
 */
export async function decryptWithPassphrase(
  payloadJson: string,
  passphrase: string
): Promise<string> {
  let payload: PassphraseEncryptedPayload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new Error("Invalid encrypted backup payload");
  }

  if (payload.version !== PASSPHRASE_PAYLOAD_VERSION) {
    throw new Error(`Unsupported backup payload version: ${payload.version}`);
  }

  const salt = base64ToBytes(payload.salt);
  const iv = base64ToBytes(payload.iv);
  const ciphertext = base64ToBytes(payload.ciphertext);
  const key = await deriveKeyFromPassphrase(passphrase, salt, payload.iterations);

  let plaintextBuffer: ArrayBuffer;
  try {
    plaintextBuffer = await getWebCrypto().subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource
    );
  } catch {
    throw new Error("Failed to decrypt backup: incorrect passphrase or corrupted data");
  }

  return bytesToUtf8(plaintextBuffer);
}

export const secretsService = {
  splitSecret,
  splitSecretVSS,
  verifyShare,
  reconstructSecret,
  deriveKeyFromPassphrase,
  encryptWithPassphrase,
  decryptWithPassphrase,
  parseEncryptedMetadataPayload,
  setMockCrypto,
};
