import { create } from "zustand";
import { toast } from "react-hot-toast";
import { getExplorerTxUrl, type NetworkType } from "../utils/explorer";

export type RelayNotificationStatus =
  | "pending"
  | "submitted"
  | "confirmed"
  | "failed";

export type RelayNotificationCategory =
  | "cross-chain-relay"
  | "arweave-archive"
  | "soroban-ttl"
  | "transaction"
  | "system";

export interface RelayNotificationItem {
  id: string;
  title: string;
  description?: string;
  category: RelayNotificationCategory;
  status: RelayNotificationStatus;
  network?: NetworkType;
  txHash?: string;
  messageId?: string;
  explorerUrl?: string;
  dedupeKey?: string;
  occurrences: number;
  createdAt: number;
  updatedAt: number;
  read: boolean;
  errorMessage?: string;
  canRetry?: boolean;
}

export interface CreateRelayNotificationInput {
  id?: string;
  title: string;
  description?: string;
  category?: RelayNotificationCategory;
  status?: RelayNotificationStatus;
  network?: NetworkType;
  txHash?: string;
  messageId?: string;
  explorerUrl?: string;
  dedupeKey?: string;
  errorMessage?: string;
  silentToast?: boolean;
  onRetry?: () => Promise<void> | void;
}

export interface UpdateRelayNotificationInput {
  title?: string;
  description?: string;
  status?: RelayNotificationStatus;
  network?: NetworkType;
  txHash?: string;
  messageId?: string;
  explorerUrl?: string;
  errorMessage?: string;
  silentToast?: boolean;
  onRetry?: () => Promise<void> | void;
}

export const MAX_SIMULTANEOUS_TOASTS = 3;
export const DEDUPE_WINDOW_MS = 4_000;
export const MAX_HISTORY_ITEMS = 50;
export const NOTIFICATION_HISTORY_STORAGE_KEY =
  "spoovault-relay-notifications-v1";
export const NOTIFICATION_SOUND_STORAGE_KEY =
  "spoovault-notification-sound-v1";

const retryRegistry = new Map<string, () => Promise<void> | void>();
let customSoundEffectHook:
  | ((status: RelayNotificationStatus) => void)
  | null = null;
let idSequence = 0;

export const setNotificationSoundHookForTests = (
  hook: ((status: RelayNotificationStatus) => void) | null
): void => {
  customSoundEffectHook = hook;
};

const getSafeStorage = (): Storage | null => {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Restricted storage or Node 22 test worker without --localstorage-file
  }
  return null;
};

const isBrowserRuntime = (): boolean =>
  typeof window !== "undefined" && typeof document !== "undefined";

const prefersReducedMotion = (): boolean => {
  if (!isBrowserRuntime() || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return Boolean(
      window.matchMedia("(prefers-reduced-motion: reduce)")?.matches
    );
  } catch {
    return false;
  }
};

export const resolveNotificationExplorerUrl = (params: {
  explorerUrl?: string;
  txHash?: string;
  messageId?: string;
  network?: NetworkType;
  category?: RelayNotificationCategory;
}): string | undefined => {
  if (params.explorerUrl) {
    return params.explorerUrl;
  }
  if (params.txHash && params.txHash.trim()) {
    return getExplorerTxUrl(params.txHash.trim(), params.network);
  }
  if (params.messageId && params.messageId.trim()) {
    const cleanId = params.messageId.trim();
    if (params.category === "arweave-archive") {
      return `https://arweave.net/${cleanId}`;
    }
    if (cleanId.startsWith("0x") || /^[0-9a-fA-F]{64}$/.test(cleanId)) {
      return getExplorerTxUrl(cleanId, params.network);
    }
  }
  return undefined;
};

const readStoredItems = (): RelayNotificationItem[] => {
  const storage = getSafeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(NOTIFICATION_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is RelayNotificationItem =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof (entry as RelayNotificationItem).id === "string" &&
          typeof (entry as RelayNotificationItem).title === "string"
      )
      .map((entry) => ({
        ...entry,
        canRetry: retryRegistry.has(entry.id),
      }))
      .slice(0, MAX_HISTORY_ITEMS);
  } catch {
    return [];
  }
};

const persistItems = (items: RelayNotificationItem[]): void => {
  const storage = getSafeStorage();
  if (!storage) return;
  try {
    const serializable = items
      .slice(0, MAX_HISTORY_ITEMS)
      .map(({ canRetry: _canRetry, ...rest }) => rest);
    storage.setItem(
      NOTIFICATION_HISTORY_STORAGE_KEY,
      JSON.stringify(serializable)
    );
  } catch {
    // Ignore storage quota errors
  }
};

