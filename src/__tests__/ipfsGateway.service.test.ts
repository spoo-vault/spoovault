/**
 * Unit tests for ipfsGateway.service.ts
 *
 * Covers:
 *  - GatewayHealthScorer: recordSuccess, recordFailure, ranking, topHealthy
 *  - CircuitBreaker logic: CLOSED → OPEN after 3 failures, HALF_OPEN after backoff
 *  - IpfsGatewayService: probeAndSelectGateway and fetch with gateway timeout/429/
 *    circuit-breaker scenarios
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GatewayHealthScorer,
  IpfsGatewayService,
  DEFAULT_GATEWAYS,
} from "../services/ipfsGateway.service";

// ─── Stub localStorage ────────────────────────────────────────────────────────

const localStorageStore: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => localStorageStore[key] ?? null,
  setItem: (key: string, value: string) => { localStorageStore[key] = value; },
  removeItem: (key: string) => { delete localStorageStore[key]; },
  clear: () => { Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k]); },
};

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns a scorer seeded with only the provided gateways (no real localStorage state). */
function freshScorer(gateways: string[]): GatewayHealthScorer {
  localStorageMock.clear();
  return new GatewayHealthScorer(gateways);
}

const GW_A = "https://gw-a.example/ipfs/";
const GW_B = "https://gw-b.example/ipfs/";
const GW_C = "https://gw-c.example/ipfs/";

// ─── GatewayHealthScorer ─────────────────────────────────────────────────────

