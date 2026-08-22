// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sorobanEventWatcher } from "../services/sorobanEventWatcher.service";

describe("SorobanEventWatcher", () => {
  const rpcUrl = "https://mock.soroban.rpc";
  const contractId = "C123456789";

  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn();
    // Stop the watcher's self-rescheduling loop from firing under fake timers
    // so each test controls polling explicitly.
    vi.spyOn(window, "setTimeout").mockReturnValue(
      0 as unknown as ReturnType<typeof setTimeout>
    );
    vi.spyOn(window, "clearTimeout").mockImplementation(() => {});
    vi.spyOn(window, "dispatchEvent").mockImplementation(() => true);
  });

  afterEach(() => {
    sorobanEventWatcher.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
    // @ts-ignore reset private state
    sorobanEventWatcher.listeners = {};
    // @ts-ignore
    sorobanEventWatcher.lastCursor = undefined;
  });

  it("should not fetch events if not started", async () => {
    // @ts-ignore
    await sorobanEventWatcher.poll();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should fetch latest ledger and events on the first poll", async () => {
    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { sequence: 1000 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { events: [] } }),
      });

    sorobanEventWatcher.start(rpcUrl, contractId);
    await vi.runOnlyPendingTimersAsync();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const getLatestLedgerCall = (global.fetch as any).mock.calls[0];
    expect(getLatestLedgerCall[0]).toBe(rpcUrl);
    expect(JSON.parse(getLatestLedgerCall[1].body).method).toBe(
      "getLatestLedger"
    );
    const getEventsCall = (global.fetch as any).mock.calls[1];
    expect(JSON.parse(getEventsCall[1].body).method).toBe("getEvents");
  });

  it("should fetch events and dispatch to listeners when events are present", async () => {
    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { sequence: 1000 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: {
            events: [
              {
                type: "contract",
                pagingToken: "1001-1",
                topic: ["VaultCreated_XDR"],
                value: { some: "data" },
              },
            ],
          },
        }),
      });

    const mockCallback = vi.fn();
    sorobanEventWatcher.on("SorobanEvent", mockCallback);
    const mockVaultCallback = vi.fn();
    sorobanEventWatcher.on("VaultCreated", mockVaultCallback);

    sorobanEventWatcher.start(rpcUrl, contractId);
    await vi.runOnlyPendingTimersAsync();

    expect(mockCallback).toHaveBeenCalledTimes(1);
    expect(mockVaultCallback).toHaveBeenCalledTimes(1);
    expect(window.dispatchEvent).toHaveBeenCalled();

    sorobanEventWatcher.off("SorobanEvent", mockCallback);
    sorobanEventWatcher.off("VaultCreated", mockVaultCallback);
  });

  it("should handle RPC errors gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // First poll: getLatestLedger fails, but the service swallows it and returns
    // 0, so no error is logged yet.
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      statusText: "Internal Server Error",
    });
    sorobanEventWatcher.start(rpcUrl, contractId);
    await vi.runOnlyPendingTimersAsync();

    expect(consoleSpy).not.toHaveBeenCalled();

    // Second poll: getLatestLedger succeeds, but getEvents fails -> logged.
    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { sequence: 1000 } }),
      })
      .mockResolvedValueOnce({ ok: false, statusText: "Bad Gateway" });

    // @ts-ignore
    await sorobanEventWatcher.poll();

    expect(consoleSpy).toHaveBeenCalledWith(
      "SorobanEventWatcher polling error:",
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });
});