const readStoredSoundPreference = (): boolean => {
  const storage = getSafeStorage();
  if (!storage) return true;
  try {
    const raw = storage.getItem(NOTIFICATION_SOUND_STORAGE_KEY);
    if (raw === null) return true;
    return raw !== "0";
  } catch {
    return true;
  }
};

const persistSoundPreference = (enabled: boolean): void => {
  const storage = getSafeStorage();
  if (!storage) return;
  try {
    storage.setItem(NOTIFICATION_SOUND_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore storage quota errors
  }
};

const playSynthesizedTone = (
  status: RelayNotificationStatus,
  soundEnabled: boolean
): void => {
  if (!soundEnabled || prefersReducedMotion()) {
    return;
  }
  if (status !== "confirmed" && status !== "failed") {
    return;
  }
  if (customSoundEffectHook) {
    customSoundEffectHook(status);
    return;
  }
  if (!isBrowserRuntime()) {
    return;
  }

  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    const now = ctx.currentTime;
    if (status === "confirmed") {
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.setValueAtTime(783.99, now + 0.07);
    } else {
      osc.frequency.setValueAtTime(329.63, now);
      osc.frequency.setValueAtTime(246.94, now + 0.09);
    }

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.04, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.19);
    osc.onended = () => {
      void ctx.close().catch(() => {});
    };
  } catch {
    // Browsers may block Web Audio before user gesture; ignore silently
  }
};

const safeDismissToast = (toastId: string): void => {
  if (!isBrowserRuntime()) return;
  try {
    if (typeof toast?.dismiss === "function") {
      toast.dismiss(toastId);
    }
  } catch {
    return;
  }
};

const dispatchToast = (
  toastId: string,
  status: RelayNotificationStatus,
  message: string
): void => {
  if (!isBrowserRuntime()) return;
  try {
    if (status === "pending" || status === "submitted") {
      if (typeof toast?.loading === "function") {
        toast.loading(message, { id: toastId });
      } else if (typeof toast === "function") {
        toast(message, { id: toastId });
      }
      return;
    }
    if (status === "confirmed") {
      if (typeof toast?.success === "function") {
        toast.success(message, { id: toastId, duration: 4000 });
      }
      return;
    }
    if (status === "failed") {
      if (typeof toast?.error === "function") {
        toast.error(message, { id: toastId, duration: 5000 });
      }
    }
  } catch {
    return;
  }
};

const formatLiveAnnouncement = (item: RelayNotificationItem): string => {
  const statusPhrase =
    item.status === "pending"
      ? "is pending"
      : item.status === "submitted"
      ? `submitted${item.network ? ` on ${item.network}` : ""}`
      : item.status === "confirmed"
      ? `confirmed${item.network ? ` on ${item.network}` : ""}`
      : `failed${item.errorMessage ? `: ${item.errorMessage}` : ""}`;

  return `${item.title} ${statusPhrase}.`;
};

const generateNotificationId = (): string => {
  idSequence += 1;
  return `relay-notif-${Date.now()}-${idSequence}`;
};

export interface RelayNotificationStoreState {
  items: RelayNotificationItem[];
  activeToastIds: string[];
  drawerOpen: boolean;
  soundEnabled: boolean;
  liveAnnouncement: string;
  hydrate: () => void;
  setDrawerOpen: (open: boolean) => void;
  toggleDrawer: () => void;
  setSoundEnabled: (enabled: boolean) => void;
  toggleSound: () => void;
  addNotification: (input: CreateRelayNotificationInput) => string;
  updateNotification: (id: string, patch: UpdateRelayNotificationInput) => void;
  removeNotification: (id: string) => void;
  clearCompleted: () => void;
  clearAll: () => void;
  markAllRead: () => void;
  retryNotification: (id: string) => Promise<void>;
}

