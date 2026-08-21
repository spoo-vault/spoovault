/**
 * @file ipfsGateway.service.ts
 * @description Multi-gateway IPFS circuit breaker with dynamic latency health scoring.
 *
 * Implements issue #147: automatically benchmarks, ranks, and routes IPFS fetch
 * requests to the fastest healthy gateway, bypassing failing ones without surfacing
 * error toasts to the user.
 *
 * Architecture:
 *  - GatewayHealthScorer  — tracks latency EMA, success rate, consecutive failures,
 *                           and CORS availability per gateway; persists to localStorage.
 *  - CircuitBreaker       — trips to OPEN after 3 consecutive failures, then enters
 *                           HALF_OPEN after an exponential backoff; on success resets
 *                           to CLOSED.
 *  - IpfsGatewayService   — races parallel HEAD probes against the top-3 healthy
 *                           gateways and streams the response from the first responder.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** All public gateways the service will monitor and route through. */
export const DEFAULT_GATEWAYS: readonly string[] = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://nftstorage.link/ipfs/",
  "https://w3s.link/ipfs/",
  "https://4everland.io/ipfs/",
  "https://hardbin.com/ipfs/",
] as const;

const STORAGE_KEY = "spoovault-ipfs-gateway-health";
const FAILURE_THRESHOLD = 3; // trips circuit after this many consecutive failures
const PROBE_TIMEOUT_MS = 5_000; // HEAD probe timeout per gateway
const FETCH_TIMEOUT_MS = 30_000; // GET fetch timeout
const MIN_BACKOFF_MS = 10_000; // initial cooldown after OPEN trip
const MAX_BACKOFF_MS = 300_000; // cap at 5 minutes
const EMA_ALPHA = 0.3; // exponential moving average weight for latency

// ─── Types ────────────────────────────────────────────────────────────────────

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface GatewayHealth {
  url: string;
  /** Exponential moving average of successful response latency (ms). */
  latencyEma: number;
  /** Fraction of recent requests that succeeded [0, 1]. */
  successRate: number;
  /** Total requests attempted (capped for rolling window purposes). */
  totalRequests: number;
  /** Total successes. */
  totalSuccesses: number;
  /** Number of consecutive failures since last success. */
  consecutiveFailures: number;
  /** Whether the last probe confirmed CORS headers were present. */
  corsAvailable: boolean;
  /** Current circuit-breaker state. */
  circuitState: CircuitState;
  /** Timestamp (ms) when the circuit was tripped; 0 if CLOSED. */
  trippedAt: number;
  /** Current backoff duration (ms); doubles on each re-trip. */
  backoffMs: number;
  /** Timestamp of last health update. */
  lastUpdatedAt: number;
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

function loadHealthMap(): Map<string, GatewayHealth> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const entries: [string, GatewayHealth][] = JSON.parse(raw);
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function saveHealthMap(map: Map<string, GatewayHealth>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...map.entries()]));
  } catch {
    // localStorage may be unavailable in some environments; fail silently.
  }
}

// ─── Default health record ────────────────────────────────────────────────────

function defaultHealth(url: string): GatewayHealth {
  return {
    url,
    latencyEma: 0,
    successRate: 1, // optimistic default so new gateways are tried
    totalRequests: 0,
    totalSuccesses: 0,
    consecutiveFailures: 0,
    corsAvailable: true,
    circuitState: "CLOSED",
    trippedAt: 0,
    backoffMs: MIN_BACKOFF_MS,
    lastUpdatedAt: 0,
  };
}

// ─── GatewayHealthScorer ──────────────────────────────────────────────────────

/**
 * Manages per-gateway health metrics and exposes helpers used by the circuit
 * breaker and the race-fetch router.
 */
export class GatewayHealthScorer {
  private _health: Map<string, GatewayHealth>;

  constructor(gateways: readonly string[] = DEFAULT_GATEWAYS) {
    this._health = loadHealthMap();
    // Seed any gateways not yet in storage with defaults.
    for (const url of gateways) {
      if (!this._health.has(url)) {
        this._health.set(url, defaultHealth(url));
      }
    }
  }

