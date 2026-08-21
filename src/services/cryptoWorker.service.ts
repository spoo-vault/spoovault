import CryptoJS from "crypto-js";
import { CryptoWorkerRequest, CryptoWorkerResponse } from "../workers/crypto.worker";
import { decryptWithPrivateKey, encryptWithPublicKey } from "../utils/crypto";

class CryptoWorkerService {
  private worker: Worker | null = null;
  private pendingRequests: Map<
    string,
    { resolve: (val: string) => void; reject: (err: Error) => void }
  > = new Map();

  constructor() {
    this.initWorker();
  }

  private initWorker() {
    if (typeof window !== "undefined" && typeof Worker !== "undefined") {
      try {
        this.worker = new Worker(
          new URL("../workers/crypto.worker.ts", import.meta.url),
          { type: "module" }
        );

        this.worker.onmessage = (event: MessageEvent<CryptoWorkerResponse>) => {
          const { id, type, result, error } = event.data;
          const promiseCallbacks = this.pendingRequests.get(id);

          if (!promiseCallbacks) return;

          this.pendingRequests.delete(id);

          if (type === "ERROR" || error) {
            promiseCallbacks.reject(new Error(error || "Worker encryption failed"));
          } else if (result !== undefined) {
            promiseCallbacks.resolve(result);
          } else {
            promiseCallbacks.reject(new Error("Empty worker response result"));
          }
        };

        this.worker.onerror = (err) => {
          console.error("Crypto worker error event:", err);
        };
      } catch (e) {
        console.warn("Web Worker initialization failed, falling back to main-thread crypto:", e);
        this.worker = null;
      }
    }
  }

  /**
   * Encrypt payload asynchronously using Web Worker (with main-thread fallback)
   */
  public async encryptAsync(data: string, key: string): Promise<string> {
    if (!this.worker) {
      // Fallback for environments where Web Worker is unavailable
      return CryptoJS.AES.encrypt(data, key).toString();
    }

    const requestId = this.generateId();
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      const request: CryptoWorkerRequest = {
        id: requestId,
        type: "ENCRYPT",
        payload: { data, key },
      };
      this.worker!.postMessage(request);
    });
  }

  /**
   * Decrypt payload asynchronously using Web Worker (with main-thread fallback)
   */
  public async decryptAsync(encryptedData: string, key: string): Promise<string> {
    if (!this.worker) {
      // Fallback for environments where Web Worker is unavailable
      try {
        const bytes = CryptoJS.AES.decrypt(encryptedData, key);
        return bytes.toString(CryptoJS.enc.Utf8);
      } catch {
        return "";
      }
    }

    const requestId = this.generateId();
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      const request: CryptoWorkerRequest = {
        id: requestId,
        type: "DECRYPT",
        payload: { data: encryptedData, key },
      };
      this.worker!.postMessage(request);
    });
  }

  /**
   * Re-encrypt a share envelope from an old (e.g. compromised) key to a new
   * public key asynchronously using Web Worker (with main-thread fallback).
   * Used by the key rotation protocol (issue #156).
   */
  public async reencryptEnvelopeAsync(
    envelope: string,
    oldPrivateKey: string,
    newPublicKey: string
  ): Promise<string> {
    if (!this.worker) {
      // Fallback for environments where Web Worker is unavailable
      const plaintext = await decryptWithPrivateKey(envelope, oldPrivateKey);
      return encryptWithPublicKey(plaintext, newPublicKey);
    }

    const requestId = this.generateId();
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      const request: CryptoWorkerRequest = {
        id: requestId,
        type: "REENCRYPT_ENVELOPE",
        payload: { data: envelope, key: "", oldPrivateKey, newPublicKey },
      };
      this.worker!.postMessage(request);
    });
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
  }

  public terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

export const cryptoWorkerService = new CryptoWorkerService();