export const useRelayNotificationStore = create<RelayNotificationStoreState>(
  (set, get) => ({
    items: readStoredItems(),
    activeToastIds: [],
    drawerOpen: false,
    soundEnabled: readStoredSoundPreference(),
    liveAnnouncement: "",

    hydrate: () => {
      set({
        items: readStoredItems(),
        soundEnabled: readStoredSoundPreference(),
      });
    },

    setDrawerOpen: (open: boolean) => {
      set((state) => {
        if (!open) {
          return { drawerOpen: false };
        }
        const marked = state.items.map((item) =>
          item.read ? item : { ...item, read: true }
        );
        persistItems(marked);
        return { drawerOpen: true, items: marked };
      });
    },

    toggleDrawer: () => {
      const next = !get().drawerOpen;
      get().setDrawerOpen(next);
    },

    setSoundEnabled: (enabled: boolean) => {
      persistSoundPreference(enabled);
      set({ soundEnabled: enabled });
    },

    toggleSound: () => {
      const next = !get().soundEnabled;
      get().setSoundEnabled(next);
    },

    addNotification: (input: CreateRelayNotificationInput): string => {
      const now = Date.now();
      const status = input.status ?? "pending";
      const category = input.category ?? "transaction";
      const computedDedupeKey =
        input.dedupeKey ??
        `${category}:${status}:${input.title.trim().toLowerCase()}:${(
          input.description ?? ""
        )
          .trim()
          .toLowerCase()}`;

      const state = get();
      const duplicate = state.items.find(
        (existing) =>
          existing.dedupeKey === computedDedupeKey &&
          (now - existing.updatedAt <= DEDUPE_WINDOW_MS ||
            existing.status === "pending" ||
            existing.status === "submitted")
      );

      if (duplicate) {
        if (input.onRetry) {
          retryRegistry.set(duplicate.id, input.onRetry);
        }
        const updatedDuplicate: RelayNotificationItem = {
          ...duplicate,
          occurrences: duplicate.occurrences + 1,
          updatedAt: now,
          canRetry: retryRegistry.has(duplicate.id),
        };
        const updatedItems = state.items.map((item) =>
          item.id === duplicate.id ? updatedDuplicate : item
        );
        persistItems(updatedItems);
        set({ items: updatedItems });
        return duplicate.id;
      }

      const id = input.id ?? generateNotificationId();
      if (input.onRetry) {
        retryRegistry.set(id, input.onRetry);
      }

      const explorerUrl = resolveNotificationExplorerUrl({
        explorerUrl: input.explorerUrl,
        txHash: input.txHash,
        messageId: input.messageId,
        network: input.network,
        category,
      });

      const newItem: RelayNotificationItem = {
        id,
        title: input.title,
        description: input.description,
        category,
        status,
        network: input.network,
        txHash: input.txHash,
        messageId: input.messageId,
        explorerUrl,
        dedupeKey: computedDedupeKey,
        occurrences: 1,
        createdAt: now,
        updatedAt: now,
        read: state.drawerOpen,
        errorMessage: input.errorMessage,
        canRetry: retryRegistry.has(id),
      };

      const nextItems = [newItem, ...state.items].slice(0, MAX_HISTORY_ITEMS);
      persistItems(nextItems);

      let nextToastIds = [...state.activeToastIds];
      if (!input.silentToast) {
        nextToastIds = nextToastIds.filter((existingId) => existingId !== id);
        nextToastIds.push(id);
        while (nextToastIds.length > MAX_SIMULTANEOUS_TOASTS) {
          const evictedId = nextToastIds.shift();
          if (evictedId) {
            safeDismissToast(evictedId);
          }
        }
        const toastText =
          status === "failed" && input.errorMessage
            ? `${input.title}: ${input.errorMessage}`
            : input.title;
        dispatchToast(id, status, toastText);
        playSynthesizedTone(status, state.soundEnabled);
      }

      set({
        items: nextItems,
        activeToastIds: nextToastIds,
        liveAnnouncement: formatLiveAnnouncement(newItem),
      });

      return id;
    },

    updateNotification: (id: string, patch: UpdateRelayNotificationInput) => {
      const state = get();
      const target = state.items.find((item) => item.id === id);
      if (!target) return;

      if (patch.onRetry) {
        retryRegistry.set(id, patch.onRetry);
      }

      const nextStatus = patch.status ?? target.status;
      const nextNetwork = patch.network ?? target.network;
      const nextTxHash = patch.txHash ?? target.txHash;
      const nextMessageId = patch.messageId ?? target.messageId;
      const nextExplorerUrl = resolveNotificationExplorerUrl({
        explorerUrl: patch.explorerUrl ?? target.explorerUrl,
        txHash: nextTxHash,
        messageId: nextMessageId,
        network: nextNetwork,
        category: target.category,
      });

      const updatedItem: RelayNotificationItem = {
        ...target,
        title: patch.title ?? target.title,
        description: patch.description ?? target.description,
        status: nextStatus,
        network: nextNetwork,
        txHash: nextTxHash,
        messageId: nextMessageId,
        explorerUrl: nextExplorerUrl,
        errorMessage:
          patch.errorMessage !== undefined
            ? patch.errorMessage
            : nextStatus === "confirmed"
            ? undefined
            : target.errorMessage,
        updatedAt: Date.now(),
        read: state.drawerOpen ? true : false,
        canRetry: retryRegistry.has(id),
      };

      const nextItems = state.items.map((item) =>
        item.id === id ? updatedItem : item
      );
      persistItems(nextItems);

      let nextToastIds = [...state.activeToastIds];
      if (!patch.silentToast) {
        if (!nextToastIds.includes(id)) {
          nextToastIds.push(id);
          while (nextToastIds.length > MAX_SIMULTANEOUS_TOASTS) {
            const evictedId = nextToastIds.shift();
            if (evictedId) {
              safeDismissToast(evictedId);
            }
          }
        }
        const toastText =
          nextStatus === "failed" && updatedItem.errorMessage
            ? `${updatedItem.title}: ${updatedItem.errorMessage}`
            : updatedItem.title;
        dispatchToast(id, nextStatus, toastText);
        if (nextStatus !== target.status) {
          playSynthesizedTone(nextStatus, state.soundEnabled);
        }
      }

      set({
        items: nextItems,
        activeToastIds: nextToastIds,
        liveAnnouncement: formatLiveAnnouncement(updatedItem),
      });
    },

    removeNotification: (id: string) => {
      retryRegistry.delete(id);
      safeDismissToast(id);
      set((state) => {
        const nextItems = state.items.filter((item) => item.id !== id);
        persistItems(nextItems);
        return {
          items: nextItems,
          activeToastIds: state.activeToastIds.filter(
            (toastId) => toastId !== id
          ),
        };
      });
    },

    clearCompleted: () => {
      set((state) => {
        const removedIds = new Set<string>();
        const remaining = state.items.filter((item) => {
          const isCompleted =
            item.status === "confirmed" || item.status === "failed";
          if (isCompleted) {
            removedIds.add(item.id);
            retryRegistry.delete(item.id);
            safeDismissToast(item.id);
          }
          return !isCompleted;
        });
        persistItems(remaining);
        return {
          items: remaining,
          activeToastIds: state.activeToastIds.filter(
            (id) => !removedIds.has(id)
          ),
        };
      });
    },

    clearAll: () => {
      const state = get();
      state.activeToastIds.forEach((id) => safeDismissToast(id));
      retryRegistry.clear();
      persistItems([]);
      set({ items: [], activeToastIds: [], liveAnnouncement: "" });
    },

    markAllRead: () => {
      set((state) => {
        const nextItems = state.items.map((item) =>
          item.read ? item : { ...item, read: true }
        );
        persistItems(nextItems);
        return { items: nextItems };
      });
    },

    retryNotification: async (id: string) => {
      const handler = retryRegistry.get(id);
      if (!handler) return;
      get().updateNotification(id, {
        status: "pending",
        errorMessage: undefined,
      });
      await handler();
    },
  })
);

