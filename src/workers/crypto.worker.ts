import CryptoJS from "crypto-js";
import { decryptWithPrivateKey, encryptWithPublicKey } from "../utils/crypto";

export interface CryptoWorkerRequest {
  id: string;
  type: "ENCRYPT" | "DECRYPT" | "REENCRYPT_ENVELOPE";
  payload: {
    data: string;
    key: string;
    /**
     * Only used by REENCRYPT_ENVELOPE: decrypts `data` (an encrypted share
     * envelope) with this Base64 private key, then re-encrypts the plaintext
     * to `newPublicKey`.
     */
    oldPrivateKey?: string;
    newPublicKey?: string;
  };
}

export interface CryptoWorkerResponse {
  id: string;
  type: "ENCRYPT_SUCCESS" | "DECRYPT_SUCCESS" | "REENCRYPT_SUCCESS" | "ERROR";
  result?: string;
  error?: string;
}

self.onmessage = async (event: MessageEvent<CryptoWorkerRequest>) => {
  const { id, type, payload } = event.data;

  try {
    if (type === "ENCRYPT") {
      const encrypted = CryptoJS.AES.encrypt(payload.data, payload.key).toString();
      const response: CryptoWorkerResponse = {
        id,
        type: "ENCRYPT_SUCCESS",
        result: encrypted,
      };
      self.postMessage(response);
    } else if (type === "DECRYPT") {
      let decrypted = "";
      try {
        const bytes = CryptoJS.AES.decrypt(payload.data, payload.key);
        decrypted = bytes.toString(CryptoJS.enc.Utf8);
      } catch {
        decrypted = "";
      }
      const response: CryptoWorkerResponse = {
        id,
        type: "DECRYPT_SUCCESS",
        result: decrypted,
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
      throw new Error(`Unsupported worker operation type: ${type}`);
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
