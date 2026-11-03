import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  FiAlertCircle,
  FiArrowUpRight,
  FiBell,
  FiCheckCircle,
  FiClock,
  FiLoader,
  FiRefreshCw,
  FiTrash2,
  FiVolume2,
  FiVolumeX,
  FiX,
} from "react-icons/fi";
import { useRelayNotifications } from "../../context/RelayNotificationContext";
import type {
  RelayNotificationCategory,
  RelayNotificationItem,
  RelayNotificationStatus,
} from "../../services/relayNotification.service";

export interface RelayNotificationDrawerProps {
  isOpen?: boolean;
  onClose?: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
  pendingApprovalCount?: number;
  onOpenApprovalQueue?: () => void;
}

type DrawerFilter = "all" | "active" | "completed";

const CATEGORY_LABELS: Record<RelayNotificationCategory, string> = {
  "cross-chain-relay": "Cross-Chain Relay",
  "arweave-archive": "Arweave Archive",
  "soroban-ttl": "Soroban TTL",
  transaction: "On-Chain Tx",
  system: "System",
};

const STATUS_LABELS: Record<RelayNotificationStatus, string> = {
  pending: "Pending",
  submitted: "Submitted",
  confirmed: "Confirmed",
  failed: "Failed",
};

const STATUS_BADGE_CLASSES: Record<RelayNotificationStatus, string> = {
  pending: "border-amber-500/35 bg-amber-500/10 text-amber-300",
  submitted: "border-sky-500/35 bg-sky-500/10 text-sky-300",
  confirmed: "border-emerald-500/35 bg-emerald-500/10 text-emerald-300",
  failed: "border-rose-500/35 bg-rose-500/12 text-rose-300",
};

const shortenIdentifier = (value: string): string => {
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
};

