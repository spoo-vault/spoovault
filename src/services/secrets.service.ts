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
 * Split a single byte into N shares with threshold K
 */
function splitByte(secret: number, n: number, k: number): number[] {
  if (k > n) throw new Error("Threshold cannot exceed total shares");
  if (k < 1) throw new Error("Threshold must be at least 1");

  // Coefficients: a_0 is the secret byte, a_1 ... a_{k-1} are random bytes
  const coefficients = new Uint8Array(k);
  coefficients[0] = secret;

  const randomValues = new Uint8Array(k - 1);
  if (typeof window !== "undefined" && window.crypto) {
    window.crypto.getRandomValues(randomValues);
  } else if (typeof globalThis !== "undefined" && globalThis.crypto) {
    globalThis.crypto.getRandomValues(randomValues);
  } else {
    for (let i = 0; i < k - 1; i++) {
      randomValues[i] = Math.floor(Math.random() * 256);
    }
  }
  for (let i = 1; i < k; i++) {
    coefficients[i] = randomValues[i - 1];
  }

  const shares: number[] = [];
  // Calculate y for each x = 1 ... n
  for (let x = 1; x <= n; x++) {
    let y = 0;
    let xPower = 1;
    for (let j = 0; j < k; j++) {
      y ^= gfMultiply(coefficients[j], xPower);
      xPower = gfMultiply(xPower, x);
    }
    shares.push(y);
  }

  return shares;
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

/**
 * Split a hex secret string (e.g. AES key) into N shares with threshold K.
 * Returns an array of strings in format: "x_coordinate-hex_shares_y"
 */
export function splitSecret(secretHex: string, n: number, k: number): string[] {
  const cleanHex = secretHex.startsWith("0x") ? secretHex.slice(2) : secretHex;
  if (cleanHex.length % 2 !== 0) {
    throw new Error("Secret hex string must have an even length");
  }

  const secretBytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < secretBytes.length; i++) {
    secretBytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }

  const resultShares: string[][] = Array.from({ length: n }, () => []);

  for (let byteIndex = 0; byteIndex < secretBytes.length; byteIndex++) {
    const byteShares = splitByte(secretBytes[byteIndex], n, k);
    for (let shareIndex = 0; shareIndex < n; shareIndex++) {
      const hexVal = byteShares[shareIndex].toString(16).padStart(2, "0");
      resultShares[shareIndex].push(hexVal);
    }
  }

  // Format: "x-hexdata" where x is 1-indexed (1 to n)
  return resultShares.map((shareBytes, idx) => `${idx + 1}-${shareBytes.join("")}`);
}

/**
 * Reconstruct the hex secret string from an array of share strings.
 */
export function reconstructSecret(shareStrings: string[]): string {
  if (shareStrings.length === 0) {
    throw new Error("No shares provided for reconstruction");
  }

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
  reconstructSecret,
  deriveKeyFromPassphrase,
  encryptWithPassphrase,
  decryptWithPassphrase,
};
