import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TtlCache } from '../utils/ttlCache';

describe('TtlCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves repeated calls within the TTL window from cache without re-invoking the fetcher', async () => {
    const fetcher = vi.fn().mockResolvedValue('value-1');
    const cache = new TtlCache<string>(10_000);

    const first = await cache.getOrFetch('key', fetcher);
    const second = await cache.getOrFetch('key', fetcher);

    expect(first).toBe('value-1');
    expect(second).toBe('value-1');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('issues a fresh call once the TTL has expired', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('value-1').mockResolvedValueOnce('value-2');
    const cache = new TtlCache<string>(10_000);

    const first = await cache.getOrFetch('key', fetcher);
    expect(first).toBe('value-1');

    vi.advanceTimersByTime(9_999);
    const stillCached = await cache.getOrFetch('key', fetcher);
    expect(stillCached).toBe('value-1');
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2);
    const fresh = await cache.getOrFetch('key', fetcher);
    expect(fresh).toBe('value-2');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent in-flight calls for the same key into a single fetcher invocation', async () => {
    let resolveFetch: (value: string) => void = () => {};
    const fetcher = vi.fn().mockImplementation(
      () => new Promise<string>((resolve) => { resolveFetch = resolve; })
    );
    const cache = new TtlCache<string>(10_000);

    const callA = cache.getOrFetch('key', fetcher);
    const callB = cache.getOrFetch('key', fetcher);
    const callC = cache.getOrFetch('key', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch('shared-value');
    const [a, b, c] = await Promise.all([callA, callB, callC]);

    expect(a).toBe('shared-value');
    expect(b).toBe('shared-value');
    expect(c).toBe('shared-value');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejected fetch, so the next call retries', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValueOnce('recovered');
    const cache = new TtlCache<string>(10_000);

    await expect(cache.getOrFetch('key', fetcher)).rejects.toThrow('rpc down');
    const result = await cache.getOrFetch('key', fetcher);

    expect(result).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('invalidate() clears only the targeted key', async () => {
    const fetcherA = vi.fn().mockResolvedValue('a-1').mockResolvedValue('a-2');
    const fetcherB = vi.fn().mockResolvedValue('b-1');
    const cache = new TtlCache<string>(10_000);

    await cache.getOrFetch('a', fetcherA);
    await cache.getOrFetch('b', fetcherB);

    cache.invalidate('a');

    await cache.getOrFetch('a', fetcherA);
    await cache.getOrFetch('b', fetcherB);

    expect(fetcherA).toHaveBeenCalledTimes(2);
    expect(fetcherB).toHaveBeenCalledTimes(1);
  });

  it('clear() forces a fresh fetch for every previously cached key', async () => {
    const fetcherA = vi.fn().mockResolvedValue('a');
    const fetcherB = vi.fn().mockResolvedValue('b');
    const cache = new TtlCache<string>(10_000);

    await cache.getOrFetch('a', fetcherA);
    await cache.getOrFetch('b', fetcherB);
    cache.clear();
    await cache.getOrFetch('a', fetcherA);
    await cache.getOrFetch('b', fetcherB);

    expect(fetcherA).toHaveBeenCalledTimes(2);
    expect(fetcherB).toHaveBeenCalledTimes(2);
  });
});
