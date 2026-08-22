import {
  MSG_REPLAY_QUEUE,
  MSG_REGISTER_SYNC,
  MSG_SYNC_STATUS,
  SYNC_TAG,
} from "./syncConstants";

/**
 * Framework-free bridge between the Workbox service worker and the offline
 * action queue. Everything here is intentionally pure and dependency-light so
 * the same code can run inside the service worker bundle and in unit tests.
 */

export interface SyncEventLike {
  tag: string;
  waitUntil: (promise: Promise<unknown>) => void;
}

export interface ClientLike {
  postMessage: (message: unknown) => void;
}

export interface ClientsLike {
  matchAll: (options?: {
    type?: string;
    includeUncontrolled?: boolean;
  }) => Promise<ClientLike[]>;
}

export interface SyncRegistrationLike {
  register: (tag: string) => Promise<void>;
}

export interface WorkerRegistrationLike {
  sync?: SyncRegistrationLike;
}

/**
 * Notify every open app window that queued actions should be replayed against
 * the blockchain contracts. Returns the number of clients notified.
 */
export const broadcastReplayRequest = async (
  clients: ClientsLike
): Promise<number> => {
  let targets: ClientLike[] = [];
  try {
    targets = await clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
  } catch {
    return 0;
  }

  targets.forEach((client) => {
    try {
      client.postMessage({ type: MSG_REPLAY_QUEUE });
    } catch {
      // a client may have closed between matchAll and postMessage
    }
  });
  return targets.length;
};

/**
 * Build the `sync` event handler installed by the service worker. When the
 * browser fires the background sync event for our tag (i.e. connectivity was
 * restored after actions were queued), wake every client so it can drain the
 * Dexie-backed queue through contractService.
 */
export const createSyncEventHandler = (
  clients: ClientsLike,
  options?: { onReplayBroadcast?: (clientCount: number) => void }
) => {
  return (event: SyncEventLike): void => {
    if (event.tag !== SYNC_TAG) return;

    event.waitUntil(
      broadcastReplayRequest(clients).then((count) => {
        options?.onReplayBroadcast?.(count);
      })
    );
  };
};

/**
 * Handle messages posted from app windows. The primary use case is a client
 * asking the service worker to (re-)register the background sync tag right
 * after an action was queued while offline — this keeps the sync registration
 * alive even if the page is closed before connectivity returns.
 */
export const handleClientMessage = async (
  data: unknown,
  registration: WorkerRegistrationLike,
  reply?: (message: { type: string; supported?: boolean }) => void
): Promise<void> => {
  if (!data || typeof data !== "object") return;
  const message = data as { type?: string };
  if (message.type !== MSG_REGISTER_SYNC) return;

  let supported = false;
  if (registration?.sync) {
    try {
      await registration.sync.register(SYNC_TAG);
      supported = true;
    } catch {
      supported = false;
    }
  }

  reply?.({ type: MSG_SYNC_STATUS, supported });
};
