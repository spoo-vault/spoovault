import type { Argon2WorkerRequest, Argon2WorkerResponse } from "../workers/argon2.worker.ts";

/**
 * Memory-hard Argon2id derivation parameters (issue #74).
 * M=64MB, t=3 passes, p=4 parallelism -- per the OWASP-recommended baseline
 * for interactive, client-side password hashing.
 */
export const ARGON2ID_DEFAULTS = {
  memorySize: 65536, // KiB (64 MiB)
  iterations: 3,
  parallelism: 4,
  hashLength: 32, // bytes -> AES-256 key material
} as const;

export interface Argon2idParams {
  memorySize: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
}

class Argon2WorkerService {
  private worker: Worker | null = null;
  private pendingRequests: Map<
    string,
    { resolve: (val: Uint8Array) => void; reject: (err: Error) => void }
  > = new Map();

  constructor() {
    this.initWorker();
  }

  private initWorker() {
    if (typeof window !== "undefined" && typeof Worker !== "undefined") {
      try {
        const worker = new Worker(new URL("../workers/argon2.worker.ts", import.meta.url), {
          type: "module",
        });

        worker.onmessage = (event: MessageEvent<Argon2WorkerResponse>) => {
          const response = event.data;
          const promiseCallbacks = this.pendingRequests.get(response.id);
          if (!promiseCallbacks) return;

          this.pendingRequests.delete(response.id);

          if (response.type === "ERROR") {
            promiseCallbacks.reject(new Error(response.error || "Argon2id worker operation failed"));
          } else if (response.type === "DERIVE_KEY_SUCCESS") {
            promiseCallbacks.resolve(response.result);
          } else {
            promiseCallbacks.reject(new Error("Unknown argon2 worker response type"));
          }
        };

        worker.onerror = (err) => {
          console.error("Argon2 worker error event:", err);
        };

        this.worker = worker;
      } catch (e) {
        console.warn("Argon2 Web Worker initialization failed:", e);
        this.worker = null;
      }
    }
  }

  /**
   * Derive `hashLength` bytes of key material from a passphrase using
   * Argon2id, off the main thread when a Web Worker is available. Falls
   * back to running Argon2id inline (e.g. in Node test runners, or when
   * Web Workers are unsupported) so callers never need to branch on
   * environment support themselves.
   */
  public async deriveKeyBytesAsync(
    password: string,
    salt: Uint8Array,
    params: Argon2idParams = ARGON2ID_DEFAULTS
  ): Promise<Uint8Array> {
    if (!this.worker) {
      const { argon2id } = await import("hash-wasm");
      return argon2id({
        password,
        salt,
        memorySize: params.memorySize,
        iterations: params.iterations,
        parallelism: params.parallelism,
        hashLength: params.hashLength,
        outputType: "binary",
      });
    }

    const requestId = this.generateId();
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      const request: Argon2WorkerRequest = {
        id: requestId,
        type: "DERIVE_KEY",
        payload: {
          password,
          salt,
          memorySize: params.memorySize,
          iterations: params.iterations,
          parallelism: params.parallelism,
          hashLength: params.hashLength,
        },
      };
      this.worker!.postMessage(request);
    });
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
  }

  public terminate() {
    this.worker?.terminate();
    this.worker = null;
  }
}

export const argon2WorkerService = new Argon2WorkerService();
