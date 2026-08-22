/**
 * Multi-gateway IPFS download client.
 *
 * Public Pinata rate limits (HTTP 429) previously crashed document loads
 * because fetches targeted a single hardcoded gateway. This module:
 *   1. Maintains a pool (Pinata, Infura, Cloudflare, ipfs.io)
 *   2. Races healthy gateways and returns the first 2xx
 *   3. Opens a per-gateway circuit on 429 / timeout / 5xx so a sick
 *      gateway is skipped until its cooldown elapses
 *
 * Uploads stay on Pinata (or the proxy). Only reads go through this pool.
 */

export const DEFAULT_IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.infura.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://ipfs.io/ipfs/",
] as const;

export const DEFAULT_GATEWAY_TIMEOUT_MS = 8_000;
export const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000;
export const DEFAULT_FAILURE_THRESHOLD = 1;

export type GatewayCircuitState = "closed" | "open" | "half-open";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface IpfsGatewayClientOptions {
  gateways?: string[];
  primary?: string;
  extras?: string[];
  timeoutMs?: number;
  cooldownMs?: number;
  failureThreshold?: number;
  fetchFn?: FetchFn;
  now?: () => number;
}

export interface IpfsGatewayClient {
  getURL: (hash: string) => string;
  getGatewayPool: () => string[];
  fetchFile: (hash: string, init?: RequestInit) => Promise<Response>;
  resetCircuits: () => void;
  getCircuitState: (gateway: string) => GatewayCircuitState;
}

interface CircuitRecord {
  consecutiveFailures: number;
  openedUntil: number;
}

export class IpfsGatewayFetchError extends Error {
  readonly code = "GATEWAY_FETCH_FAILED" as const;

  constructor(public readonly cid: string, public readonly failures: string[]) {
    super(
      `Failed to fetch IPFS content (${cid}): all gateways failed. ${failures.join(
        "; "
      )}`
    );
    this.name = "IpfsGatewayFetchError";
  }
}

export const normalizeIpfsCid = (input: string): string => {
  let value = input.trim();
  if (!value) {
    return "";
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      const marker = parsed.pathname.indexOf("/ipfs/");
      if (marker >= 0) {
        value = parsed.pathname.slice(marker + "/ipfs/".length);
      } else {
        value = parsed.pathname.replace(/^\/+/, "");
      }
    } catch {
      return value;
    }
  } else if (value.toLowerCase().startsWith("ipfs://")) {
    value = value.slice("ipfs://".length);
  }
  value = value.replace(/^\/+/, "");
  if (value.toLowerCase().startsWith("ipfs/")) {
    value = value.slice("ipfs/".length);
  }
  return value.split("?")[0].split("#")[0].replace(/^\/+/, "");
};

export const normalizeGatewayBase = (gateway: string): string => {
  const trimmed = gateway.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
};

export const buildGatewayUrl = (gateway: string, cid: string): string => {
  return `${normalizeGatewayBase(gateway)}${cid}`;
};

const uniqueGateways = (list: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of list) {
    const gateway = normalizeGatewayBase(raw);
    if (!gateway) {
      continue;
    }
    const key = gateway.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(gateway);
  }
  return result;
};

