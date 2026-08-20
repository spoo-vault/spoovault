import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  stellarService,
  type StellarWalletChangeEvent,
} from "../services/stellar.service";

// In-memory localStorage shim for Vitest Node environment
class MockLocalStorage {
  private store: Record<string, string> = {};

  getItem(key: string): string | null {
    return this.store[key] || null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  clear(): void {
    this.store = {};
  }
}

const originalWindow = (globalThis as any).window;

if (typeof globalThis.localStorage === "undefined") {
  (globalThis as any).localStorage = new MockLocalStorage();
}

const makeMockWindow = (): Record<string, unknown> => ({
  localStorage: (globalThis as any).localStorage,
  setInterval: (): number => 1,
  clearInterval: (): void => {},
});

beforeEach(() => {
  if (!(globalThis as any).localStorage) {
    (globalThis as any).localStorage = new MockLocalStorage();
  }
  (globalThis as any).localStorage.clear();
  stellarService.clear();
  (globalThis as any).window = makeMockWindow();
});

afterEach(() => {
  (globalThis as any).window = originalWindow;
});

describe("Freighter wallet-change subscription", () => {
  it("returns an unsubscribe function that can be invoked safely", () => {
    const unsubscribe = stellarService.subscribeToWalletChanges(() => {});
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });

  it("registers a native listen handler and propagates account/network events", async () => {
    let captured: ((event: StellarWalletChangeEvent) => void) | null = null;
    const listenFn = vi.fn((callback: (event: StellarWalletChangeEvent) => void) => {
      captured = callback;
      return undefined;
    });
    (globalThis as any).window.freighterApi = { listen: listenFn };

    const subscriber = vi.fn();
    const unsubscribe = stellarService.subscribeToWalletChanges(subscriber);

    await vi.waitFor(() => {
      expect(listenFn).toHaveBeenCalled();
    });

    expect(captured).toBeTruthy();
    captured!({ account: "GABCDEFGHIJKLMNOP", network: "TESTNET" });
    expect(subscriber).toHaveBeenCalledWith({
      account: "GABCDEFGHIJKLMNOP",
      network: "TESTNET",
    });

    // Account/network state should be updated for subsequent service calls
    expect(stellarService.getAccount()).toBe("GABCDEFGHIJKLMNOP");
    expect(stellarService.getActiveNetwork()).toBe("TESTNET");

    unsubscribe();
  });

  it("stops propagating events after unsubscribe", async () => {
    let captured: ((event: StellarWalletChangeEvent) => void) | null = null;
    const listenFn = vi.fn((callback: (event: StellarWalletChangeEvent) => void) => {
      captured = callback;
      return () => {};
    });
    (globalThis as any).window.freighterApi = { listen: listenFn };

    const subscriber = vi.fn();
    const unsubscribe = stellarService.subscribeToWalletChanges(subscriber);

    await vi.waitFor(() => {
      expect(listenFn).toHaveBeenCalled();
    });

    unsubscribe();
    captured!({ account: "GNEWACCOUNT12345678" });
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("only propagates account-only or network-only change events", async () => {
    let captured: ((event: StellarWalletChangeEvent) => void) | null = null;
    const listenFn = vi.fn((callback: (event: StellarWalletChangeEvent) => void) => {
      captured = callback;
      return () => {};
    });
    (globalThis as any).window.freighterApi = { listen: listenFn };

    const subscriber = vi.fn();
    const unsubscribe = stellarService.subscribeToWalletChanges(subscriber);
    await vi.waitFor(() => {
      expect(listenFn).toHaveBeenCalled();
    });

    captured!({ account: "GACCOUNTONLY123456" });
    expect(subscriber).toHaveBeenLastCalledWith({ account: "GACCOUNTONLY123456" });

    captured!({ network: "PUBLIC" });
    expect(subscriber).toHaveBeenLastCalledWith({ network: "PUBLIC" });

    unsubscribe();
  });

  it("reads the current network name without throwing", async () => {
    expect(typeof (await stellarService.getNetwork())).toBe("string");
  });
});