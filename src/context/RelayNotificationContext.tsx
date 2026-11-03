import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import * as hotToast from "react-hot-toast";
import {
  MAX_SIMULTANEOUS_TOASTS,
  NOTIFICATION_HISTORY_STORAGE_KEY,
  NOTIFICATION_SOUND_STORAGE_KEY,
  notifyCenter,
  useRelayNotificationStore,
  type RelayNotificationStoreState,
} from "../services/relayNotification.service";
import { onReplayEvent } from "../services/offline/replay.service";

const RelayNotificationContext =
  createContext<RelayNotificationStoreState | null>(null);

const ToastStackLimiter = ({
  maxToasts = MAX_SIMULTANEOUS_TOASTS,
}: {
  maxToasts?: number;
}) => {
  const useToasterStoreHook = (
    hotToast as unknown as {
      useToasterStore?: () => {
        toasts: Array<{ id: string; visible: boolean }>;
      };
    }
  ).useToasterStore;

  const toasterState =
    typeof useToasterStoreHook === "function" ? useToasterStoreHook() : null;
  const toasts = toasterState?.toasts;

  useEffect(() => {
    if (!Array.isArray(toasts)) return;
    const visibleToasts = toasts.filter((item) => item.visible);
    if (visibleToasts.length <= maxToasts) return;

    visibleToasts.slice(maxToasts).forEach((excess) => {
      if (typeof hotToast.toast?.dismiss === "function") {
        hotToast.toast.dismiss(excess.id);
      }
    });
  }, [toasts, maxToasts]);

  return null;
};

export const RelayNotificationProvider = ({
  children,
  maxToasts = MAX_SIMULTANEOUS_TOASTS,
}: {
  children: ReactNode;
  maxToasts?: number;
}) => {
  const store = useRelayNotificationStore();
  const activeReplayTaskIdRef = useRef<string | null>(null);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === NOTIFICATION_HISTORY_STORAGE_KEY ||
        event.key === NOTIFICATION_SOUND_STORAGE_KEY
      ) {
        useRelayNotificationStore.getState().hydrate();
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = onReplayEvent((event) => {
      if (event.type === "replay-start") {
        activeReplayTaskIdRef.current = notifyCenter.trackTask({
          title: `Replaying ${event.total} queued offline ${
            event.total === 1 ? "transaction" : "transactions"
          }`,
          category: "cross-chain-relay",
          status: "submitted",
        });
        return;
      }

      if (event.type === "replay-complete" && activeReplayTaskIdRef.current) {
        const taskId = activeReplayTaskIdRef.current;
        activeReplayTaskIdRef.current = null;
        if (event.summary.failed > 0) {
          notifyCenter.markFailed(
            taskId,
            `${event.summary.failed} queued action(s) failed during sync`,
            {
              description: `${event.summary.synced} synced, ${event.summary.remaining} remaining`,
            }
          );
        } else {
          notifyCenter.markConfirmed(taskId, {
            title: `Synced ${event.summary.synced} offline ${
              event.summary.synced === 1 ? "transaction" : "transactions"
            }`,
          });
        }
      }
    });

    return unsubscribe;
  }, []);

  return (
    <RelayNotificationContext.Provider value={store}>
      <ToastStackLimiter maxToasts={maxToasts} />
      {children}
    </RelayNotificationContext.Provider>
  );
};

export const useRelayNotifications = (): RelayNotificationStoreState => {
  const ctx = useContext(RelayNotificationContext);
  const directStore = useRelayNotificationStore();
  return ctx ?? directStore;
};
