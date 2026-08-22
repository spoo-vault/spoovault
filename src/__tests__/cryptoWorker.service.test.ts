import { describe, it, expect } from "vitest";
import { cryptoWorkerService } from "../services/cryptoWorker.service";

describe("CryptoWorkerService (Web Worker Engine)", () => {
  it("should encrypt and decrypt data asynchronously using cryptoWorkerService", async () => {
    const payload = "Confidential Vault Document Content 2026";
    const secretKey = "vault-worker-encryption-key-9988";

    const encrypted = await cryptoWorkerService.encryptAsync(
      payload,
      secretKey
    );
    expect(encrypted).toBeDefined();
    expect(encrypted).not.toBe(payload);

    const decrypted = await cryptoWorkerService.decryptAsync(
      encrypted,
      secretKey
    );
    expect(decrypted).toBe(payload);
  });

  it("should return empty string when decrypting with incorrect secret key", async () => {
    const payload = "Secret Data";
    const key = "correct-key";
    const wrongKey = "wrong-key";

    const encrypted = await cryptoWorkerService.encryptAsync(payload, key);
    const decrypted = await cryptoWorkerService.decryptAsync(
      encrypted,
      wrongKey
    );
    expect(decrypted).toBe("");
  });
});
