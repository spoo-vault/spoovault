import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  stellarService,
  __setFreighterModuleForTesting,
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
  __setFreighterModuleForTesting({
    isConnected: async () => true,
    getAddress: async () => "GINITIALACCOUNT",
    getNetwork: async () => "TESTNET",
  });
  (globalThis as any).window = makeMockWindow();
});

afterEach(() => {
  __setFreighterModuleForTesting(undefined);
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

  it("falls back to polling when native listen is unavailable", async () => {
    let poll: (() => void) | undefined;
    const clearInterval = vi.fn();
    (globalThis as any).window = {
      ...makeMockWindow(),
      setInterval: vi.fn((callback: () => void) => {
        poll = callback;
        return 1;
      }),
      clearInterval,
    };

    let address = "GINITIALACCOUNT";
    let network = "TESTNET";
    __setFreighterModuleForTesting({
      isConnected: async () => true,
      getAddress: async () => address,
      getNetwork: async () => network,
    });

    const subscriber = vi.fn();
    const unsubscribe = stellarService.subscribeToWalletChanges(subscriber);
    await vi.waitFor(() => expect(poll).toBeDefined());

    address = "GUPDATEDACCOUNT";
    network = "PUBLIC";
    await poll!();

    expect(subscriber).toHaveBeenCalledWith({
      account: "GUPDATEDACCOUNT",
      network: "PUBLIC",
    });
    unsubscribe();
    expect(clearInterval).toHaveBeenCalledWith(1);
  });

  it("normalizes object-shaped Freighter responses and missing network support", async () => {
    __setFreighterModuleForTesting({
      isConnected: async () => ({ isConnected: true }),
      getAddress: async () => ({ address: "GOBJECTACCOUNT" }),
    });

    expect(await stellarService.connectWallet()).toBe("GOBJECTACCOUNT");
    expect(await stellarService.getNetwork()).toBe("");
  });

  it("does not notify when a polling tick finds no changes", async () => {
    let poll: (() => void) | undefined;
    (globalThis as any).window = {
      ...makeMockWindow(),
      setInterval: vi.fn((callback: () => void) => {
        poll = callback;
        return 1;
      }),
    };

    const subscriber = vi.fn();
    const unsubscribe = stellarService.subscribeToWalletChanges(subscriber);
    await vi.waitFor(() => expect(poll).toBeDefined());
    subscriber.mockClear();
    await poll!();

    expect(subscriber).not.toHaveBeenCalled();
    unsubscribe();
  });
});