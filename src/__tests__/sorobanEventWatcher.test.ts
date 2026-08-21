import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sorobanEventWatcher } from "../services/sorobanEventWatcher.service";

describe("SorobanEventWatcher", () => {
  const rpcUrl = "https://mock.soroban.rpc";
  const contractId = "C123456789";

  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn();
    // Spy on window.dispatchEvent
    vi.spyOn(window, "dispatchEvent").mockImplementation(() => true);
  });

  afterEach(() => {
    sorobanEventWatcher.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
    // Reset private state via fresh instance if needed, but since it's a singleton, 
    // stopping it and clearing listeners is usually enough for tests.
    // Clean up generic listeners:
    // @ts-ignore
    sorobanEventWatcher.listeners = {};
    // @ts-ignore
    sorobanEventWatcher.lastCursor = undefined;
  });

  it("should not fetch events if not started", async () => {
    // @ts-ignore
    await sorobanEventWatcher.poll();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should initialize and fetch latest ledger on first poll", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { sequence: 1000 }
      })
    });

    sorobanEventWatcher.start(rpcUrl, contractId);
    
    // Fast forward to trigger the initial fetch LatestLedger
    await vi.runOnlyPendingTimersAsync();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const fetchCall = (global.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toBe(rpcUrl);
    expect(JSON.parse(fetchCall[1].body).method).toBe("getLatestLedger");
  });

  it("should fetch events and dispatch to listeners when events are present", async () => {
    // Mock getLatestLedger
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { sequence: 1000 } })
    });

    sorobanEventWatcher.start(rpcUrl, contractId);
    await vi.runOnlyPendingTimersAsync();

    // Now mock the getEvents response for the next poll
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          events: [
            {
              type: "contract",
              pagingToken: "1001-1",
              topic: ["VaultCreated_XDR"],
              value: { some: "data" }
            }
          ]
        }
      })
    });

    const mockCallback = vi.fn();
    sorobanEventWatcher.on("SorobanEvent", mockCallback);
    const mockVaultCallback = vi.fn();
    sorobanEventWatcher.on("VaultCreated", mockVaultCallback);

    // Fast forward to next poll
    await vi.advanceTimersByTimeAsync(5000);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse((global.fetch as any).mock.calls[1][1].body).method).toBe("getEvents");
    
    expect(mockCallback).toHaveBeenCalledTimes(1);
    expect(mockVaultCallback).toHaveBeenCalledTimes(1);
    expect(window.dispatchEvent).toHaveBeenCalledTimes(3); // SorobanEvent, VaultCreated, DocumentAdded generic custom events
    
    sorobanEventWatcher.off("SorobanEvent", mockCallback);
    sorobanEventWatcher.off("VaultCreated", mockVaultCallback);
  });

  it("should handle RPC errors gracefully", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      statusText: "Internal Server Error"
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    sorobanEventWatcher.start(rpcUrl, contractId);
    // getLatestLedger fails and returns 0.
    await vi.runOnlyPendingTimersAsync();

    expect(consoleSpy).not.toHaveBeenCalled(); // getLatestLedger swallows error and returns 0

    // advance to next poll (which won't happen because startLedger === 0 returns early)
    await vi.advanceTimersByTimeAsync(5000);
    
    // Now simulate getLatestLedger succeeding, but getEvents failing
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { sequence: 1000 } })
    });
    // @ts-ignore
    sorobanEventWatcher.lastCursor = undefined;
    // trigger a manual poll just to test the error block inside fetchEvents
    // @ts-ignore
    sorobanEventWatcher.lastCursor = "prev-cursor";
    
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      statusText: "Bad Gateway"
    });
    
    // @ts-ignore
    await sorobanEventWatcher.poll();

    expect(consoleSpy).toHaveBeenCalledWith(
      "SorobanEventWatcher polling error:",
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });
});
