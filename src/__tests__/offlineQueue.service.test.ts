import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  __setOfflineDbFactoryForTests,
  countActionsByStatus,
  listActionsByStatus,
} from "../services/offline/db";
import {
  enqueueAction,
  getFailedActions,
  getQueuedActions,
  registerBackgroundSync,
  setActionStatus,
  subscribeToQueue,
} from "../services/offline/offlineQueue.service";
import { SYNC_TAG } from "../services/offline/syncConstants";

describe("offline queue", () => {
  beforeEach(() => {
    __setOfflineDbFactoryForTests(new IDBFactory(), IDBKeyRange);
    vi.stubGlobal("navigator", { onLine: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __setOfflineDbFactoryForTests(null);
  });

  it("persists queued actions with defaults and notifies subscribers", async () => {
    const states: number[] = [];
    const unsubscribe = subscribeToQueue((state) => states.push(state.pending));

    const record = await enqueueAction("register-public-key", { publicKey: "pk-1" }, { label: "key registration" });

    expect(record.id).toBeDefined();
    expect(record.kind).toBe("register-public-key");
    expect(record.status).toBe("pending");
    expect(record.label).toBe("key registration");
    expect(record.network).toBe("avalanche");

    const queued = await getQueuedActions();
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toEqual({ publicKey: "pk-1" });

    // subscriber fires on initial subscribe + after the enqueue
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states[states.length - 1]).toBe(1);
    unsubscribe();
  });

  it("registers a background sync tag with the service worker", async () => {
    const syncRegister = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.fn();
    vi.stubGlobal("navigator", {
      onLine: true,
      serviceWorker: {
        ready: Promise.resolve({
          sync: { register: syncRegister },
          active: { postMessage },
        }),
      },
    });

    const supported = await registerBackgroundSync();

    expect(supported).toBe(true);
    expect(syncRegister).toHaveBeenCalledWith(SYNC_TAG);
    expect(postMessage).toHaveBeenCalledWith({ type: "spoovault/register-sync" });
  });

  it("resolves false when service workers or background sync are unavailable", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(await registerBackgroundSync()).toBe(false);

    vi.stubGlobal("navigator", {
      onLine: true,
      serviceWorker: {
        ready: Promise.resolve({}),
      },
    });
    expect(await registerBackgroundSync()).toBe(false);
  });

  it("separates pending and failed actions", async () => {
    const ok = await enqueueAction("request-access", { documentId: 1 });
    const bad = await enqueueAction("request-access", { documentId: 2 });

    await setActionStatus(ok.id!, "synced");
    await setActionStatus(bad.id!, "failed", { error: new Error("reverted") });

    expect(await getQueuedActions()).toHaveLength(0);
    const failed = await getFailedActions();
    expect(failed).toHaveLength(1);
    expect(failed[0].lastError).toBe("reverted");
    expect(failed[0].attempts).toBe(0);
  });

  it("tracks attempt counts through status transitions", async () => {
    const record = await enqueueAction("create-vault", {
      name: "V",
      description: "",
      guardians: [],
      approvalThreshold: 1,
    });

    await setActionStatus(record.id!, "processing");
    await setActionStatus(record.id!, "pending", { attempts: 1 });

    const rows = await listActionsByStatus(["pending"]);
    expect(rows[0].attempts).toBe(1);
    expect((await countActionsByStatus()).pending).toBe(1);
  });
});
