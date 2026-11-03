// @vitest-environment jsdom
import { useRef } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
  cleanup,
} from "@testing-library/react";

const toastMocks = vi.hoisted(() => ({
  loading: vi.fn((_msg: string, opts?: { id?: string }) => opts?.id ?? "t-load"),
  success: vi.fn((_msg: string, opts?: { id?: string }) => opts?.id ?? "t-ok"),
  error: vi.fn((_msg: string, opts?: { id?: string }) => opts?.id ?? "t-err"),
  dismiss: vi.fn(),
  base: vi.fn((_msg: string, opts?: { id?: string }) => opts?.id ?? "t-base"),
}));

vi.mock("react-hot-toast", () => {
  const fn = Object.assign(toastMocks.base, {
    loading: toastMocks.loading,
    success: toastMocks.success,
    error: toastMocks.error,
    dismiss: toastMocks.dismiss,
  });
  return {
    default: fn,
    toast: fn,
    Toaster: () => null,
    useToasterStore: () => ({ toasts: [] }),
  };
});

import {
  MAX_SIMULTANEOUS_TOASTS,
  NOTIFICATION_HISTORY_STORAGE_KEY,
  notifyCenter,
  resolveNotificationExplorerUrl,
  setNotificationSoundHookForTests,
  useRelayNotificationStore,
  type RelayNotificationStatus,
} from "../services/relayNotification.service";
import {
  RelayNotificationProvider,
  useRelayNotifications,
} from "../context/RelayNotificationContext";
import { RelayNotificationDrawer } from "../components/notifications/RelayNotificationDrawer";
import { CrossChainRelayerService } from "../services/crossChainRelayer.service";

const createMemoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
};

const BellAndDrawerHarness = () => {
  const bellRef = useRef<HTMLButtonElement | null>(null);
  const { drawerOpen, setDrawerOpen, items } = useRelayNotifications();

  return (
    <div>
      <button
        ref={bellRef}
        type="button"
        aria-label="Open notifications"
        aria-haspopup="dialog"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
      >
        Notifications ({items.length})
      </button>
      <RelayNotificationDrawer triggerRef={bellRef} />
    </div>
  );
};