  /** Returns a copy of the health record for `url`. */
  get(url: string): GatewayHealth {
    return { ...(this._health.get(url) ?? defaultHealth(url)) };
  }

  /** Returns all health records sorted by score descending (best first). */
  ranked(): GatewayHealth[] {
    return [...this._health.values()]
      .map((h) => ({ ...h }))
      .sort((a, b) => this._score(b) - this._score(a));
  }

  /**
   * Returns the top `n` gateways whose circuit is CLOSED or HALF_OPEN and whose
   * CORS availability is known.
   */
  topHealthy(n = 3): GatewayHealth[] {
    return this.ranked()
      .filter((h) => h.circuitState !== "OPEN")
      .slice(0, n);
  }

  /** Record a successful probe/fetch result. */
  recordSuccess(url: string, latencyMs: number, corsAvailable: boolean): void {
    const h = this._health.get(url) ?? defaultHealth(url);

    h.totalRequests = Math.min(h.totalRequests + 1, 10_000);
    h.totalSuccesses = Math.min(h.totalSuccesses + 1, 10_000);
    h.consecutiveFailures = 0;
    h.corsAvailable = corsAvailable;
    h.successRate = h.totalSuccesses / h.totalRequests;
    h.latencyEma =
      h.latencyEma === 0
        ? latencyMs
        : EMA_ALPHA * latencyMs + (1 - EMA_ALPHA) * h.latencyEma;
    h.circuitState = "CLOSED";
    h.trippedAt = 0;
    h.backoffMs = MIN_BACKOFF_MS; // reset backoff on recovery
    h.lastUpdatedAt = Date.now();

    this._health.set(url, h);
    saveHealthMap(this._health);
  }

  /** Record a failed probe/fetch result (timeout, 4xx/5xx, CORS error, etc.). */
  recordFailure(url: string): void {
    const h = this._health.get(url) ?? defaultHealth(url);

    h.totalRequests = Math.min(h.totalRequests + 1, 10_000);
    h.consecutiveFailures += 1;
    h.successRate = h.totalSuccesses / h.totalRequests;
    h.lastUpdatedAt = Date.now();

    if (h.consecutiveFailures >= FAILURE_THRESHOLD && (h.circuitState === "CLOSED" || h.circuitState === "HALF_OPEN")) {
      h.circuitState = "OPEN";
      h.trippedAt = Date.now();
      // backoff doubles on each successive trip, capped at MAX_BACKOFF_MS
      h.backoffMs = Math.min(h.backoffMs * 2, MAX_BACKOFF_MS);
    }

    this._health.set(url, h);
    saveHealthMap(this._health);
  }

  /**
   * Evaluates whether an OPEN circuit should transition to HALF_OPEN based on
   * elapsed time versus exponential backoff.  Should be called before attempting
   * a request through an OPEN gateway.
   */
  maybeTransitionToHalfOpen(url: string): boolean {
    const h = this._health.get(url) ?? defaultHealth(url);
    if (h.circuitState !== "OPEN") return false;

    const elapsed = Date.now() - h.trippedAt;
    if (elapsed >= h.backoffMs) {
      h.circuitState = "HALF_OPEN";
      this._health.set(url, h);
      saveHealthMap(this._health);
      return true;
    }
    return false;
  }

  /** Composite health score used for ranking (higher is better). */
  private _score(h: GatewayHealth): number {
    if (h.circuitState === "OPEN") return -Infinity;
    // Penalise high latency; treat 0 latency (unprobed) neutrally at 1000ms.
    const latency = h.latencyEma > 0 ? h.latencyEma : 1_000;
    const corsFactor = h.corsAvailable ? 1 : 0.5;
    return (h.successRate * corsFactor * 1_000) / latency;
  }
}

// ─── IpfsGatewayService ───────────────────────────────────────────────────────

export class IpfsGatewayService {
  private _scorer: GatewayHealthScorer;

  constructor(scorer?: GatewayHealthScorer) {
    this._scorer = scorer ?? new GatewayHealthScorer();
  }