const LifecycleProgressSteps = ({
  status,
}: {
  status: RelayNotificationStatus;
}) => {
  const stepIndex =
    status === "pending" ? 0 : status === "submitted" ? 1 : 2;
  const finalLabel = status === "failed" ? "Failed" : "Confirmed";
  const steps = ["Pending", "Submitted", finalLabel];

  return (
    <div
      className="flex items-center gap-1.5 pt-1"
      aria-label={`Lifecycle status: ${STATUS_LABELS[status]}`}
    >
      {steps.map((label, idx) => {
        const reached = idx <= stepIndex;
        const isFailedStep = status === "failed" && idx === 2;
        const dotClass = !reached
          ? "bg-gray-800 border-gray-700"
          : isFailedStep
          ? "bg-rose-500 border-rose-400"
          : idx === 2 && status === "confirmed"
          ? "bg-emerald-400 border-emerald-300"
          : "bg-purple-400 border-purple-300";

        return (
          <div key={label} className="flex items-center gap-1.5">
            <span
              className={`h-2 w-2 rounded-full border ${dotClass}`}
              aria-hidden="true"
            />
            <span
              className={`text-[10px] ${
                reached ? "text-gray-300 font-medium" : "text-gray-600"
              }`}
            >
              {label}
            </span>
            {idx < steps.length - 1 && (
              <span
                className={`h-px w-3 ${
                  idx < stepIndex ? "bg-purple-500/60" : "bg-gray-800"
                }`}
                aria-hidden="true"
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

export const RelayNotificationDrawer = ({
  isOpen: controlledIsOpen,
  onClose: controlledOnClose,
  triggerRef,
  pendingApprovalCount = 0,
  onOpenApprovalQueue,
}: RelayNotificationDrawerProps) => {
  const {
    items,
    drawerOpen,
    setDrawerOpen,
    soundEnabled,
    toggleSound,
    removeNotification,
    clearCompleted,
    retryNotification,
    liveAnnouncement,
  } = useRelayNotifications();

  const isOpen =
    controlledIsOpen !== undefined ? controlledIsOpen : drawerOpen;
  const closeDrawer = () => {
    if (controlledOnClose) {
      controlledOnClose();
    } else {
      setDrawerOpen(false);
    }
  };

  const rawId = useId();
  const safeId = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const headingId = `relay-drawer-title-${safeId}`;
  const summaryId = `relay-drawer-summary-${safeId}`;

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  const [filter, setFilter] = useState<DrawerFilter>("all");
  const [retryingId, setRetryingId] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      wasOpenRef.current = true;
      previousActiveElementRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const focusTarget = closeButtonRef.current ?? dialogRef.current;
      focusTarget?.focus();
    } else if (!isOpen && wasOpenRef.current) {
      wasOpenRef.current = false;
      const returnTarget =
        triggerRef?.current ?? previousActiveElementRef.current;
      if (returnTarget && typeof returnTarget.focus === "function") {
        returnTarget.focus();
      }
    }
  }, [isOpen, triggerRef]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeDrawer();
        return;
      }

      if (event.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const activeCount = useMemo(
    () =>
      items.filter(
        (item) => item.status === "pending" || item.status === "submitted"
      ).length,
    [items]
  );

  const completedCount = useMemo(
    () =>
      items.filter(
        (item) => item.status === "confirmed" || item.status === "failed"
      ).length,
    [items]
  );

  const filteredItems = useMemo(() => {
    if (filter === "active") {
      return items.filter(
        (item) => item.status === "pending" || item.status === "submitted"
      );
    }
    if (filter === "completed") {
      return items.filter(
        (item) => item.status === "confirmed" || item.status === "failed"
      );
    }
    return items;
  }, [items, filter]);

  const handleRetry = async (item: RelayNotificationItem) => {
    setRetryingId(item.id);
    try {
      await retryNotification(item.id);
    } finally {
      setRetryingId(null);
    }
  };

  const renderStatusIcon = (status: RelayNotificationStatus) => {
    if (status === "pending" || status === "submitted") {
      return (
        <FiLoader
          className="animate-spin text-sky-300 flex-shrink-0"
          aria-hidden="true"
        />
      );
    }
    if (status === "confirmed") {
      return (
        <FiCheckCircle
          className="text-emerald-400 flex-shrink-0"
          aria-hidden="true"
        />
      );
    }
    return (
      <FiAlertCircle
        className="text-rose-400 flex-shrink-0"
        aria-hidden="true"
      />
    );
  };

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="relay-live-region"
      >
        {liveAnnouncement}
      </div>

      {isOpen && (
        <div className="fixed inset-0 z-[130] flex justify-end">
          <div
            className="fixed inset-0 bg-black/75 backdrop-blur-sm transition-opacity"
            onClick={closeDrawer}
            data-testid="relay-drawer-backdrop"
          />

          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            aria-describedby={summaryId}
            tabIndex={-1}
            className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-gray-800 bg-gray-950 text-gray-100 shadow-2xl outline-none"
          >
            <div className="flex items-center justify-between gap-3 border-b border-gray-800/90 px-5 py-4">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-purple-500/40 bg-purple-950/30 text-purple-300">
                  <FiBell aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h2 id={headingId} className="text-base font-bold truncate">
                    Notification Center
                  </h2>
                  <p id={summaryId} className="text-xs text-gray-400 truncate">
                    {activeCount > 0
                      ? `${activeCount} async relay${
                          activeCount === 1 ? "" : "s"
                        } in progress`
                      : `${items.length} recorded ${
                          items.length === 1 ? "activity" : "activities"
                        }`}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  type="button"
                  onClick={toggleSound}
                  aria-pressed={soundEnabled}
                  aria-label={
                    soundEnabled
                      ? "Mute notification sounds"
                      : "Unmute notification sounds"
                  }
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-gray-800 bg-gray-900/75 text-gray-300 transition-colors hover:border-gray-700 hover:text-white"
                >
                  {soundEnabled ? (
                    <FiVolume2 className="text-sm" aria-hidden="true" />
                  ) : (
                    <FiVolumeX className="text-sm text-gray-500" aria-hidden="true" />
                  )}
                </button>

                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={closeDrawer}
                  aria-label="Close notification drawer"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-gray-800 bg-gray-900/75 text-gray-300 transition-colors hover:border-gray-700 hover:text-white"
                >
                  <FiX className="text-base" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-b border-gray-800/80 px-5 py-2.5">
              <div
                role="tablist"
                aria-label="Filter notifications"
                className="flex items-center gap-1"
              >
                {(
                  [
                    { key: "all", label: `All (${items.length})` },
                    { key: "active", label: `Active (${activeCount})` },
                    { key: "completed", label: `Done (${completedCount})` },
                  ] as const
                ).map((tab) => {
                  const selected = filter === tab.key;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => setFilter(tab.key)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                        selected
                          ? "bg-purple-600/20 text-purple-200 border border-purple-500/40"
                          : "text-gray-400 hover:text-gray-200 hover:bg-gray-900"
                      }`}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={clearCompleted}
                disabled={completedCount === 0}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-gray-300 transition-colors hover:bg-gray-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FiTrash2 className="text-xs" aria-hidden="true" />
                <span>Clear completed</span>
              </button>
            </div>

            {pendingApprovalCount > 0 && onOpenApprovalQueue && (
              <div className="mx-5 mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs text-amber-200">
                    <FiClock className="flex-shrink-0" aria-hidden="true" />
                    <span>
                      {pendingApprovalCount} guardian approval{" "}
                      {pendingApprovalCount === 1 ? "request" : "requests"} awaiting
                      review
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      closeDrawer();
                      onOpenApprovalQueue();
                    }}
                    className="text-xs font-semibold text-amber-300 hover:text-amber-200 underline underline-offset-2 flex-shrink-0"
                  >
                    Review
                  </button>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {filteredItems.length === 0 ? (
                <div className="flex min-h-[14rem] flex-col items-center justify-center rounded-2xl border border-dashed border-gray-800 bg-gray-900/30 p-6 text-center">
                  <FiBell
                    className="mb-3 text-2xl text-gray-600"
                    aria-hidden="true"
                  />
                  <p className="text-sm font-medium text-gray-300">
                    No notifications to show
                  </p>
                  <p className="mt-1 text-xs text-gray-500 max-w-xs">
                    Cross-chain relays, Arweave backups, Soroban TTL renewals,
                    and wallet transactions will be tracked here.
                  </p>
                </div>
              ) : (
                filteredItems.map((item) => {
                  const showLifecycle =
                    item.category === "cross-chain-relay" ||
                    item.category === "arweave-archive" ||
                    item.category === "soroban-ttl" ||
                    item.status === "pending" ||
                    item.status === "submitted";

                  const refId = item.txHash ?? item.messageId;
                  const explorerLabel =
                    item.category === "arweave-archive" && !item.txHash
                      ? "View on Arweave"
                      : "View on Explorer";

                  return (
                    <div
                      key={item.id}
                      data-testid="relay-notification-item"
                      data-status={item.status}
                      className="rounded-xl border border-gray-800/90 bg-gray-900/55 p-3.5 space-y-2 transition-colors hover:border-gray-700/90"
                    >
                      <div className="flex items-start justify-between gap-2.5">
                        <div className="flex items-start gap-2.5 min-w-0">
                          <div className="mt-0.5">
                            {renderStatusIcon(item.status)}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-gray-100 break-words">
                              {item.title}
                            </p>
                            {item.description && (
                              <p className="mt-0.5 text-xs text-gray-400 break-words">
                                {item.description}
                              </p>
                            )}
                            {item.errorMessage && (
                              <p className="mt-1 text-xs text-rose-300 break-words">
                                {item.errorMessage}
                              </p>
                            )}
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => removeNotification(item.id)}
                          aria-label={`Dismiss ${item.title}`}
                          className="rounded-lg p-1 text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-200 flex-shrink-0"
                        >
                          <FiX className="text-sm" aria-hidden="true" />
                        </button>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${
                            STATUS_BADGE_CLASSES[item.status]
                          }`}
                        >
                          {STATUS_LABELS[item.status]}
                        </span>
                        <span className="inline-flex items-center rounded-full border border-gray-800 bg-gray-950/70 px-2 py-0.5 text-gray-400">
                          {CATEGORY_LABELS[item.category]}
                        </span>
                        {item.network && (
                          <span className="inline-flex items-center rounded-full border border-gray-800 bg-gray-950/70 px-2 py-0.5 capitalize text-gray-400">
                            {item.network}
                          </span>
                        )}
                        {item.occurrences > 1 && (
                          <span
                            className="inline-flex items-center rounded-full border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 font-mono text-purple-200"
                            title="Deduplicated repeated alerts"
                          >
                            x{item.occurrences}
                          </span>
                        )}
                        <span className="ml-auto text-gray-500">
                          {formatDistanceToNow(new Date(item.updatedAt), {
                            addSuffix: true,
                          })}
                        </span>
                      </div>

                      {showLifecycle && (
                        <LifecycleProgressSteps status={item.status} />
                      )}

                      {(item.explorerUrl || refId || (item.status === "failed" && item.canRetry)) && (
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-gray-800/70 text-xs">
                          {refId ? (
                            <span className="font-mono text-[11px] text-gray-400">
                              Ref: {shortenIdentifier(refId)}
                            </span>
                          ) : (
                            <span />
                          )}

                          <div className="flex items-center gap-3 ml-auto">
                            {item.status === "failed" && item.canRetry && (
                              <button
                                type="button"
                                disabled={retryingId === item.id}
                                onClick={() => void handleRetry(item)}
                                className="inline-flex items-center gap-1 font-medium text-amber-300 hover:text-amber-200 disabled:opacity-50"
                              >
                                <FiRefreshCw
                                  className={
                                    retryingId === item.id ? "animate-spin" : ""
                                  }
                                  aria-hidden="true"
                                />
                                <span>Retry</span>
                              </button>
                            )}

                            {item.explorerUrl && (
                              <a
                                href={item.explorerUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 font-medium text-purple-300 hover:text-purple-200"
                              >
                                <span>{explorerLabel}</span>
                                <FiArrowUpRight aria-hidden="true" />
                              </a>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default RelayNotificationDrawer;
