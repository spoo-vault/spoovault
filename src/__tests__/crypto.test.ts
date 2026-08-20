import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import {
  base64ToUint8Array,
  uint8ArrayToBase64,
  stringToUint8Array,
  uint8ArrayToString,
  utf8ToBase64,
  base64ToUtf8,
  encryptWithPublicKey,
  decryptWithPrivateKey,
} from '../utils/crypto';

describe('TweetNaCl & Encoding Crypto Utilities', () => {
  describe('Base64 <-> Uint8Array conversions', () => {
    it('should convert Uint8Array to Base64 and back accurately', () => {
      const originalBytes = new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100]);
      const b64 = uint8ArrayToBase64(originalBytes);
      const resultBytes = base64ToUint8Array(b64);

      expect(resultBytes).toEqual(originalBytes);
    });

    it('should handle empty Uint8Array and empty Base64 string', () => {
      const emptyBytes = new Uint8Array(0);
      const b64 = uint8ArrayToBase64(emptyBytes);
      expect(b64).toBe('');
      const decoded = base64ToUint8Array(b64);
      expect(decoded).toEqual(emptyBytes);
    });

    it('should correctly parse URL-safe Base64 strings with - and _ and missing padding', () => {
      const bytes = new Uint8Array([251, 255, 254, 253, 252]);
      // Standard base64 might be "+//+/fw="
      // URL-safe base64 would be "-__-_fw" without padding
      const standardB64 = uint8ArrayToBase64(bytes);
      const urlSafeB64 = standardB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const decodedFromUrlSafe = base64ToUint8Array(urlSafeB64);
      expect(decodedFromUrlSafe).toEqual(bytes);
    });

    it('should ignore whitespace in Base64 strings', () => {
      const originalBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const b64 = uint8ArrayToBase64(originalBytes);
      const b64WithSpaces = `  ${b64.slice(0, 2)} \n ${b64.slice(2)}  \t `;
      const decoded = base64ToUint8Array(b64WithSpaces);
      expect(decoded).toEqual(originalBytes);
    });
  });

  describe('String <-> Uint8Array (UTF-8) conversions', () => {
    it('should convert ASCII String to Uint8Array and back', () => {
      const text = 'SpooVault Security';
      const bytes = stringToUint8Array(text);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBe(text.length);
      expect(uint8ArrayToString(bytes)).toBe(text);
    });

    it('should correctly encode and decode multi-byte UTF-8 characters and emojis', () => {
      const complexText = '🔐 SpooVault 🚀 ~ Accents: café, naïve, español — Multilingual: 日本語, 中文, العربية, Русский — Special: 🌟✨⚡️🔥';
      const bytes = stringToUint8Array(complexText);
      expect(bytes).toBeInstanceOf(Uint8Array);
      // Multi-byte UTF-8 string has more bytes than character length
      expect(bytes.length).toBeGreaterThan(complexText.length);

      const decoded = uint8ArrayToString(bytes);
      expect(decoded).toBe(complexText);
    });

    it('should handle empty string in String <-> Uint8Array conversion', () => {
      const empty = '';
      const bytes = stringToUint8Array(empty);
      expect(bytes.length).toBe(0);
      expect(uint8ArrayToString(bytes)).toBe(empty);
    });
  });

  describe('Direct UTF-8 Base64 Helpers', () => {
    it('should encode and decode UTF-8 string to Base64 without DOMException or character corruption', () => {
      const utf8Data = 'Document with Emojis: 📄 🔑 🛡️ and Symbols: © ® ™ € £ ¥';
      const base64 = utf8ToBase64(utf8Data);
      expect(typeof base64).toBe('string');
      expect(base64.length).toBeGreaterThan(0);

      const decoded = base64ToUtf8(base64);
      expect(decoded).toBe(utf8Data);
    });
  });

  describe('Asymmetric Encryption & Decryption (X25519-XSalsa20-Poly1305)', () => {
    it('should encrypt message with recipient public key in x25519 payload format', () => {
      const keypair = nacl.box.keyPair();
      const pubKeyB64 = uint8ArrayToBase64(keypair.publicKey);

      const message = 'Guardian Key Share Payload';
      const encryptedJsonString = encryptWithPublicKey(message, pubKeyB64);
      const parsed = JSON.parse(encryptedJsonString);

      expect(parsed.version).toBe('x25519-xsalsa20-poly1305');
      expect(parsed.nonce).toBeDefined();
      expect(parsed.ephemPublicKey).toBeDefined();
      expect(parsed.ciphertext).toBeDefined();
    });

    it('should encrypt and decrypt messages containing UTF-8 multi-byte characters and emojis', () => {
      const receiverKeypair = nacl.box.keyPair();
      const receiverPubKeyB64 = uint8ArrayToBase64(receiverKeypair.publicKey);
      const receiverSecretKeyB64 = uint8ArrayToBase64(receiverKeypair.secretKey);

      const secretDocument = JSON.stringify({
        title: 'Confidential Payroll & Document 💼🔒',
        owner: 'Alice 👩‍💻',
        notes: 'Includes emojis 🚀🎉, accents éàü, and asian chars 繁體中文 / にほんご',
        secretKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      });

      const encryptedPayload = encryptWithPublicKey(secretDocument, receiverPubKeyB64);
      const decrypted = decryptWithPrivateKey(encryptedPayload, receiverSecretKeyB64);

      expect(decrypted).toBe(secretDocument);
      expect(JSON.parse(decrypted)).toEqual(JSON.parse(secretDocument));
    });

    it('should accept parsed EncryptedPayload object in decryptWithPrivateKey', () => {
      const receiverKeypair = nacl.box.keyPair();
      const receiverPubKeyB64 = uint8ArrayToBase64(receiverKeypair.publicKey);
      const receiverSecretKeyB64 = uint8ArrayToBase64(receiverKeypair.secretKey);

      const secretText = 'Testing object payload input 📦';
      const encryptedJsonString = encryptWithPublicKey(secretText, receiverPubKeyB64);
      const payloadObj = JSON.parse(encryptedJsonString);

      const decrypted = decryptWithPrivateKey(payloadObj, receiverSecretKeyB64);
      expect(decrypted).toBe(secretText);
    });

    it('should throw error when decrypting with wrong secret key', () => {
      const receiverKeypair = nacl.box.keyPair();
      const wrongKeypair = nacl.box.keyPair();

      const receiverPubKeyB64 = uint8ArrayToBase64(receiverKeypair.publicKey);
      const wrongSecretKeyB64 = uint8ArrayToBase64(wrongKeypair.secretKey);

      const encryptedPayload = encryptWithPublicKey('Secret data', receiverPubKeyB64);

      expect(() => {
        decryptWithPrivateKey(encryptedPayload, wrongSecretKeyB64);
      }).toThrow('Failed to decrypt ciphertext with provided private key');
    });

    it('should throw error when payload version is unsupported', () => {
      const keypair = nacl.box.keyPair();
      const secretKeyB64 = uint8ArrayToBase64(keypair.secretKey);

      const invalidPayload = JSON.stringify({
        version: 'unsupported-crypto-algorithm-v2',
        nonce: uint8ArrayToBase64(new Uint8Array(24)),
        ephemPublicKey: uint8ArrayToBase64(new Uint8Array(32)),
        ciphertext: uint8ArrayToBase64(new Uint8Array(32)),
      });

      expect(() => {
        decryptWithPrivateKey(invalidPayload, secretKeyB64);
      }).toThrow('Unsupported encryption version: unsupported-crypto-algorithm-v2');
    });
  });
});
