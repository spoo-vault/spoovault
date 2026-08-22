/**
 * Generic TTL cache for read-only async calls (e.g. RPC view calls).
 * Dedupes concurrent in-flight requests for the same key so a batch of
 * parallel callers (e.g. Promise.all over many document IDs) issues only
 * one underlying call instead of one per caller.
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class TTLCache<T = any> {
  private cache = new Map<string, CacheEntry<T>>();
  private pending = new Map<string, Promise<T>>();
  private ttlMs: number;

  constructor(ttlMsOrSeconds: number = 10) {
    // If <= 1000, treat as seconds; otherwise assume milliseconds
    this.ttlMs =
      ttlMsOrSeconds <= 1000 ? ttlMsOrSeconds * 1000 : ttlMsOrSeconds;
  }

  async fetch<R = T>(key: string, fetchFn: () => Promise<R>): Promise<R> {
    const now = Date.now();
    const entry = this.cache.get(key);

    if (entry && now - entry.timestamp < this.ttlMs) {
      return entry.data as unknown as R;
    }

    const inFlight = this.pending.get(key);
    if (inFlight) {
      return inFlight as unknown as Promise<R>;
    }

    const promise = fetchFn()
      .then((data) => {
        this.cache.set(key, {
          data: data as unknown as T,
          timestamp: Date.now(),
        });
        return data;
      })
      .finally(() => {
        this.pending.delete(key);
      });

    this.pending.set(key, promise as unknown as Promise<T>);
    return promise;
  }

  async getOrFetch<R = T>(key: string, fetcher: () => Promise<R>): Promise<R> {
    return this.fetch(key, fetcher);
  }

  clear(key?: string): void {
    if (key) {
      this.cache.delete(key);
      this.pending.delete(key);
    } else {
      this.cache.clear();
      this.pending.clear();
    }
  }

  invalidate(key: string): void {
    this.clear(key);
  }

  hasValidKey(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    return Date.now() - entry.timestamp < this.ttlMs;
  }
}

export { TTLCache as TtlCache };
export const readViewCache = new TTLCache(10);
