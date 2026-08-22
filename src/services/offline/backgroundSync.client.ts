import { Workbox } from "workbox-window";
import {
  MSG_REPLAY_QUEUE,
  MSG_SYNC_STATUS,
} from "./syncConstants";
import { refreshQueueState } from "./offlineQueue.service";
import { onReplayEvent, replayPendingActions } from "./replay.service";
import { toast } from "react-hot-toast";

let initialized = false;
let replayDebounce: ReturnType<typeof setTimeout> | null = null;

const REPLAY_DEBOUNCE_MS = 1500;

export const scheduleReplay = (delayMs = REPLAY_DEBOUNCE_MS): void => {
  if (replayDebounce) {
    clearTimeout(replayDebounce);
  }
  replayDebounce = setTimeout(() => {
    replayDebounce = null;
    void replayPendingActions();
  }, delayMs);
};

const announceReplayOutcome = (): void => {
  const unsubscribe = onReplayEvent((event) => {
    if (event.type === "replay-complete") {
      unsubscribe();
      const { synced, failed, stoppedForOffline } = event.summary;
      if (stoppedForOffline && synced === 0 && failed === 0) return;
      if (synced > 0 && failed === 0) {
        toast.success(
          `Back online — ${synced} queued action${synced === 1 ? "" : "s"} synced.`
        );
      } else if (failed > 0) {
        toast.error(
          `Sync finished with ${failed} failed action${failed === 1 ? "" : "s"}. They stay queued for manual retry.`
        );
      }
    }
  });

  // Safety valve: stop listening if no completion event ever arrives.
  setTimeout(() => unsubscribe(), 5 * 60 * 1000);
};

/**
 * Wire the offline-first layer into the page:
 *  - register the Workbox service worker (production builds)
 *  - drain the queued actions when connectivity returns (`online` event or
 *    the service worker's background sync broadcast)
 *  - keep queue state fresh for the UI banner
 */
export const initOfflineLayer = (): void => {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  window.addEventListener("online", () => {
    void refreshQueueState();
    announceReplayOutcome();
    scheduleReplay();
  });

  window.addEventListener("offline", () => {
    void refreshQueueState();
  });

  // Drain anything queued during a previous offline session shortly after
  // the app becomes interactive.
  scheduleReplay(3000);

  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    try {
      // The SW bundle shares ESM chunks with the app, so it must be
      // registered as a module worker.
      const wb = new Workbox("/sw.js", { type: "module" });

      wb.addEventListener("message", (event) => {
        const data = event.data as { type?: string; supported?: boolean } | undefined;
        if (data?.type === MSG_REPLAY_QUEUE) {
          announceReplayOutcome();
          scheduleReplay(0);
        }
        if (data?.type === MSG_SYNC_STATUS) {
          void refreshQueueState();
        }
      });

      void wb.register().catch(() => {
        // SW registration is a progressive enhancement (e.g. unsupported in
        // insecure contexts); the `online` event path still works without it.
      });
    } catch {
      // never let SW setup break app boot
    }
  }
};
