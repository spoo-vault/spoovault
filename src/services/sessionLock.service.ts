import { clientKeyringService } from "./clientKeyring.service";

/**
 * Abstraction over the browser/platform primitives the lock manager depends on.
 * Injecting this makes the manager fully testable without a DOM.
 */
export interface SessionLockPlatform {
  addEventListener(
    target: "window" | "document",
    type: string,
    handler: () => void
  ): void;
  removeEventListener(
    target: "window" | "document",
    type: string,
    handler: () => void
  ): void;
  getVisibilityState(): "visible" | "hidden";
  getRandomValues(buf: Uint8Array): Uint8Array;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout> | null): void;
}

export const defaultPlatform: SessionLockPlatform = {
  addEventListener(target, type, handler) {
    if (typeof window === "undefined") return;
    const el = target === "window" ? window : document;
    el.addEventListener(type, handler as EventListener);
  },
  removeEventListener(target, type, handler) {
    if (typeof window === "undefined") return;
    const el = target === "window" ? window : document;
    el.removeEventListener(type, handler as EventListener);
  },
  getVisibilityState() {
    if (typeof document === "undefined") return "visible";
    return document.visibilityState as "visible" | "hidden";
  },
  getRandomValues(buf) {
    const c =
      (typeof globalThis !== "undefined" && globalThis.crypto) ||
      (typeof window !== "undefined" ? window.crypto : undefined);
    if (!c) throw new Error("Web Crypto is not available");
    return c.getRandomValues(buf);
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => {
    if (id) clearTimeout(id);
  },
};

export const MIN_IDLE_MS = 60_000; // 1 minute
export const MAX_IDLE_MS = 15 * 60_000; // 15 minutes
export const DEFAULT_IDLE_MS = 5 * 60_000; // 5 minutes

export function clampIdleTimeout(ms?: number): number {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return DEFAULT_IDLE_MS;
  return Math.min(MAX_IDLE_MS, Math.max(MIN_IDLE_MS, Math.floor(ms)));
}

/**
 * Overwrite a key buffer's contents with cryptographically random bytes so the
 * original key material cannot be recovered from memory after the reference is
 * released. This satisfies the "memory zeroing" requirement for decrypted keys.
 */
export function zeroKeyBuffer(
  buf: Uint8Array,
  platform: SessionLockPlatform = defaultPlatform
): void {
  if (!buf || buf.length === 0) return;
  platform.getRandomValues(buf);
}

export interface SessionLockOptions {
  /** Idle window in ms; clamped to the 1–15 minute range. */
  idleTimeoutMs?: number;
  /** Returns the accounts that should be purged when the session locks. */
  accountsProvider?: () => string[];
  /** Called after keys are purged; the UI should present the lock screen. */
  onLock?: (accounts: string[]) => void;
  /** Platform abstraction (defaults to the real browser environment). */
  platform?: SessionLockPlatform;
}

const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "click",
  "touchstart",
  "scroll",
  "wheel",
];

/**
 * Automated session-lock and key-cache-purge manager.
 *
 * - Watches user activity and locks after a configurable idle window.
 * - Locks immediately when the tab is hidden (`visibilitychange`) or loses focus
 *   (`window.blur`).
 * - On lock, zeroes the in-memory decrypted key buffers and clears the session
 *   key cache, then invokes `onLock` so the UI can present a re-auth prompt.
 */
export class SessionLockManager {
  private readonly idleTimeoutMs: number;
  private readonly accountsProvider?: () => string[];
  private readonly onLock?: (accounts: string[]) => void;
  private readonly platform: SessionLockPlatform;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  private readonly activityHandler = () => this.resetIdleTimer();
  private readonly visibilityHandler = () => {
    if (this.platform.getVisibilityState() === "hidden") this.lockNow();
  };
  private readonly blurHandler = () => this.lockNow();

  constructor(options: SessionLockOptions = {}) {
    this.idleTimeoutMs = clampIdleTimeout(options.idleTimeoutMs);
    this.accountsProvider = options.accountsProvider;
    this.onLock = options.onLock;
    this.platform = options.platform ?? defaultPlatform;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get idleTimeout(): number {
    return this.idleTimeoutMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const ev of ACTIVITY_EVENTS) {
      this.platform.addEventListener("window", ev, this.activityHandler);
    }
    this.platform.addEventListener(
      "document",
      "visibilitychange",
      this.visibilityHandler
    );
    this.platform.addEventListener("window", "blur", this.blurHandler);
    this.resetIdleTimer();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const ev of ACTIVITY_EVENTS) {
      this.platform.removeEventListener("window", ev, this.activityHandler);
    }
    this.platform.removeEventListener(
      "document",
      "visibilitychange",
      this.visibilityHandler
    );
    this.platform.removeEventListener("window", "blur", this.blurHandler);
    this.clearIdleTimer();
  }

  /** Reset the inactivity countdown; called on every user activity event. */
  resetIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.running) return;
    this.idleTimer = this.platform.setTimeout(
      () => this.lockNow(),
      this.idleTimeoutMs
    );
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      this.platform.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Immediately purge decrypted keys from memory and notify listeners. */
  lockNow(): void {
    const accounts = this.accountsProvider ? this.accountsProvider() : [];
    for (const account of accounts) {
      const bytes = clientKeyringService.getCachedPrivateKeyBytes(account);
      if (bytes) zeroKeyBuffer(bytes, this.platform);
    }
    clientKeyringService.clearSessionCache();
    this.stop();
    this.onLock?.(accounts);
  }
}

/** Convenience singleton for simple app-wide usage. */
export const sessionLockService = new SessionLockManager();
