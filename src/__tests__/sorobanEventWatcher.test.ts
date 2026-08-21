import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sorobanEventWatcher } from "../services/sorobanEventWatcher.service";

describe("SorobanEventWatcher", () => {
  const rpcUrl = "https://mock.soroban.rpc";
  const contractId = "C123456789";
  const flushPoll = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn();
    vi.stubGlobal("window", {
      clearTimeout,
      setTimeout,
      dispatchEvent: vi.fn(() => true),
    });
    vi.stubGlobal("CustomEvent", class CustomEvent {
      detail: unknown;

      constructor(_type: string, init: { detail: unknown }) {
        this.detail = init.detail;
      }
    });
    vi.spyOn(window, "dispatchEvent").mockImplementation(() => true);
  });

  afterEach(() => {
    sorobanEventWatcher.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { events: [] } })
    });

    sorobanEventWatcher.start(rpcUrl, contractId);
    await flushPoll();
    sorobanEventWatcher.stop();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const fetchCall = (global.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toBe(rpcUrl);
    expect(JSON.parse(fetchCall[1].body).method).toBe("getLatestLedger");
  });

  it("should fetch events and dispatch to listeners when events are present", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { sequence: 1000 } })
    });
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

    sorobanEventWatcher.start(rpcUrl, contractId);
    await flushPoll();
    sorobanEventWatcher.stop();
    await vi.waitFor(() => expect(mockCallback).toHaveBeenCalledTimes(1));

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
  await flushPoll();
    sorobanEventWatcher.stop();

    // getLatestLedger fails and returns 0.

    expect(consoleSpy).not.toHaveBeenCalled(); // getLatestLedger swallows error and returns 0

    // Trigger a manual poll with a cursor so getEvents fails directly.
    // @ts-ignore
    sorobanEventWatcher.lastCursor = "prev-cursor";
    // @ts-ignore
    sorobanEventWatcher.isRunning = true;
    
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
