/// <reference lib="webworker" />

import { splitSecretVSS } from "../services/secrets.service";
import { decryptWithPrivateKey, encryptWithPublicKey } from "../utils/crypto";

export type CryptoWorkerRequest =
  | {
      id: string;
      type: "ENCRYPT" | "DECRYPT";
      payload: {
        data: ArrayBuffer;
        key: string; // 64-char hex string
      };
    }
  | {
      id: string;
      type: "SPLIT_SECRET";
      payload: {
        secretHex: string;
        n: number;
        k: number;
      };
    }
  | {
      id: string;
      type: "REENCRYPT_ENVELOPE";
      payload: {
        data: string;
        key: string;
        oldPrivateKey?: string;
        newPublicKey?: string;
      };
    };

export type CryptoWorkerResponse =
  | {
      id: string;
      type: "ENCRYPT_SUCCESS" | "DECRYPT_SUCCESS";
      result: ArrayBuffer;
    }
  | {
      id: string;
      type: "SPLIT_SECRET_SUCCESS";
      shares: string[];
      commitments: string[];
    }
  | {
      id: string;
      type: "REENCRYPT_SUCCESS";
      result: string;
    }
  | {
      id: string;
      type: "ERROR";
      error: string;
    };

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function importKey(hexKey: string): Promise<CryptoKey> {
  const keyBytes = hexToBytes(hexKey);
  return await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

self.onmessage = async (event: MessageEvent<CryptoWorkerRequest>) => {
  const { id, type, payload } = event.data;

  try {
    if (type === "ENCRYPT") {
      const cryptoKey = await importKey(payload.key);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        payload.data
      );

      // Prepend IV to ciphertext
      const resultBuffer = new Uint8Array(iv.length + ciphertext.byteLength);
      resultBuffer.set(iv, 0);
      resultBuffer.set(new Uint8Array(ciphertext), iv.length);

      const response: CryptoWorkerResponse = {
        id,
        type: "ENCRYPT_SUCCESS",
        result: resultBuffer.buffer,
      };
      (self as any).postMessage(response, [response.result]);
    } else if (type === "DECRYPT") {
      const cryptoKey = await importKey(payload.key);
      const dataBytes = new Uint8Array(payload.data);
      
      const iv = dataBytes.slice(0, 12);
      const ciphertext = dataBytes.slice(12);

      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        ciphertext
      );

      const response: CryptoWorkerResponse = {
        id,
        type: "DECRYPT_SUCCESS",
        result: decrypted,
      };
      (self as any).postMessage(response, [response.result]);
    } else if (type === "SPLIT_SECRET") {
      const { secretHex, n, k } = payload;
      const { shares, commitments } = splitSecretVSS(secretHex, n, k);
      const response: CryptoWorkerResponse = {
        id,
        type: "SPLIT_SECRET_SUCCESS",
        shares,
        commitments,
      };
      self.postMessage(response);
    } else if (type === "REENCRYPT_ENVELOPE") {
      const { oldPrivateKey, newPublicKey } = payload;
      if (!oldPrivateKey || !newPublicKey) {
        throw new Error("REENCRYPT_ENVELOPE requires oldPrivateKey and newPublicKey");
      }
      const plaintext = await decryptWithPrivateKey(payload.data, oldPrivateKey);
      const reencrypted = await encryptWithPublicKey(plaintext, newPublicKey);
      const response: CryptoWorkerResponse = {
        id,
        type: "REENCRYPT_SUCCESS",
        result: reencrypted,
      };
      self.postMessage(response);
    } else {
      throw new Error(`Unsupported worker operation type: ${(payload as any)?.type}`);
    }
  } catch (err: any) {
    const errorResponse: CryptoWorkerResponse = {
      id,
      type: "ERROR",
      error: err?.message || "Crypto worker execution error",
    };
    self.postMessage(errorResponse);
  }

  
};

self.onmessage = async (event: MessageEvent<{ type: string; buffer: ArrayBuffer }>) => {
  const { type, buffer } = event.data;

  if (type === 'COMPUTE_HASH') {
    try {
      // Process buffer directly without memory duplication
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);

      // Return resulting ArrayBuffer back to main thread via zero-copy transfer
      (self as any).postMessage(
        { status: 'SUCCESS', hash: hashBuffer },
        [hashBuffer]
      );
    } catch (error: any) {
      (self as any).postMessage({ status: 'ERROR', message: error.message });
    }
  }
};