const parseExtraGateways = (raw: string | undefined): string[] => {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

export const resolveGatewayPool = (input?: {
  primary?: string;
  extras?: string[];
}): string[] => {
  const primary =
    input?.primary ??
    (typeof import.meta.env.VITE_IPFS_GATEWAY === "string"
      ? import.meta.env.VITE_IPFS_GATEWAY
      : undefined);
  const extras =
    input?.extras ??
    parseExtraGateways(
      typeof import.meta.env.VITE_IPFS_FALLBACK_GATEWAYS === "string"
        ? import.meta.env.VITE_IPFS_FALLBACK_GATEWAYS
        : undefined
    );
  const pool = uniqueGateways([
    primary || DEFAULT_IPFS_GATEWAYS[0],
    ...DEFAULT_IPFS_GATEWAYS,
    ...extras,
  ]);
  return pool.length > 0 ? pool : [...DEFAULT_IPFS_GATEWAYS];
};

const isRetryableStatus = (status: number): boolean => {
  return status === 408 || status === 425 || status === 429 || status >= 500;
};

const shouldTripCircuit = (status: number): boolean => {
  return isRetryableStatus(status) || status === 401 || status === 403;
};

const combineAbortSignals = (signals: AbortSignal[]): AbortSignal => {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abort();
      return controller.signal;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
};

const readPositiveNumber = (
  value: number | undefined,
  fallback: number
): number => {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
};

export const createIpfsGatewayClient = (
  options: IpfsGatewayClientOptions = {}
): IpfsGatewayClient => {
  const pool = uniqueGateways(
    options.gateways ??
      resolveGatewayPool({
        primary: options.primary,
        extras: options.extras,
      })
  );
  const gateways = pool.length > 0 ? pool : [...DEFAULT_IPFS_GATEWAYS];
  const timeoutMs = readPositiveNumber(
    options.timeoutMs,
    DEFAULT_GATEWAY_TIMEOUT_MS
  );
  const cooldownMs = readPositiveNumber(
    options.cooldownMs,
    DEFAULT_CIRCUIT_COOLDOWN_MS
  );
  const failureThreshold = readPositiveNumber(
    options.failureThreshold,
    DEFAULT_FAILURE_THRESHOLD
  );
  const fetchFn: FetchFn =
    options.fetchFn ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;

  const circuits = new Map<string, CircuitRecord>();

  const getRecord = (gateway: string): CircuitRecord => {
    return circuits.get(gateway) ?? { consecutiveFailures: 0, openedUntil: 0 };
  };

  const isCircuitOpen = (gateway: string, timestamp: number): boolean => {
    return getRecord(gateway).openedUntil > timestamp;
  };

  const selectGateways = (timestamp: number): string[] => {
    const healthy = gateways.filter(
      (gateway) => !isCircuitOpen(gateway, timestamp)
    );
    return healthy.length > 0 ? healthy : [...gateways];
  };

  const recordSuccess = (gateway: string): void => {
    circuits.set(gateway, { consecutiveFailures: 0, openedUntil: 0 });
  };

  const recordFailure = (gateway: string, timestamp: number): void => {
    const record = getRecord(gateway);
    const consecutiveFailures = record.consecutiveFailures + 1;
    const openedUntil =
      consecutiveFailures >= failureThreshold
        ? timestamp + cooldownMs
        : record.openedUntil;
    circuits.set(gateway, { consecutiveFailures, openedUntil });
  };

  const getURL = (hash: string): string => {
    const cid = normalizeIpfsCid(hash);
    return buildGatewayUrl(gateways[0], cid);
  };

  const getGatewayPool = (): string[] => [...gateways];

  const resetCircuits = (): void => {
    circuits.clear();
  };

  const getCircuitState = (gateway: string): GatewayCircuitState => {
    const record = getRecord(normalizeGatewayBase(gateway) || gateway);
    const timestamp = now();
    if (record.openedUntil > timestamp) {
      return "open";
    }
    if (record.openedUntil > 0 && record.consecutiveFailures > 0) {
      return "half-open";
    }
    return "closed";
  };

  const fetchOne = async (
    gateway: string,
    cid: string,
    parentSignal: AbortSignal,
    init?: RequestInit
  ): Promise<
    | { ok: true; response: Response }
    | { ok: false; detail: string; trip: boolean }
  > => {
    if (parentSignal.aborted) {
      return { ok: false, detail: "aborted", trip: false };
    }

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
    const combinedSignal = combineAbortSignals([
      parentSignal,
      timeoutController.signal,
    ]);
    const restInit = { ...(init ?? {}) };
    delete (restInit as { signal?: AbortSignal }).signal;

    try {
      const response = await fetchFn(buildGatewayUrl(gateway, cid), {
        ...restInit,
        method: "GET",
        signal: combinedSignal,
      });
      if (response.ok) {
        return { ok: true, response };
      }
      return {
        ok: false,
        detail: `HTTP ${response.status}`,
        trip: shouldTripCircuit(response.status),
      };
    } catch (error) {
      const timedOut =
        timeoutController.signal.aborted && !parentSignal.aborted;
      if (timedOut) {
        return { ok: false, detail: "timeout", trip: true };
      }
      if (parentSignal.aborted) {
        return { ok: false, detail: "aborted", trip: false };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, detail: message || "network error", trip: true };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const fetchFile = async (
    hash: string,
    init?: RequestInit
  ): Promise<Response> => {
    const cid = normalizeIpfsCid(hash);
    if (!cid) {
      throw new Error("IPFS CID is required");
    }

    if (init?.signal?.aborted) {
      throw init.signal.reason instanceof Error
        ? init.signal.reason
        : new DOMException("The operation was aborted.", "AbortError");
    }

    const parentController = new AbortController();
    const candidates = selectGateways(now());
    const failures: string[] = [];
    let pending = candidates.length;
    let settled = false;
    let settleReject: ((reason: unknown) => void) | undefined;

    const onExternalAbort = () => {
      parentController.abort();
      if (!settled && settleReject) {
        settled = true;
        settleReject(
          new DOMException("The operation was aborted.", "AbortError")
        );
      }
    };

    if (init?.signal) {
      init.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      return await new Promise<Response>((resolve, reject) => {
        settleReject = reject;

        const failOne = (
          gateway: string,
          detail: string,
          trip: boolean
        ): void => {
          if (settled) {
            return;
          }
          failures.push(`${gateway} -> ${detail}`);
          if (trip) {
            recordFailure(gateway, now());
          }
          pending -= 1;
          if (pending === 0) {
            settled = true;
            reject(new IpfsGatewayFetchError(cid, failures));
          }
        };

        for (const gateway of candidates) {
          void fetchOne(gateway, cid, parentController.signal, init).then(
            (result) => {
              if (settled) {
                return;
              }
              if (result.ok) {
                settled = true;
                recordSuccess(gateway);
                parentController.abort();
                resolve(result.response);
                return;
              }
              failOne(gateway, result.detail, result.trip);
            }
          );
        }
      });
    } finally {
      if (init?.signal) {
        init.signal.removeEventListener("abort", onExternalAbort);
      }
    }
  };

  return {
    getURL,
    getGatewayPool,
    fetchFile,
    resetCircuits,
    getCircuitState,
  };
};

const readEnvTimeoutMs = (): number => {
  const raw = Number(import.meta.env.VITE_IPFS_GATEWAY_TIMEOUT_MS);
  return readPositiveNumber(raw, DEFAULT_GATEWAY_TIMEOUT_MS);
};

export const ipfsGateway = createIpfsGatewayClient({
  timeoutMs: readEnvTimeoutMs(),
});
