import nacl from "tweetnacl";

/**
 * Base64 to Uint8Array
 * Handles standard Base64, URL-safe Base64 (- and _), and missing padding.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  let sanitized = base64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  while (sanitized.length % 4 !== 0) {
    sanitized += "=";
  }
  const binaryString = atob(sanitized);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Uint8Array to Base64
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * String to Uint8Array using standard TextEncoder (UTF-8)
 */
export function stringToUint8Array(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

export function uint8ArrayToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

/**
 * Encode UTF-8 string directly to Base64
 */
export function utf8ToBase64(str: string): string {
  return uint8ArrayToBase64(stringToUint8Array(str));
}

/**
 * Decode Base64 directly to UTF-8 string
 */
export function base64ToUtf8(base64: string): string {
  return uint8ArrayToString(base64ToUint8Array(base64));
}

export interface EncryptedPayload {

  version: string;
  nonce?: string;
  iv?: string;
  ephemPublicKey: string;
  ciphertext: string;
  mac?: string;
}

export const ECIES_VERSION = "ecies-p256-aes256gcm-v1";
export const LEGACY_X25519_VERSION = "x25519-xsalsa20-poly1305";

const getWebCrypto = (): Crypto => {
  const cryptoObj =
    (typeof window !== "undefined" ? window.crypto : undefined) ??
    (typeof globalThis !== "undefined" ? globalThis.crypto : undefined);
  if (!cryptoObj?.subtle) {
    throw new Error("Web Crypto API (crypto.subtle) is not available in this environment");
  }
  return cryptoObj;
};

/**
 * Generate a client-side ECDH P-256 KeyPair using Web Crypto API.
 */
export async function generateECIESKeyPair(): Promise<CryptoKeyPair> {
  const subtle = getWebCrypto().subtle;
  return subtle.generateKey(
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true,
    ["deriveKey", "deriveBits"]
  );
}

/**
 * Export ECDH P-256 Public Key to standard SPKI format Base64 string.
 */
export async function exportECIESPublicKey(publicKey: CryptoKey): Promise<string> {
  const subtle = getWebCrypto().subtle;
  const spkiBuffer = await subtle.exportKey("spki", publicKey);
  return uint8ArrayToBase64(new Uint8Array(spkiBuffer));
}

/**
 * Export ECDH P-256 Private Key to standard PKCS#8 format Base64 string.
 */
export async function exportECIESPrivateKey(privateKey: CryptoKey): Promise<string> {
  const subtle = getWebCrypto().subtle;
  const pkcs8Buffer = await subtle.exportKey("pkcs8", privateKey);
  return uint8ArrayToBase64(new Uint8Array(pkcs8Buffer));
}

/**
 * Import ECDH P-256 Public Key from Base64 string (supports both SPKI and raw uncompressed 65-byte formats).
 */
export async function importECIESPublicKey(pubKeyBase64: string): Promise<CryptoKey> {
  const subtle = getWebCrypto().subtle;
  const keyBytes = base64ToUint8Array(pubKeyBase64);

  // If 65 bytes starting with 0x04, it is uncompressed raw format
  if (keyBytes.length === 65 && keyBytes[0] === 0x04) {
    return subtle.importKey(
      "raw",
      toArrayBuffer(keyBytes),
      {
        name: "ECDH",
        namedCurve: "P-256",
      },
      true,
      []
    );
  }

  // Otherwise import as standard SPKI
  return subtle.importKey(
    "spki",
    toArrayBuffer(keyBytes),
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true,
    []
  );
}

/**
 * Import ECDH P-256 Private Key from PKCS#8 Base64 string.
 */
export async function importECIESPrivateKey(privKeyBase64: string): Promise<CryptoKey> {
  const subtle = getWebCrypto().subtle;
  const keyBytes = base64ToUint8Array(privKeyBase64);
  return subtle.importKey(
    "pkcs8",
    toArrayBuffer(keyBytes),
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true,
    ["deriveKey", "deriveBits"]
  );
}

/**
 * Convenience helper to generate a keypair and return Base64-encoded strings.
 */
export async function generateECIESKeyPairBase64(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const keyPair = await generateECIESKeyPair();
  const publicKey = await exportECIESPublicKey(keyPair.publicKey);
  const privateKey = await exportECIESPrivateKey(keyPair.privateKey);
  return { publicKey, privateKey };
}

/**
 * Encrypt a plaintext message for a receiver using their base64-encoded ECDH P-256 public key.
 * Uses Web Crypto API ECIES scheme (ECDH P-256 + AES-256-GCM).
 */
export async function encryptWithPublicKey(
  message: string,
  receiverPubKeyBase64: string
): Promise<string> {
  const subtle = getWebCrypto().subtle;

  // Generate ephemeral ECDH P-256 keypair
  const ephemKeyPair = await generateECIESKeyPair();
  const receiverPubKey = await importECIESPublicKey(receiverPubKeyBase64);

  // Derive AES-256-GCM key directly via ECDH
  const aesKey = await subtle.deriveKey(
    {
      name: "ECDH",
      public: receiverPubKey,
    },
    ephemKeyPair.privateKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt"]
  );

  // Generate 12-byte initialization vector (IV)
  const iv = new Uint8Array(12);
  getWebCrypto().getRandomValues(iv);

  const messageBytes = stringToUint8Array(message);
  const ciphertextBuffer = await subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
    },
    aesKey,
    toArrayBuffer(messageBytes)
  );

  const ephemPublicKeyBase64 = await exportECIESPublicKey(ephemKeyPair.publicKey);

  const payload: EncryptedPayload = {
    version: ECIES_VERSION,
    iv: uint8ArrayToBase64(iv),
    ephemPublicKey: ephemPublicKeyBase64,
    ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertextBuffer)),
  };

  return JSON.stringify(payload);
}

