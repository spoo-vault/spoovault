import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  OfflineQueuedError,
  isNetworkFailure,
  withOfflineFallback,
} from "../services/offline/offlineCache.service";
import {
  __setOfflineDbFactoryForTests,
  getCachedVaults,
  putVaults,
} from "../services/offline/db";

const ACCOUNT = "0xabc0000000000000000000000000000000000001";

const liveError = (message: string): Error => new Error(message);

describe("isNetworkFailure", () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  });

  it("treats a disconnected navigator as a network failure", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(isNetworkFailure(new Error("anything"))).toBe(true);
  });

  it("detects common connectivity error messages", () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(isNetworkFailure(new Error("Failed to fetch"))).toBe(true);
    expect(isNetworkFailure(new Error("network request failed"))).toBe(true);
    expect(isNetworkFailure(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe(true);
    expect(isNetworkFailure(new Error("Underlying network changed"))).toBe(true);
  });

  it("does not misclassify business errors", () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(isNetworkFailure(new Error("execution reverted: not guardian"))).toBe(false);
    expect(isNetworkFailure(new Error("Contract not initialized"))).toBe(false);
    expect(isNetworkFailure(null)).toBe(false);
  });
});

describe("withOfflineFallback", () => {
  beforeEach(() => {
    __setOfflineDbFactoryForTests(new IDBFactory(), IDBKeyRange);
  });

  afterEach(() => {
    __setOfflineDbFactoryForTests(null);
    vi.restoreAllMocks();
  });

  const vaultRow = (id: number) => ({
    id,
    creator: ACCOUNT,
    name: `Vault ${id}`,
    description: "d",
    guardians: [] as string[],
    approvalThreshold: 1,
    isActive: true,
    createdAt: 1700000000,
  });

  it("returns live data and mirrors it into the cache", async () => {
    const live = vi.fn().mockResolvedValue([vaultRow(1)]);
    const data = await withOfflineFallback({
      scope: "vaults:test",
      fetchLive: live,
      readCache: () => getCachedVaults(ACCOUNT, "avalanche"),
      writeCache: (vaults) =>
        putVaults(
          ACCOUNT,
          "avalanche",
          vaults.map((v) => ({ ...v }))
        ),
    });

    expect(data).toHaveLength(1);
    expect((await getCachedVaults(ACCOUNT, "avalanche")).map((v) => v.id)).toEqual([1]);
  });

  it("falls back to cached data when the network fails", async () => {
    await putVaults(ACCOUNT, "avalanche", [vaultRow(5)]);

    const data = await withOfflineFallback({
      scope: "vaults:test",
      fetchLive: async () => {
        throw liveError("Failed to fetch");
      },
      readCache: () => getCachedVaults(ACCOUNT, "avalanche"),
      writeCache: () => Promise.resolve(),
    });

    expect(data.map((v) => v.id)).toEqual([5]);
  });

  it("rethrows the original error when offline and no cache exists", async () => {
    await expect(
      withOfflineFallback({
        scope: "vaults:test",
        fetchLive: async () => {
          throw liveError("Failed to fetch");
        },
        readCache: () => getCachedVaults(ACCOUNT, "avalanche"),
        writeCache: () => Promise.resolve(),
      })
    ).rejects.toThrow("Failed to fetch");
  });

  it("rethrows non-network errors even when a cache exists", async () => {
    await putVaults(ACCOUNT, "avalanche", [vaultRow(5)]);

    await expect(
      withOfflineFallback({
        scope: "vaults:test",
        fetchLive: async () => {
          throw liveError("execution reverted: unauthorized");
        },
        readCache: () => getCachedVaults(ACCOUNT, "avalanche"),
        writeCache: () => Promise.resolve(),
      })
    ).rejects.toThrow("execution reverted: unauthorized");
  });

  it("still returns live data when the cache write fails", async () => {
    const writeCache = vi.fn().mockRejectedValue(new Error("quota exceeded"));
    const data = await withOfflineFallback({
      scope: "vaults:test",
      fetchLive: async () => [vaultRow(2)],
      readCache: () => getCachedVaults(ACCOUNT, "avalanche"),
      writeCache,
    });

    expect(data).toHaveLength(1);
  });
});

describe("OfflineQueuedError", () => {
  it("carries user-friendly messaging and identity", () => {
    const error = new OfflineQueuedError("document upload");
    expect(error.name).toBe("OfflineQueuedError");
    expect(error.queued).toBe(true);
    expect(error.message).toContain("offline");
    expect(error.message).toContain("document upload");
    expect(error.message).toContain("automatically");
  });
});
