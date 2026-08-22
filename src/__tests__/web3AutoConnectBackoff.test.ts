// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderHook, act } from "@testing-library/react";

// --- Mock every side-effecting dependency Web3Context imports ---------------
// so the tests exercise only the auto-connect retry/backoff policy itself,
// never a real wallet, RPC endpoint, or Stellar SDK.

vi.mock("react-hot-toast", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock("../services/contract.service", () => ({
  contractService: {
    initialize: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock("../services/stellar.service", () => ({
  stellarService: {
    initialize: vi.fn(async () => null),
    clear: vi.fn(),
    getNetwork: vi.fn(async () => ""),
    getRpcUrl: vi.fn(() => ""),
    getContractId: vi.fn(() => ""),
    connectWallet: vi.fn(async () => ""),
    subscribeToWalletChanges: vi.fn(() => () => {}),
  },
}));

vi.mock("../services/sorobanEventIndexer.service", () => ({
  sorobanEventIndexer: { start: vi.fn(), stop: vi.fn() },
}));

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  const BrowserProvider = vi.fn().mockImplementation(function (this: unknown) {
    return {
      getNetwork: async () => ({ chainId: 43113n }),
      getSigner: async () => ({}),
    };
  });
  return {
    ...actual,
    BrowserProvider,
    ethers: {
      ...(actual as any).ethers,
      BrowserProvider,
    },
  };
});

import { Web3Provider, useWeb3 } from "../context/Web3Context";

type EthereumMock = {
  request: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  __emit: (event: string, ...args: unknown[]) => void;
};

const createEthereumMock = (): EthereumMock => {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    request: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
    }),
    removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners[event] = (listeners[event] || []).filter((h) => h !== handler);
    }),
    __emit: (event: string, ...args: unknown[]) => {
      (listeners[event] || []).forEach((h) => h(...args));
    },
  };
};

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(Web3Provider, null, children);

const eth_accounts_calls = (ethereum: EthereumMock) =>
  ethereum.request.mock.calls.filter(
    (call: any[]) => call[0]?.method === "eth_accounts"
  ).length;

describe("Web3Context auto-connect retry/backoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    (window as any).ethereum = createEthereumMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a transient failure with exponential backoff, then gives up after the max attempts", async () => {
    vi.useFakeTimers();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ethereum = (window as any).ethereum as EthereumMock;
    ethereum.request.mockRejectedValue(new Error("provider not ready"));

    renderHook(() => useWeb3(), { wrapper });

    await vi.advanceTimersByTimeAsync(0);
    expect(eth_accounts_calls(ethereum)).toBe(1);

    // First backoff: 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    expect(eth_accounts_calls(ethereum)).toBe(2);

    // Second backoff: 2000ms
    await vi.advanceTimersByTimeAsync(2000);
    expect(eth_accounts_calls(ethereum)).toBe(3);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Auto-connect gave up after 3 attempts"),
      expect.any(Error)
    );

    // No further attempts should ever be scheduled once the budget is spent.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(eth_accounts_calls(ethereum)).toBe(3);

    consoleErrorSpy.mockRestore();
  });

  it("halts immediately on a user rejection instead of consuming the retry budget", async () => {
    vi.useFakeTimers();
    const ethereum = (window as any).ethereum as EthereumMock;
    const rejection = Object.assign(new Error("User rejected the request."), {
      code: 4001,
    });
    ethereum.request.mockRejectedValue(rejection);

    renderHook(() => useWeb3(), { wrapper });

    await vi.advanceTimersByTimeAsync(0);
    expect(eth_accounts_calls(ethereum)).toBe(1);

    // A rejection stops auto-connect outright - no backoff retry follows it,
    // unlike a transient failure.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(eth_accounts_calls(ethereum)).toBe(1);

    // The suppression must survive further accountsChanged churn too - not
    // just the absence of a backoff timer. Without it, MetaMask re-firing
    // accountsChanged (which happens on its own, independent of any timer)
    // would re-prompt the user right after they'd already said no.
    await act(async () => {
      ethereum.__emit("accountsChanged", ["0xabc"]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(eth_accounts_calls(ethereum)).toBe(1);
  });

  it("clears any pending backoff timer on unmount so no attempt fires after teardown", async () => {
    vi.useFakeTimers();
    const ethereum = (window as any).ethereum as EthereumMock;
    ethereum.request.mockRejectedValue(new Error("transient"));

    const { unmount } = renderHook(() => useWeb3(), { wrapper });
    await vi.advanceTimersByTimeAsync(0);
    expect(eth_accounts_calls(ethereum)).toBe(1);

    unmount();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(eth_accounts_calls(ethereum)).toBe(1);
  });

  it("re-arms auto-connect via an explicit connect() call after a prior rejection suppressed it", async () => {
    vi.useFakeTimers();
    const ethereum = (window as any).ethereum as EthereumMock;
    const rejection = Object.assign(new Error("User rejected the request."), {
      code: 4001,
    });
    ethereum.request.mockImplementation(({ method }: { method: string }) => {
      if (method === "eth_accounts") return Promise.reject(rejection);
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useWeb3(), { wrapper });
    await vi.advanceTimersByTimeAsync(0);
    expect(eth_accounts_calls(ethereum)).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(eth_accounts_calls(ethereum)).toBe(1); // still suppressed

    // The user explicitly clicks Connect; make both calls succeed from here on.
    ethereum.request.mockImplementation(({ method }: { method: string }) => {
      if (method === "eth_requestAccounts") return Promise.resolve(["0xabc"]);
      if (method === "eth_accounts") return Promise.resolve(["0xabc"]);
      return Promise.resolve([]);
    });

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.account).toBe("0xabc");

    const callsBefore = eth_accounts_calls(ethereum);
    await act(async () => {
      ethereum.__emit("accountsChanged", ["0xabc"]);
      await vi.advanceTimersByTimeAsync(0);
    });

    // Auto-connect ran again in response to accountsChanged, proving the
    // explicit connect() call reset the suppression left by the earlier
    // rejection instead of it lingering for the rest of the session.
    expect(eth_accounts_calls(ethereum)).toBeGreaterThan(callsBefore);
  });
});