/**
 * Decrypt a ciphertext payload using receiver's base64-encoded private key.
 * Supports Web Crypto API ECIES (ECDH P-256 + AES-256-GCM) with fallback for legacy x25519-xsalsa20-poly1305 payloads.
 */
export async function decryptWithPrivateKey(
  encryptedPayloadJson: string | EncryptedPayload,
  receiverSecretKeyBase64: string
): Promise<string> {
  const payload: EncryptedPayload =
    typeof encryptedPayloadJson === "string"
      ? JSON.parse(encryptedPayloadJson)
      : encryptedPayloadJson;

  if (payload.version === ECIES_VERSION || payload.version?.startsWith("ecies-")) {
    const subtle = getWebCrypto().subtle;
    const receiverPrivateKey = await importECIESPrivateKey(receiverSecretKeyBase64);
    const ephemPublicKey = await importECIESPublicKey(payload.ephemPublicKey);

    const aesKey = await subtle.deriveKey(
      {
        name: "ECDH",
        public: ephemPublicKey,
      },
      receiverPrivateKey,
      {
        name: "AES-GCM",
        length: 256,
      },
      false,
      ["decrypt"]
    );

    const ivStr = payload.iv || payload.nonce;
    if (!ivStr) {
      throw new Error("Missing IV in encrypted ECIES payload");
    }

    const iv = base64ToUint8Array(ivStr);
    const ciphertext = base64ToUint8Array(payload.ciphertext);

    let decryptedBuffer: ArrayBuffer;
    try {
      decryptedBuffer = await subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(iv),
        },
        aesKey,
        toArrayBuffer(ciphertext)
      );
    } catch {
      throw new Error("Failed to decrypt ciphertext with provided private key");
    }

    return uint8ArrayToString(new Uint8Array(decryptedBuffer));
  }

  // Legacy TweetNaCl fallback for x25519-xsalsa20-poly1305 payloads
  if (payload.version === LEGACY_X25519_VERSION) {
    const nonce = base64ToUint8Array(payload.nonce || payload.iv || "");
    const ephemPublicKey = base64ToUint8Array(payload.ephemPublicKey);
    const ciphertext = base64ToUint8Array(payload.ciphertext);
    const secretKey = base64ToUint8Array(receiverSecretKeyBase64);

    const decryptedBytes = nacl.box.open(
      ciphertext,
      nonce,
      ephemPublicKey,
      secretKey
    );

    if (!decryptedBytes) {
      throw new Error("Failed to decrypt ciphertext with provided private key");
    }

    return uint8ArrayToString(decryptedBytes);
  }

  throw new Error(`Unsupported encryption version: ${payload.version}`);
}
