import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TTLCache } from '../ttlCache';

describe('TTLCache', () => {
  let cache: TTLCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new TTLCache(10);
  });

  it('should call fetchFn on initial call and cache the result', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ vaultId: '123' });

    const res1 = await cache.fetch('getVault:123', fetchFn);
    const res2 = await cache.fetch('getVault:123', fetchFn);

    expect(res1).toEqual({ vaultId: '123' });
    expect(res2).toEqual({ vaultId: '123' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('should refetch after TTL expires (10s)', async () => {
    const fetchFn = vi.fn().mockResolvedValue('active');

    await cache.fetch('hasActiveAccess:user1', fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Advance time by 9 seconds (still valid)
    vi.advanceTimersByTime(9000);
    await cache.fetch('hasActiveAccess:user1', fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Advance past 10 seconds total (expired)
    vi.advanceTimersByTime(2000);
    await cache.fetch('hasActiveAccess:user1', fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('should invalidate cache when manually cleared', async () => {
    const fetchFn = vi.fn().mockResolvedValue('data');

    await cache.fetch('key1', fetchFn);
    cache.clear('key1');
    await cache.fetch('key1', fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