describe("GatewayHealthScorer", () => {
  let scorer: GatewayHealthScorer;

  beforeEach(() => {
    scorer = freshScorer([GW_A, GW_B, GW_C]);
  });

  it("initialises all gateways with CLOSED circuit and default health", () => {
    for (const url of [GW_A, GW_B, GW_C]) {
      const h = scorer.get(url);
      expect(h.circuitState).toBe("CLOSED");
      expect(h.consecutiveFailures).toBe(0);
      expect(h.successRate).toBe(1);
    }
  });

  it("recordSuccess updates latency EMA and resets failure count", () => {
    scorer.recordSuccess(GW_A, 200, true);
    const h = scorer.get(GW_A);
    expect(h.latencyEma).toBe(200);
    expect(h.consecutiveFailures).toBe(0);
    expect(h.successRate).toBe(1);
    expect(h.corsAvailable).toBe(true);
  });

  it("latency EMA smooths over multiple samples", () => {
    scorer.recordSuccess(GW_A, 100, true);
    scorer.recordSuccess(GW_A, 200, true);
    const h = scorer.get(GW_A);
    // EMA: first sample sets it to 100; second = 0.3*200 + 0.7*100 = 130
    expect(h.latencyEma).toBeCloseTo(130, 1);
  });

  it("recordFailure increments consecutiveFailures but does not trip below threshold", () => {
    scorer.recordFailure(GW_B);
    scorer.recordFailure(GW_B);
    const h = scorer.get(GW_B);
    expect(h.consecutiveFailures).toBe(2);
    expect(h.circuitState).toBe("CLOSED");
  });

  it("trips circuit to OPEN after 3 consecutive failures", () => {
    scorer.recordFailure(GW_B);
    scorer.recordFailure(GW_B);
    scorer.recordFailure(GW_B);
    const h = scorer.get(GW_B);
    expect(h.circuitState).toBe("OPEN");
    expect(h.trippedAt).toBeGreaterThan(0);
  });

  it("recordSuccess closes an OPEN circuit and resets backoff", () => {
    scorer.recordFailure(GW_A);
    scorer.recordFailure(GW_A);
    scorer.recordFailure(GW_A); // OPEN
    scorer.recordSuccess(GW_A, 50, true);
    const h = scorer.get(GW_A);
    expect(h.circuitState).toBe("CLOSED");
    expect(h.consecutiveFailures).toBe(0);
    expect(h.backoffMs).toBe(10_000); // reset to MIN_BACKOFF_MS
  });

  it("backoff doubles on each successive circuit trip without recovery", () => {
    // First trip: 3 failures → OPEN, backoffMs doubles from MIN (10000) to 20000
    [1, 2, 3].forEach(() => scorer.recordFailure(GW_C));
    expect(scorer.get(GW_C).circuitState).toBe("OPEN");
    const firstBackoff = scorer.get(GW_C).backoffMs; // 20000

    // Simulate backoff elapsed → HALF_OPEN
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockReturnValue(realNow() + 25_000);
    scorer.maybeTransitionToHalfOpen(GW_C);
    vi.restoreAllMocks();

    // Re-trip without recovery: 3 more failures → OPEN again, backoff doubles again
    [1, 2, 3].forEach(() => scorer.recordFailure(GW_C));
    expect(scorer.get(GW_C).circuitState).toBe("OPEN");
    const secondBackoff = scorer.get(GW_C).backoffMs; // 40000
    expect(secondBackoff).toBe(firstBackoff * 2);
  });

  it("maybeTransitionToHalfOpen returns false before backoff elapses", () => {
    [1, 2, 3].forEach(() => scorer.recordFailure(GW_A));
    const transitioned = scorer.maybeTransitionToHalfOpen(GW_A);
    expect(transitioned).toBe(false);
    expect(scorer.get(GW_A).circuitState).toBe("OPEN");
  });

  it("maybeTransitionToHalfOpen transitions after backoff elapses", () => {
    [1, 2, 3].forEach(() => scorer.recordFailure(GW_A));
    // Spy on Date.now to simulate the backoff period having elapsed.
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockReturnValue(realNow() + 20_000); // after MIN_BACKOFF_MS=10s
    const transitioned = scorer.maybeTransitionToHalfOpen(GW_A);
    expect(transitioned).toBe(true);
    expect(scorer.get(GW_A).circuitState).toBe("HALF_OPEN");
    vi.restoreAllMocks();
  });

  it("topHealthy excludes OPEN gateways", () => {
    [1, 2, 3].forEach(() => scorer.recordFailure(GW_A));
    const top = scorer.topHealthy(3);
    expect(top.map((h) => h.url)).not.toContain(GW_A);
  });

  it("ranked orders by composite score (lower latency ranked higher)", () => {
    scorer.recordSuccess(GW_A, 500, true); // slower
    scorer.recordSuccess(GW_B, 100, true); // faster
    const ranked = scorer.ranked();
    expect(ranked[0].url).toBe(GW_B);
  });

  it("persists and loads health from localStorage across instances", () => {
    scorer.recordSuccess(GW_A, 150, true);
    scorer.recordFailure(GW_B);
    // New instance reads the same storage
    const scorer2 = new GatewayHealthScorer([GW_A, GW_B, GW_C]);
    expect(scorer2.get(GW_A).latencyEma).toBeCloseTo(150, 1);
    expect(scorer2.get(GW_B).consecutiveFailures).toBe(1);
  });
});

// ─── IpfsGatewayService ───────────────────────────────────────────────────────

