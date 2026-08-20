import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import {
  base64ToUint8Array,
  uint8ArrayToBase64,
  stringToUint8Array,
  uint8ArrayToString,
  utf8ToBase64,
  base64ToUtf8,
  generateECIESKeyPair,
  exportECIESPublicKey,
  exportECIESPrivateKey,
  importECIESPublicKey,
  importECIESPrivateKey,
  generateECIESKeyPairBase64,
  encryptWithPublicKey,
  decryptWithPrivateKey,
  ECIES_VERSION,
  LEGACY_X25519_VERSION,
} from "../utils/crypto";

describe("Web Crypto API ECIES & Encoding Utilities", () => {
  describe("Base64 <-> Uint8Array conversions", () => {
    it("should convert Uint8Array to Base64 and back accurately", () => {
      const originalBytes = new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100]);
      const b64 = uint8ArrayToBase64(originalBytes);
      const resultBytes = base64ToUint8Array(b64);

      expect(resultBytes).toEqual(originalBytes);
    });

    it("should handle empty Uint8Array and empty Base64 string", () => {
      const emptyBytes = new Uint8Array(0);
      const b64 = uint8ArrayToBase64(emptyBytes);
      expect(b64).toBe("");
      const decoded = base64ToUint8Array(b64);
      expect(decoded).toEqual(emptyBytes);
    });

    it("should correctly parse URL-safe Base64 strings with - and _ and missing padding", () => {
      const bytes = new Uint8Array([251, 255, 254, 253, 252]);
      const standardB64 = uint8ArrayToBase64(bytes);
      const urlSafeB64 = standardB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

      const decodedFromUrlSafe = base64ToUint8Array(urlSafeB64);
      expect(decodedFromUrlSafe).toEqual(bytes);
    });

    it("should ignore whitespace in Base64 strings", () => {
      const originalBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const b64 = uint8ArrayToBase64(originalBytes);
      const b64WithSpaces = `  ${b64.slice(0, 2)} \n ${b64.slice(2)}  \t `;
      const decoded = base64ToUint8Array(b64WithSpaces);
      expect(decoded).toEqual(originalBytes);
    });
  });

  describe("String <-> Uint8Array (UTF-8) conversions", () => {
    it("should convert ASCII String to Uint8Array and back", () => {
      const text = "SpooVault Security";
      const bytes = stringToUint8Array(text);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBe(text.length);
      expect(uint8ArrayToString(bytes)).toBe(text);
    });

    it("should correctly encode and decode multi-byte UTF-8 characters and emojis", () => {
      const complexText = "🔐 SpooVault 🚀 ~ Accents: café, naïve, español — Multilingual: 日本語, 中文, العربية, Русский — Special: 🌟✨⚡️🔥";
      const bytes = stringToUint8Array(complexText);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(complexText.length);

      const decoded = uint8ArrayToString(bytes);
      expect(decoded).toBe(complexText);
    });

    it("should handle empty string in String <-> Uint8Array conversion", () => {
      const empty = "";
      const bytes = stringToUint8Array(empty);
      expect(bytes.length).toBe(0);
      expect(uint8ArrayToString(bytes)).toBe(empty);
    });
  });

  describe("Direct UTF-8 Base64 Helpers", () => {
    it("should encode and decode UTF-8 string to Base64 without DOMException or character corruption", () => {
      const utf8Data = "Document with Emojis: 📄 🔑 🛡️ and Symbols: © ® ™ € £ ¥";
      const base64 = utf8ToBase64(utf8Data);
      expect(typeof base64).toBe("string");
      expect(base64.length).toBeGreaterThan(0);

      const decoded = base64ToUtf8(base64);
      expect(decoded).toBe(utf8Data);
    });
  });

  describe("Web Crypto ECIES (ECDH P-256 + AES-256-GCM) Key Management", () => {
    it("should generate valid ECDH P-256 CryptoKeyPair", async () => {
      const keyPair = await generateECIESKeyPair();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();
      expect(keyPair.publicKey.algorithm.name).toBe("ECDH");
      expect((keyPair.publicKey.algorithm as EcKeyGenParams).namedCurve).toBe("P-256");
    });

    it("should export and import public and private keys in Base64 format", async () => {
      const keyPair = await generateECIESKeyPair();
      const pubB64 = await exportECIESPublicKey(keyPair.publicKey);
      const privB64 = await exportECIESPrivateKey(keyPair.privateKey);

      expect(typeof pubB64).toBe("string");
      expect(typeof privB64).toBe("string");

      const importedPub = await importECIESPublicKey(pubB64);
      const importedPriv = await importECIESPrivateKey(privB64);

      expect(importedPub.algorithm.name).toBe("ECDH");
      expect(importedPriv.algorithm.name).toBe("ECDH");
    });

    it("should generate keypair directly with generateECIESKeyPairBase64 helper", async () => {
      const { publicKey, privateKey } = await generateECIESKeyPairBase64();
      expect(publicKey).toBeDefined();
      expect(privateKey).toBeDefined();
      expect(publicKey.length).toBeGreaterThan(0);
      expect(privateKey.length).toBeGreaterThan(0);

      const importedPub = await importECIESPublicKey(publicKey);
      expect(importedPub.type).toBe("public");
    });
  });

  describe("Web Crypto ECIES Encryption & Decryption", () => {
    it("should encrypt message with recipient public key in standardized ECIES payload format", async () => {
      const { publicKey } = await generateECIESKeyPairBase64();
      const message = "Guardian Key Share Payload #1";

      const encryptedJsonString = await encryptWithPublicKey(message, publicKey);
      const parsed = JSON.parse(encryptedJsonString);

      expect(parsed.version).toBe(ECIES_VERSION);
      expect(parsed.iv).toBeDefined();
      expect(parsed.ephemPublicKey).toBeDefined();
      expect(parsed.ciphertext).toBeDefined();
    });

    it("should encrypt and decrypt messages containing UTF-8 multi-byte characters and emojis", async () => {
      const receiver = await generateECIESKeyPairBase64();

      const secretDocument = JSON.stringify({
        title: "Confidential Payroll & Document 💼🔒",
        owner: "Alice 👩‍💻",
        notes: "Includes emojis 🚀🎉, accents éàü, and asian chars 繁體中文 / にほんご",
        secretKey: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      });

      const encryptedPayload = await encryptWithPublicKey(secretDocument, receiver.publicKey);
      const decrypted = await decryptWithPrivateKey(encryptedPayload, receiver.privateKey);

      expect(decrypted).toBe(secretDocument);
      expect(JSON.parse(decrypted)).toEqual(JSON.parse(secretDocument));
    });

    it("should accept parsed EncryptedPayload object in decryptWithPrivateKey", async () => {
      const receiver = await generateECIESKeyPairBase64();
      const secretText = "Testing object payload input 📦";

      const encryptedJsonString = await encryptWithPublicKey(secretText, receiver.publicKey);
      const payloadObj = JSON.parse(encryptedJsonString);

      const decrypted = await decryptWithPrivateKey(payloadObj, receiver.privateKey);
      expect(decrypted).toBe(secretText);
    });

    it("should fail decryption when using wrong private key", async () => {
      const receiver = await generateECIESKeyPairBase64();
      const wrongReceiver = await generateECIESKeyPairBase64();

      const encryptedPayload = await encryptWithPublicKey("Secret data", receiver.publicKey);

      await expect(
        decryptWithPrivateKey(encryptedPayload, wrongReceiver.privateKey)
      ).rejects.toThrow("Failed to decrypt ciphertext with provided private key");
    });

    it("should fail decryption when ciphertext has been tampered with", async () => {
      const receiver = await generateECIESKeyPairBase64();
      const encryptedJsonString = await encryptWithPublicKey("Original secret", receiver.publicKey);
      const payload = JSON.parse(encryptedJsonString);

      // Tamper ciphertext
      const cipherBytes = base64ToUint8Array(payload.ciphertext);
      cipherBytes[0] ^= 0xff;
      payload.ciphertext = uint8ArrayToBase64(cipherBytes);

      await expect(
        decryptWithPrivateKey(JSON.stringify(payload), receiver.privateKey)
      ).rejects.toThrow("Failed to decrypt ciphertext with provided private key");
    });

    it("should fail decryption when IV is missing or tampered", async () => {
      const receiver = await generateECIESKeyPairBase64();
      const encryptedJsonString = await encryptWithPublicKey("Original secret", receiver.publicKey);
      const payload = JSON.parse(encryptedJsonString);

      delete payload.iv;
      delete payload.nonce;

      await expect(
        decryptWithPrivateKey(JSON.stringify(payload), receiver.privateKey)
      ).rejects.toThrow("Missing IV in encrypted ECIES payload");
    });
  });

  describe("Legacy TweetNaCl (X25519) Backward Compatibility", () => {
    it("should seamlessly decrypt legacy x25519-xsalsa20-poly1305 payloads", async () => {
      const keypair = nacl.box.keyPair();
      const pubKeyB64 = uint8ArrayToBase64(keypair.publicKey);
      const secretKeyB64 = uint8ArrayToBase64(keypair.secretKey);

      // Create a legacy TweetNaCl payload
      const ephemeralKeypair = nacl.box.keyPair();
      const receiverPubKey = base64ToUint8Array(pubKeyB64);
      const message = "Legacy Shamir Share from MetaMask eth_decrypt era";
      const messageBytes = stringToUint8Array(message);
      const nonce = nacl.randomBytes(nacl.box.nonceLength);

      const ciphertext = nacl.box(
        messageBytes,
        nonce,
        receiverPubKey,
        ephemeralKeypair.secretKey
      );

      const legacyPayload = {
        version: LEGACY_X25519_VERSION,
        nonce: uint8ArrayToBase64(nonce),
        ephemPublicKey: uint8ArrayToBase64(ephemeralKeypair.publicKey),
        ciphertext: uint8ArrayToBase64(ciphertext),
      };

      const decrypted = await decryptWithPrivateKey(JSON.stringify(legacyPayload), secretKeyB64);
      expect(decrypted).toBe(message);
    });

    it("should throw error when decrypting legacy payload with wrong secret key", async () => {
      const keypair = nacl.box.keyPair();
      const wrongKeypair = nacl.box.keyPair();

      const pubKeyB64 = uint8ArrayToBase64(keypair.publicKey);
      const wrongSecretKeyB64 = uint8ArrayToBase64(wrongKeypair.secretKey);

      const ephemeralKeypair = nacl.box.keyPair();
      const receiverPubKey = base64ToUint8Array(pubKeyB64);
      const messageBytes = stringToUint8Array("Secret data");
      const nonce = nacl.randomBytes(nacl.box.nonceLength);

      const ciphertext = nacl.box(
        messageBytes,
        nonce,
        receiverPubKey,
        ephemeralKeypair.secretKey
      );

      const legacyPayload = {
        version: LEGACY_X25519_VERSION,
        nonce: uint8ArrayToBase64(nonce),
        ephemPublicKey: uint8ArrayToBase64(ephemeralKeypair.publicKey),
        ciphertext: uint8ArrayToBase64(ciphertext),
      };

      await expect(
        decryptWithPrivateKey(JSON.stringify(legacyPayload), wrongSecretKeyB64)
      ).rejects.toThrow("Failed to decrypt ciphertext with provided private key");
    });

    it("should throw error when payload version is unsupported", async () => {
      const receiver = await generateECIESKeyPairBase64();

      const invalidPayload = JSON.stringify({
        version: "unsupported-crypto-algorithm-v99",
        nonce: uint8ArrayToBase64(new Uint8Array(24)),
        ephemPublicKey: receiver.publicKey,
        ciphertext: uint8ArrayToBase64(new Uint8Array(32)),
      });

      await expect(
        decryptWithPrivateKey(invalidPayload, receiver.privateKey)
      ).rejects.toThrow("Unsupported encryption version: unsupported-crypto-algorithm-v99");
    });
  });
});