describe("Centralized Relay Notification Manager & Activity Drawer (#318)", () => {
  let memoryStorage: Storage;
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    memoryStorage = createMemoryStorage();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      writable: true,
      value: memoryStorage,
    });

    originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    vi.clearAllMocks();
    setNotificationSoundHookForTests(null);
    useRelayNotificationStore.getState().clearAll();
    useRelayNotificationStore.getState().setDrawerOpen(false);
    useRelayNotificationStore.getState().setSoundEnabled(true);
  });

  afterEach(() => {
    cleanup();
    setNotificationSoundHookForTests(null);
    if (originalMatchMedia) {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
      });
    }
  });

  it("tracks async relay lifecycle pending -> submitted -> confirmed and announces via aria-live", () => {
    render(
      <RelayNotificationProvider>
        <BellAndDrawerHarness />
      </RelayNotificationProvider>
    );

    const liveRegion = screen.getByTestId("relay-live-region");
    expect(liveRegion.getAttribute("role")).toBe("status");
    expect(liveRegion.getAttribute("aria-live")).toBe("polite");

    let taskId = "";
    act(() => {
      taskId = notifyCenter.trackTask({
        title: "Cross-chain Vault #7 heartbeat",
        category: "cross-chain-relay",
        network: "avalanche",
      });
    });

    expect(liveRegion.textContent).toContain(
      "Cross-chain Vault #7 heartbeat is pending."
    );
    expect(toastMocks.loading).toHaveBeenCalledWith(
      "Cross-chain Vault #7 heartbeat",
      { id: taskId }
    );

    const txHash =
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    act(() => {
      notifyCenter.markSubmitted(taskId, {
        txHash,
        network: "avalanche",
      });
    });

    expect(liveRegion.textContent).toContain("submitted on avalanche");

    act(() => {
      notifyCenter.markConfirmed(taskId, {
        title: "Cross-chain Vault #7 heartbeat synced",
        txHash,
        network: "avalanche",
      });
    });

    expect(liveRegion.textContent).toContain("confirmed on avalanche");
    expect(toastMocks.success).toHaveBeenCalledWith(
      "Cross-chain Vault #7 heartbeat synced",
      expect.objectContaining({ id: taskId })
    );

    fireEvent.click(screen.getByRole("button", { name: "Open notifications" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const headingId = dialog.getAttribute("aria-labelledby");
    expect(headingId).toBeTruthy();
    expect(document.getElementById(headingId!)?.textContent).toBe(
      "Notification Center"
    );

    const explorerLink = screen.getByRole("link", { name: /View on Explorer/i });
    expect(explorerLink.getAttribute("href")).toContain(txHash);
    expect(explorerLink.getAttribute("target")).toBe("_blank");
  });

  it("supports failed state with retry callback and Arweave / Stellar explorer links", async () => {
    let attempts = 0;
    let taskId = "";

    render(
      <RelayNotificationProvider>
        <BellAndDrawerHarness />
      </RelayNotificationProvider>
    );

    act(() => {
      taskId = notifyCenter.trackTask({
        title: "Soroban TTL extension for Vault #3",
        category: "soroban-ttl",
        network: "stellar",
        onRetry: async () => {
          attempts += 1;
          notifyCenter.markConfirmed(taskId, {
            txHash:
              "99887766554433221100aabbccddeeff99887766554433221100aabbccddeeff",
            network: "stellar",
          });
        },
      });
      notifyCenter.markFailed(taskId, new Error("RPC timeout during simulation"));
    });

    act(() => {
      notifyCenter.trackTask({
        title: "Permanent Arweave backup",
        category: "arweave-archive",
        status: "confirmed",
        messageId: "arweaveTxId_987654321",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Open notifications" }));

    expect(
      screen.getByText("RPC timeout during simulation")
    ).toBeTruthy();

    const arweaveLink = screen.getByRole("link", { name: /View on Arweave/i });
    expect(arweaveLink.getAttribute("href")).toBe(
      "https://arweave.net/arweaveTxId_987654321"
    );

    const retryBtn = screen.getByRole("button", { name: /Retry/i });
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    await waitFor(() => {
      expect(attempts).toBe(1);
      expect(
        useRelayNotificationStore
          .getState()
          .items.find((item) => item.id === taskId)?.status
      ).toBe("confirmed");
    });

    expect(
      resolveNotificationExplorerUrl({
        txHash:
          "99887766554433221100aabbccddeeff99887766554433221100aabbccddeeff",
        network: "stellar",
      })
    ).toBe(
      "https://testnet.bex.stellar.org/tx/99887766554433221100aabbccddeeff99887766554433221100aabbccddeeff"
    );
  });

  it("caps simultaneous stacked toasts at 3 and deduplicates repeated alerts", () => {
    const ids: string[] = [];
    act(() => {
      for (let i = 1; i <= 5; i += 1) {
        ids.push(
          notifyCenter.trackTask({
            title: `Distinct relay #${i}`,
            dedupeKey: `distinct-${i}`,
          })
        );
      }
    });

    expect(useRelayNotificationStore.getState().activeToastIds).toHaveLength(
      MAX_SIMULTANEOUS_TOASTS
    );
    expect(toastMocks.dismiss).toHaveBeenCalledWith(ids[0]);
    expect(toastMocks.dismiss).toHaveBeenCalledWith(ids[1]);

    act(() => {
      notifyCenter.error("Please connect your Freighter wallet first");
      notifyCenter.error("Please connect your Freighter wallet first");
    });

    const matching = useRelayNotificationStore
      .getState()
      .items.filter(
        (item) => item.title === "Please connect your Freighter wallet first"
      );
    expect(matching).toHaveLength(1);
    expect(matching[0].occurrences).toBe(2);
  });

  it("persists transaction history across hydration and respects sound mute toggle", () => {
    const playedStatuses: RelayNotificationStatus[] = [];
    setNotificationSoundHookForTests((status) => {
      playedStatuses.push(status);
    });

    render(
      <RelayNotificationProvider>
        <BellAndDrawerHarness />
      </RelayNotificationProvider>
    );

    act(() => {
      notifyCenter.success("Vault #12 created successfully!");
    });
    expect(playedStatuses).toEqual(["confirmed"]);

    const storedRaw = memoryStorage.getItem(NOTIFICATION_HISTORY_STORAGE_KEY);
    expect(storedRaw).toBeTruthy();
    expect(JSON.parse(storedRaw!)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Open notifications" }));
    const muteBtn = screen.getByRole("button", {
      name: "Mute notification sounds",
    });
    expect(muteBtn.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(muteBtn);
    expect(
      screen
        .getByRole("button", { name: "Unmute notification sounds" })
        .getAttribute("aria-pressed")
    ).toBe("false");

    act(() => {
      notifyCenter.error("Simulated failure while muted");
    });
    expect(playedStatuses).toEqual(["confirmed"]);

    act(() => {
      useRelayNotificationStore.setState({ items: [] });
      useRelayNotificationStore.getState().hydrate();
    });
    expect(useRelayNotificationStore.getState().items).toHaveLength(2);
  });

  it("closes on Escape, restores focus to the bell trigger, and clears only completed items", () => {
    render(
      <RelayNotificationProvider>
        <BellAndDrawerHarness />
      </RelayNotificationProvider>
    );

    act(() => {
      notifyCenter.trackTask({
        title: "In-flight Soroban relay",
        category: "cross-chain-relay",
        status: "submitted",
      });
      notifyCenter.success("Completed vault transaction");
    });

    const bellTrigger = screen.getByRole("button", {
      name: "Open notifications",
    });
    bellTrigger.focus();
    fireEvent.click(bellTrigger);

    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Clear completed/i }));
    expect(screen.queryByText("Completed vault transaction")).toBeNull();
    expect(screen.getByText("In-flight Soroban relay")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(bellTrigger);
  });

  it("captures CrossChainRelayerService Soroban relay lifecycle automatically", async () => {
    const relayer = new CrossChainRelayerService();
    const signed = CrossChainRelayerService.signPayload(
      {
        vaultGID:
          "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        guardian: "0x1111111111111111111111111111111111111111",
        approvalType: 1,
        nonce: 7,
        timestamp: Date.now(),
      },
      "unit-test-secret"
    );

    const response = await relayer.relayApprovalToSoroban(signed, {
      relayApprovalGrant: vi
        .fn()
        .mockResolvedValue({ ledger: 42001, success: true }),
    });

    expect(response).toEqual({ relayed: true, ledger: 42001 });
    const latest = useRelayNotificationStore.getState().items[0];
    expect(latest.category).toBe("cross-chain-relay");
    expect(latest.status).toBe("confirmed");
    expect(latest.description).toContain("42001");
  });
});
