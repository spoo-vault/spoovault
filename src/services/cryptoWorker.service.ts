import { CryptoWorkerRequest, CryptoWorkerResponse } from "../workers/crypto.worker";

class CryptoWorkerService {
  private workers: Worker[] = [];
  private nextWorkerIndex = 0;
  private pendingRequests: Map<
    string,
    { resolve: (val: any) => void; reject: (err: Error) => void }
  > = new Map();

  constructor() {
    this.initWorkers();
  }

  private initWorkers() {
    if (typeof window !== "undefined" && typeof Worker !== "undefined") {
      try {
        const poolSize = navigator.hardwareConcurrency || 4;
        
        for (let i = 0; i < poolSize; i++) {
          const worker = new Worker(
            new URL("../workers/crypto.worker.ts", import.meta.url),
            { type: "module" }
          );

          worker.onmessage = (event: MessageEvent<CryptoWorkerResponse>) => {
            const response = event.data;
            const promiseCallbacks = this.pendingRequests.get(response.id);

            if (!promiseCallbacks) return;

            this.pendingRequests.delete(response.id);

            if (response.type === "ERROR") {
              promiseCallbacks.reject(new Error(response.error || "Worker operation failed"));
            } else if (response.type === "ENCRYPT_SUCCESS" || response.type === "DECRYPT_SUCCESS") {
              promiseCallbacks.resolve(response.result);
            } else if (response.type === "SPLIT_SECRET_SUCCESS") {
              promiseCallbacks.resolve({
                shares: response.shares,
                commitments: response.commitments,
              });
            } else {
              promiseCallbacks.reject(new Error("Unknown worker response type"));
            }
          };

          worker.onerror = (err) => {
            console.error(`Crypto worker ${i} error event:`, err);
          };

          this.workers.push(worker);
        }
      } catch (e) {
        console.warn("Web Worker pool initialization failed:", e);
        this.workers = [];
      }
    }
  }

  private getNextWorker(): Worker | null {
    if (this.workers.length === 0) return null;
    const worker = this.workers[this.nextWorkerIndex];
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
    return worker;
  }

  private hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  private async importKey(hexKey: string): Promise<CryptoKey> {
    const keyBytes = this.hexToBytes(hexKey);
    return await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  }

  /**
   * Encrypt payload asynchronously using Web Worker Pool (with main-thread fallback)
   */
  public async encryptAsync(data: ArrayBuffer, key: string): Promise<ArrayBuffer> {
    const worker = this.getNextWorker();
    
    if (!worker) {
      // Fallback for environments where Web Worker is unavailable
      const cryptoKey = await this.importKey(key);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        data
      );
      const resultBuffer = new Uint8Array(iv.length + ciphertext.byteLength);
      resultBuffer.set(iv, 0);
      resultBuffer.set(new Uint8Array(ciphertext), iv.length);
      return resultBuffer.buffer;
    }

    const requestId = this.generateId();
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      const request: CryptoWorkerRequest = {
        id: requestId,
        type: "ENCRYPT",
        payload: { data, key },
      };
      worker.postMessage(request, [data]);
    });
  }

  /**
   * Decrypt payload asynchronously using Web Worker Pool (with main-thread fallback)
   */
  public async decryptAsync(encryptedData: ArrayBuffer, key: string): Promise<ArrayBuffer> {
    const worker = this.getNextWorker();

    if (!worker) {
      // Fallback for environments where Web Worker is unavailable
      const cryptoKey = await this.importKey(key);
      const dataBytes = new Uint8Array(encryptedData);
      const iv = dataBytes.slice(0, 12);
      const ciphertext = dataBytes.slice(12);
      return await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        ciphertext
      );
    }

    const requestId = this.generateId();
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      const request: CryptoWorkerRequest = {
        id: requestId,
        type: "DECRYPT",
        payload: { data: encryptedData, key },
      };
      worker.postMessage(request, [encryptedData]);
    });
  }

  /**
   * Split a secret into shares using Shamir Secret Sharing via Web Worker Pool
   */
  public async splitSecretVSSAsync(secretHex: string, n: number, k: number): Promise<{ shares: string[]; commitments: string[] }> {
    const worker = this.getNextWorker();

    if (!worker) {
      // Fallback: dynamic import to avoid blocking main thread initialization
      const { splitSecretVSS } = await import("./secrets.service");
      return splitSecretVSS(secretHex, n, k);
    }

    const requestId = this.generateId();
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      const request: CryptoWorkerRequest = {
        id: requestId,
        type: "SPLIT_SECRET",
        payload: { secretHex, n, k },
      };
      worker.postMessage(request);
    });
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
  }

  public terminate() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
  }
}

export const cryptoWorkerService = new CryptoWorkerService();