export const notifyCenter = {
  trackTask(input: CreateRelayNotificationInput): string {
    return useRelayNotificationStore.getState().addNotification({
      ...input,
      status: input.status ?? "pending",
    });
  },

  markSubmitted(
    id: string,
    details: Omit<UpdateRelayNotificationInput, "status"> = {}
  ): void {
    useRelayNotificationStore.getState().updateNotification(id, {
      ...details,
      status: "submitted",
    });
  },

  markConfirmed(
    id: string,
    details: Omit<UpdateRelayNotificationInput, "status"> = {}
  ): void {
    useRelayNotificationStore.getState().updateNotification(id, {
      ...details,
      status: "confirmed",
    });
  },

  markFailed(
    id: string,
    error: unknown,
    details: Omit<UpdateRelayNotificationInput, "status" | "errorMessage"> = {}
  ): void {
    const errorMessage =
      error instanceof Error
        ? error.message
        : typeof error === "string"
        ? error
        : "Operation failed";
    useRelayNotificationStore.getState().updateNotification(id, {
      ...details,
      status: "failed",
      errorMessage,
    });
  },

  success(
    title: string,
    options: Omit<CreateRelayNotificationInput, "title" | "status"> = {}
  ): string {
    return useRelayNotificationStore.getState().addNotification({
      ...options,
      title,
      status: "confirmed",
      category: options.category ?? "transaction",
    });
  },

  error(
    title: string,
    options: Omit<CreateRelayNotificationInput, "title" | "status"> = {}
  ): string {
    return useRelayNotificationStore.getState().addNotification({
      ...options,
      title,
      status: "failed",
      category: options.category ?? "system",
    });
  },

  info(
    title: string,
    options: Omit<CreateRelayNotificationInput, "title" | "status"> = {}
  ): string {
    return useRelayNotificationStore.getState().addNotification({
      ...options,
      title,
      status: "submitted",
      category: options.category ?? "system",
    });
  },
};
