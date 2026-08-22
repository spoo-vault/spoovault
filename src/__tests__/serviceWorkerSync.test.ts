import { describe, expect, it, vi } from "vitest";
import {
  broadcastReplayRequest,
  createSyncEventHandler,
  handleClientMessage,
  type ClientLike,
  type ClientsLike,
  type SyncEventLike,
} from "../services/offline/swSyncBridge";
import {
  MSG_REPLAY_QUEUE,
  MSG_REGISTER_SYNC,
  MSG_SYNC_STATUS,
  SYNC_TAG,
} from "../services/offline/syncConstants";

const makeClients = (clients: ClientLike[]): ClientsLike => ({
  matchAll: vi.fn().mockResolvedValue(clients),
});

const makeSyncEvent = (tag: string): { event: SyncEventLike; waitUntilCalls: Promise<unknown>[] } => {
  const waitUntilCalls: Promise<unknown>[] = [];
  return {
    event: {
      tag,
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilCalls.push(promise);
      },
    },
    waitUntilCalls,
  };
};

describe("service worker background sync bridge", () => {
  it("uses the canonical background sync tag", () => {
    expect(SYNC_TAG).toBe("spoovault-action-sync");
  });

  it("broadcasts a replay request to every open client on the sync event", async () => {
    const postMessageA = vi.fn();
    const postMessageB = vi.fn();
    const clients = makeClients([
      { postMessage: postMessageA },
      { postMessage: postMessageB },
    ]);

    const handler = createSyncEventHandler(clients);
    const { event, waitUntilCalls } = makeSyncEvent(SYNC_TAG);

    handler(event);
    expect(waitUntilCalls).toHaveLength(1);

    await Promise.all(waitUntilCalls);

    expect(postMessageA).toHaveBeenCalledWith({ type: MSG_REPLAY_QUEUE });
    expect(postMessageB).toHaveBeenCalledWith({ type: MSG_REPLAY_QUEUE });
  });

  it("ignores sync events for foreign tags", () => {
    const postMessage = vi.fn();
    const clients = makeClients([{ postMessage }]);

    const handler = createSyncEventHandler(clients);
    const { event, waitUntilCalls } = makeSyncEvent("some-other-queue");

    handler(event);

    expect(waitUntilCalls).toHaveLength(0);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("reports the number of notified clients", async () => {
    const count = await broadcastReplayRequest(
      makeClients([{ postMessage: vi.fn() }, { postMessage: vi.fn() }, { postMessage: vi.fn() }])
    );
    expect(count).toBe(3);
  });

  it("survives matchAll failures while replaying", async () => {
    const clients: ClientsLike = {
      matchAll: vi.fn().mockRejectedValue(new Error("no clients")),
    };
    expect(await broadcastReplayRequest(clients)).toBe(0);
  });

  it("registers the background sync tag when a client queues an action", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn();

    await handleClientMessage(
      { type: MSG_REGISTER_SYNC },
      { sync: { register } },
      reply
    );

    expect(register).toHaveBeenCalledWith(SYNC_TAG);
    expect(reply).toHaveBeenCalledWith({ type: MSG_SYNC_STATUS, supported: true });
  });

  it("reports unsupported when the browser lacks background sync", async () => {
    const reply = vi.fn();

    await handleClientMessage({ type: MSG_REGISTER_SYNC }, {}, reply);

    expect(reply).toHaveBeenCalledWith({ type: MSG_SYNC_STATUS, supported: false });
  });

  it("ignores unrelated messages", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn();

    await handleClientMessage({ type: "unrelated" }, { sync: { register } }, reply);
    await handleClientMessage(null, { sync: { register } }, reply);

    expect(register).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});