describe("IpfsGatewayService", () => {
  let scorer: GatewayHealthScorer;
  let service: IpfsGatewayService;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scorer = freshScorer([GW_A, GW_B, GW_C]);
    service = new IpfsGatewayService(scorer);
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── probeAndSelectGateway ──────────────────────────────────────────────────

  it("probeAndSelectGateway resolves with the URL of the fastest responder", async () => {
    const cid = "QmTestCID";
    // GW_A responds successfully; GW_B is slower (delayed via resolved promise)
    fetchSpy.mockImplementation((url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.startsWith(GW_A)) {
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { "access-control-allow-origin": "*" },
          })
        );
      }
      if (urlStr.startsWith(GW_B)) {
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(null, {
                  status: 200,
                  headers: { "access-control-allow-origin": "*" },
                })
              ),
            50
          )
        );
      }
      // GW_C fails
      return Promise.reject(new Error("network error"));
    });

    const result = await service.probeAndSelectGateway(cid);
    expect(result).toBe(`${GW_A}${cid}`);
  });

  it("probeAndSelectGateway routes around a gateway that returns 429", async () => {
    const cid = "QmRateLimitedCID";
    fetchSpy.mockImplementation((url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.startsWith(GW_A)) {
        return Promise.resolve(new Response(null, { status: 429 }));
      }
      if (urlStr.startsWith(GW_B)) {
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { "access-control-allow-origin": "*" },
          })
        );
      }
      return Promise.reject(new Error("network error"));
    });

    const result = await service.probeAndSelectGateway(cid);
    expect(result).toBe(`${GW_B}${cid}`);
    // GW_A failure recorded
    expect(scorer.get(GW_A).consecutiveFailures).toBeGreaterThanOrEqual(1);
  });

  it("probeAndSelectGateway rejects when ALL gateways fail", async () => {
    fetchSpy.mockRejectedValue(new Error("network error"));

    await expect(service.probeAndSelectGateway("QmAllFail")).rejects.toThrow(
      /unhealthy|timed out|errored/i
    );
  });

  it("circuit breaker is tripped after 3 consecutive probe failures", async () => {
    const cid = "QmCBTrip";
    fetchSpy.mockImplementation((url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.startsWith(GW_A)) return Promise.reject(new Error("timeout"));
      if (urlStr.startsWith(GW_B))
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { "access-control-allow-origin": "*" },
          })
        );
      return Promise.reject(new Error("timeout"));
    });

    // Drive GW_A and GW_C to OPEN by recording direct failures
    for (let i = 0; i < 3; i++) {
      scorer.recordFailure(GW_A);
      scorer.recordFailure(GW_C);
    }
    expect(scorer.get(GW_A).circuitState).toBe("OPEN");
    expect(scorer.get(GW_C).circuitState).toBe("OPEN");

    // Only GW_B is healthy — service should still resolve via GW_B
    const result = await service.probeAndSelectGateway(cid);
    expect(result).toBe(`${GW_B}${cid}`);
  });

  // ── fetch ──────────────────────────────────────────────────────────────────

  it("fetch streams from the winning gateway", async () => {
    const cid = "QmFetchCID";
    // Probe (HEAD) response
    fetchSpy.mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { "access-control-allow-origin": "*" },
          })
        );
      }
      // GET response
      return Promise.resolve(new Response("document-content", { status: 200 }));
    });

    const res = await service.fetch(cid);
    expect(res.ok).toBe(true);
    const text = await res.text();
    expect(text).toBe("document-content");
  });

  it("fetch throws when gateway returns non-2xx on GET", async () => {
    fetchSpy.mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { "access-control-allow-origin": "*" },
          })
        );
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    });

    await expect(service.fetch("QmServerError")).rejects.toThrow(/HTTP 500/);
  });

  it("fetch throws when all gateway probes time out", async () => {
    fetchSpy.mockRejectedValue(new Error("AbortError"));

    await expect(service.fetch("QmTimeout")).rejects.toThrow();
  });

  // ── getHealth ──────────────────────────────────────────────────────────────

  it("getHealth returns all gateway records", () => {
    const health = service.getHealth();
    expect(health.length).toBe(3);
    expect(health.every((h) => typeof h.url === "string")).toBe(true);
  });
});

// ─── DEFAULT_GATEWAYS ─────────────────────────────────────────────────────────

describe("DEFAULT_GATEWAYS", () => {
  it("contains at least 8 gateways", () => {
    expect(DEFAULT_GATEWAYS.length).toBeGreaterThanOrEqual(8);
  });

  it("all entries end with /ipfs/ path segment", () => {
    for (const gw of DEFAULT_GATEWAYS) {
      expect(gw).toMatch(/\/ipfs\/$/);
    }
  });
});
