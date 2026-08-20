/**
 * Generic TTL cache for read-only async calls (e.g. RPC view calls).
 * Dedupes concurrent in-flight requests for the same key so a batch of
 * parallel callers (e.g. Promise.all over many document IDs) issues only
 * one underlying call instead of one per caller.
 */
export class TtlCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(private readonly ttlMs: number) {}

  async getOrFetch(key: string, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.store.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const inFlight = this.pending.get(key);
    if (inFlight) {
      return inFlight;
    }

    const promise = fetcher()
      .then((value) => {
        this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        return value;
      })
      .finally(() => {
        this.pending.delete(key);
      });

    this.pending.set(key, promise);
    return promise;
  }

  invalidate(key: string): void {
    this.store.delete(key);
    this.pending.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.pending.clear();
  }
}
