import { useEffect, useState } from "react";
import { Chip } from "@heroui/react";
import { FiCloudOff, FiRefreshCw, FiLoader } from "react-icons/fi";
import {
  subscribeToQueue,
  refreshQueueState,
  type QueueState,
} from "../../services/offline/offlineQueue.service";
import { replayPendingActions } from "../../services/offline/replay.service";

const OfflineBanner = () => {
  const [state, setState] = useState<QueueState>({
    pending: 0,
    failed: 0,
    processing: 0,
    synced: 0,
    online: true,
  });
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeToQueue(setState);
    void refreshQueueState();

    const handleOnline = () => void refreshQueueState();
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOnline);
    return () => {
      unsubscribe();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOnline);
    };
  }, []);

  if (state.online && state.pending === 0 && state.failed === 0) {
    return null;
  }

  const queuedCount = state.pending + state.failed;

  const handleManualSync = async () => {
    if (!navigator.onLine) return;
    setSyncing(true);
    try {
      await replayPendingActions();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="sticky top-0 z-40 flex w-full items-center justify-center gap-3 border-b border-warning-500/30 bg-warning-500/10 px-4 py-2 text-sm text-warning-600 backdrop-blur-sm">
      <FiCloudOff aria-hidden className="shrink-0" />
      <span>
        {!state.online
          ? "You're offline — vault data is served from your local cache."
          : "Reconnecting…"}
        {queuedCount > 0 && (
          <>
            {" "}
            <strong>
              {queuedCount} queued action{queuedCount === 1 ? "" : "s"}
            </strong>{" "}
            will sync automatically.
          </>
        )}
      </span>
      {queuedCount > 0 && (
        <Chip size="sm" variant="flat" color="warning" className="h-6">
          {state.pending} pending
          {state.failed > 0 ? ` · ${state.failed} failed` : ""}
        </Chip>
      )}
      {state.online && queuedCount > 0 && (
        <button
          type="button"
          onClick={handleManualSync}
          disabled={syncing}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-warning-700 transition-colors hover:bg-warning-500/20 disabled:opacity-60"
        >
          {syncing ? (
            <FiLoader className="animate-spin" aria-hidden />
          ) : (
            <FiRefreshCw aria-hidden />
          )}
          Sync now
        </button>
      )}
    </div>
  );
};

export default OfflineBanner;