  /**
   * Probes the top-3 healthy gateways in parallel with a HEAD request and
   * returns the URL formed by the first one that responds successfully.
   * Falls back to the configured Pinata gateway if all probes fail.
   */
  async probeAndSelectGateway(cid: string): Promise<string> {
    const candidates = this._scorer.topHealthy(3);

    if (candidates.length === 0) {
      // All circuits are OPEN — attempt to transition the least-recently-tripped
      // gateways back to HALF_OPEN and retry.
      for (const h of this._scorer.ranked()) {
        this._scorer.maybeTransitionToHalfOpen(h.url);
      }
      const recovered = this._scorer.topHealthy(3);
      if (recovered.length === 0) {
        // Still no healthy gateway — return Pinata as last resort.
        return `https://gateway.pinata.cloud/ipfs/${cid}`;
      }
      return this._race(cid, recovered);
    }

    return this._race(cid, candidates);
  }

  /**
   * Fetches a CID from IPFS using the best available gateway.  Issues parallel
   * HEAD probes to the top-3 gateways and streams the response from the winner.
   */
  async fetch(cid: string, signal?: AbortSignal): Promise<Response> {
    // Attempt HALF_OPEN transitions before ranking.
    for (const h of this._scorer.ranked()) {
      if (h.circuitState === "OPEN") {
        this._scorer.maybeTransitionToHalfOpen(h.url);
      }
    }

    const candidates = this._scorer.topHealthy(3);

    if (candidates.length === 0) {
      throw new Error(
        "All IPFS gateways are currently unavailable. Please try again shortly."
      );
    }

    const winner = await this._race(cid, candidates);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const combined = signal
      ? this._combineSignals(signal, controller.signal)
      : controller.signal;

    try {
      const response = await globalThis.fetch(winner, { signal: combined });
      clearTimeout(timeoutId);

      if (!response.ok) {
        this._scorer.recordFailure(
          this._baseUrl(winner, candidates.map((c) => c.url))
        );
        throw new Error(`Gateway returned HTTP ${response.status}: ${winner}`);
      }

      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      this._scorer.recordFailure(
        this._baseUrl(winner, candidates.map((c) => c.url))
      );
      throw err;
    }
  }

  /** Returns the current ranked health snapshot (useful for debugging UIs). */
  getHealth(): GatewayHealth[] {
    return this._scorer.ranked();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Races HEAD probes against all candidate gateway URLs for `cid`, records
   * health, and resolves with the full URL of the fastest responder.
   * Rejects only when every candidate fails.
   */
  private _race(cid: string, candidates: GatewayHealth[]): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let failures = 0;

      for (const candidate of candidates) {
        const url = `${candidate.url}${cid}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        const start = Date.now();

        globalThis
          .fetch(url, { method: "HEAD", signal: controller.signal })
          .then((res) => {
            clearTimeout(timeoutId);
            const latency = Date.now() - start;
            const corsOk =
              res.headers.has("access-control-allow-origin") ||
              res.headers.has("access-control-allow-methods");

            if (res.ok) {
              this._scorer.recordSuccess(candidate.url, latency, corsOk);
              if (!settled) {
                settled = true;
                resolve(url);
              }
            } else {
              // Treat non-2xx (e.g., 429) as a failure.
              this._scorer.recordFailure(candidate.url);
              failures++;
              if (failures === candidates.length) {
                reject(
                  new Error(
                    "All probed IPFS gateways are unhealthy. Cannot retrieve CID."
                  )
                );
              }
            }
          })
          .catch(() => {
            clearTimeout(timeoutId);
            this._scorer.recordFailure(candidate.url);
            failures++;
            if (failures === candidates.length && !settled) {
              reject(
                new Error(
                  "All probed IPFS gateways timed out or errored. Cannot retrieve CID."
                )
              );
            }
          });
      }
    });
  }

  /** Extracts the base gateway URL from a full CID URL given a list of known bases. */
  private _baseUrl(fullUrl: string, bases: string[]): string {
    return bases.find((b) => fullUrl.startsWith(b)) ?? fullUrl;
  }

  /** Combines two AbortSignals so that either one aborting aborts the merged controller. */
  private _combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
    const controller = new AbortController();
    const abort = () => controller.abort();
    a.addEventListener("abort", abort, { once: true });
    b.addEventListener("abort", abort, { once: true });
    return controller.signal;
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const ipfsGatewayService = new IpfsGatewayService();
