import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CryptoClientService } from '../services/crypto-client';

class MockWorker {
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  postMessage(_message: any, transfer?: Transferable[]) {
    if (transfer?.length) {
      structuredClone(_message, { transfer });
    }
    setTimeout(() => {
      if (this.onmessage) {
        this.onmessage({ data: { status: 'SUCCESS', hash: new ArrayBuffer(32) } });
      }
    }, 0);
  }
  terminate() {}
}

if (typeof globalThis.Worker === 'undefined') {
  (globalThis as any).Worker = MockWorker;
}

describe('CryptoWorker Zero-Copy Transfer (#42)', () => {
  const originalWorker = globalThis.Worker;

  beforeAll(() => {
    if (typeof globalThis.Worker === 'undefined') {
      globalThis.Worker = class MockWorker {
        onmessage: ((e: any) => void) | null = null;
        onerror: ((e: any) => void) | null = null;

        postMessage(_msg: any, transfer?: Transferable[]) {
          if (transfer) {
            for (const item of transfer) {
              if (item instanceof ArrayBuffer) {
                try {
                  (item as any).transfer?.();
                } catch {
                  Object.defineProperty(item, 'byteLength', { value: 0, configurable: true });
                }
              }
            }
          }
          queueMicrotask(() => {
            if (this.onmessage) {
              this.onmessage({ data: { status: 'success', hash: new ArrayBuffer(32) } });
            }
          });
        }

        terminate() {
          if (this.onerror) {
            this.onerror(new Error('Worker terminated'));
          }
        }
      } as any;
    }
  });

  afterAll(() => {
    globalThis.Worker = originalWorker;
  });

  it('detaches ArrayBuffer ownership upon postMessage invocation', async () => {
    const client = new CryptoClientService();
    const buffer = new ArrayBuffer(1024 * 1024); // 1 MB payload

    expect(buffer.byteLength).toBe(1024 * 1024);

    const promise = client.computeHash(buffer);

    // Verify zero-copy detachment: sender side buffer byteLength becomes 0 after transfer
    expect(buffer.byteLength).toBe(0);

    client.terminate();
    try {
      await promise;
    } catch {
      // Ignored on terminated worker
    }
  });
});