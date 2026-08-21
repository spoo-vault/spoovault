import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SessionLockManager,
  clampIdleTimeout,
  zeroKeyBuffer,
  MIN_IDLE_MS,
  MAX_IDLE_MS,
  DEFAULT_IDLE_MS,
  type SessionLockPlatform,
} from "../services/sessionLock.service";
import { clientKeyringService } from "../services/clientKeyring.service";

const testAccount = "0x71C838936352937A71E976BBE84e941E79409932";

function makeFakePlatform() {
  const added: string[] = [];
  const removed: string[] = [];
  const handlers = new Map<string, () => void>();
  let visibility: "visible" | "hidden" = "visible";
  let timers: { id: number; fn: () => void }[] = [];
  let nextId = 1;

  const platform: SessionLockPlatform = {
    addEventListener: (_t, type, handler) => {
      added.push(type);
      handlers.set(type, handler);
    },
    removeEventListener: (_t, type, _handler) => {
      removed.push(type);
      handlers.delete(type);
    },
    getVisibilityState: () => visibility,
    getRandomValues: (buf) => {
      for (let i = 0; i < buf.length; i++) buf[i] = 0;
      return buf;
    },
    setTimeout: (fn) => {
      const id = nextId++;
      timers.push({ id, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id) => {
      timers = timers.filter((t) => t.id !== (id as unknown as number));
    },
  };

  return {
    platform,
    added,
    removed,
    setVisibility: (v: "visible" | "hidden") => {
      visibility = v;
    },
    fireEvent: (type: string) => handlers.get(type)?.(),
    fireIdleTimer: () => {
      const t = timers[0];
      if (t) t.fn();
    },
    hasPendingTimer: () => timers.length > 0,
  };
}

describe("clampIdleTimeout", () => {
  it("clamps below the 1 minute minimum", () => {
    expect(clampIdleTimeout(1000)).toBe(MIN_IDLE_MS);
  });
  it("clamps above the 15 minute maximum", () => {
    expect(clampIdleTimeout(999_999_999)).toBe(MAX_IDLE_MS);
  });
  it("passes through a value inside the range", () => {
    expect(clampIdleTimeout(3 * 60_000)).toBe(3 * 60_000);
  });
  it("defaults when not a finite number", () => {
    expect(clampIdleTimeout(undefined)).toBe(DEFAULT_IDLE_MS);
    expect(clampIdleTimeout(NaN)).toBe(DEFAULT_IDLE_MS);
  });
});

describe("zeroKeyBuffer", () => {
  it("overwrites buffer contents via the platform", () => {
    const fake = makeFakePlatform();
    const buf = new Uint8Array([1, 2, 3, 4, 5]);
    zeroKeyBuffer(buf, fake.platform);
    expect(Array.from(buf)).toEqual([0, 0, 0, 0, 0]);
  });

  it("is a no-op for empty buffers", () => {
    const fake = makeFakePlatform();
    expect(() => zeroKeyBuffer(new Uint8Array(0), fake.platform)).not.toThrow();
  });
});

describe("SessionLockManager", () => {
  let fake: ReturnType<typeof makeFakePlatform>;

  beforeEach(async () => {
    clientKeyringService.clearSessionCache();
    await clientKeyringService.deleteKeyPair(testAccount);
    await clientKeyringService.generateAndSaveKeyPair(testAccount); // unlocks session cache
    fake = makeFakePlatform();
  });

  it("registers activity/visibility/blur listeners on start and removes them on stop", () => {
    const mgr = new SessionLockManager({
      accountsProvider: () => [testAccount],
      platform: fake.platform,
    });
    mgr.start();
    expect(fake.added).toContain("mousemove");
    expect(fake.added).toContain("visibilitychange");
    expect(fake.added).toContain("blur");
    expect(mgr.isRunning).toBe(true);

    mgr.stop();
    expect(fake.removed).toEqual(expect.arrayContaining(fake.added));
    expect(mgr.isRunning).toBe(false);
  });

  it("resets the idle timer when activity occurs", () => {
    const mgr = new SessionLockManager({
      idleTimeoutMs: 5 * 60_000,
      accountsProvider: () => [testAccount],
      platform: fake.platform,
    });
    mgr.start();
    expect(fake.hasPendingTimer()).toBe(true);
    fake.fireEvent("mousemove"); // simulates user activity
    // a fresh timer should be scheduled after the reset
    expect(fake.hasPendingTimer()).toBe(true);
    mgr.stop();
  });

  it("purges keys and fires onLock after the idle timeout elapses", () => {
    const onLock = vi.fn();
    const mgr = new SessionLockManager({
      idleTimeoutMs: 5 * 60_000,
      accountsProvider: () => [testAccount],
      onLock,
      platform: fake.platform,
    });
    mgr.start();
    expect(clientKeyringService.isUnlocked(testAccount)).toBe(true);

    fake.fireIdleTimer(); // simulate the idle countdown completing

    expect(onLock).toHaveBeenCalledWith([testAccount]);
    expect(clientKeyringService.isUnlocked(testAccount)).toBe(false);
    expect(mgr.isRunning).toBe(false); // auto-stops after locking
  });

  it("purges keys immediately on visibilitychange to hidden", () => {
    const onLock = vi.fn();
    const mgr = new SessionLockManager({
      accountsProvider: () => [testAccount],
      onLock,
      platform: fake.platform,
    });
    mgr.start();
    fake.setVisibility("hidden");
    fake.fireEvent("visibilitychange");
    expect(onLock).toHaveBeenCalledWith([testAccount]);
    expect(clientKeyringService.isUnlocked(testAccount)).toBe(false);
  });

  it("purges keys immediately on window blur", () => {
    const onLock = vi.fn();
    const mgr = new SessionLockManager({
      accountsProvider: () => [testAccount],
      onLock,
      platform: fake.platform,
    });
    mgr.start();
    fake.fireEvent("blur");
    expect(onLock).toHaveBeenCalledWith([testAccount]);
    expect(clientKeyringService.isUnlocked(testAccount)).toBe(false);
  });

  it("lockNow() purges the cache and reports unlocked accounts", () => {
    const onLock = vi.fn();
    const mgr = new SessionLockManager({
      accountsProvider: () => [testAccount],
      onLock,
      platform: fake.platform,
    });
    mgr.start();
    mgr.lockNow();
    expect(onLock).toHaveBeenCalledWith([testAccount]);
    expect(clientKeyringService.isUnlocked(testAccount)).toBe(false);
  });
});
