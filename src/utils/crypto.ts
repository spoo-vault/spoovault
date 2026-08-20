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

/**
 * Uint8Array to String using standard TextDecoder (UTF-8)
 */
export function uint8ArrayToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

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
  nonce: string;
  ephemPublicKey: string;
  ciphertext: string;
}

/**
 * Encrypt a plaintext message for a receiver using their base64-encoded X25519 public key.
 * Compatible with MetaMask's eth_decrypt (x25519-xsalsa20-poly1305).
 */
export function encryptWithPublicKey(message: string, receiverPubKeyBase64: string): string {
  const ephemeralKeypair = nacl.box.keyPair();
  const receiverPubKey = base64ToUint8Array(receiverPubKeyBase64);
  const messageBytes = stringToUint8Array(message);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);

  const ciphertext = nacl.box(
    messageBytes,
    nonce,
    receiverPubKey,
    ephemeralKeypair.secretKey
  );

  const payload: EncryptedPayload = {
    version: "x25519-xsalsa20-poly1305",
    nonce: uint8ArrayToBase64(nonce),
    ephemPublicKey: uint8ArrayToBase64(ephemeralKeypair.publicKey),
    ciphertext: uint8ArrayToBase64(ciphertext),
  };

  return JSON.stringify(payload);
}

/**
 * Decrypt a ciphertext payload using receiver's base64-encoded X25519 private (secret) key.
 * Compatible with MetaMask's eth_decrypt (x25519-xsalsa20-poly1305).
 */
export function decryptWithPrivateKey(
  encryptedPayloadJson: string | EncryptedPayload,
  receiverSecretKeyBase64: string
): string {
  const payload: EncryptedPayload =
    typeof encryptedPayloadJson === "string"
      ? JSON.parse(encryptedPayloadJson)
      : encryptedPayloadJson;

  if (payload.version !== "x25519-xsalsa20-poly1305") {
    throw new Error(`Unsupported encryption version: ${payload.version}`);
  }

  const nonce = base64ToUint8Array(payload.nonce);
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
