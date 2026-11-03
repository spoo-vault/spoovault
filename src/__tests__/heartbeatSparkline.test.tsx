// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  DAY_SECONDS,
  HEARTBEAT_WINDOW_SECONDS,
  computeHeartbeatSparkline,
  computeIntervalPunctuality,
  extractHeartbeatTimestampsFromActivities,
  readStoredHeartbeats,
  recordStoredHeartbeat,
} from "../utils/heartbeatSparkline";
import { HeartbeatSparkline } from "../components/analytics/HeartbeatSparkline";
import type { ActivityEvent } from "../services/contract.service";

const BASE_NOW = 1_760_000_000;
const THIRTY_DAYS = 30 * DAY_SECONDS;

const storageBacking: Record<string, string> = {};
const localStorageShim: Storage = {
  get length() {
    return Object.keys(storageBacking).length;
  },
  clear: () => {
    Object.keys(storageBacking).forEach((k) => delete storageBacking[k]);
  },
  getItem: (key: string) => storageBacking[key] ?? null,
  key: (index: number) => Object.keys(storageBacking)[index] ?? null,
  removeItem: (key: string) => {
    delete storageBacking[key];
  },
  setItem: (key: string, value: string) => {
    storageBacking[key] = String(value);
  },
};

describe("heartbeatSparkline utilities & SVG component", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      value: localStorageShim,
      configurable: true,
      writable: true,
    });
    localStorageShim.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("handles 0 samples without producing NaN or Infinity", () => {
    const model = computeHeartbeatSparkline({
      timestamps: [],
      inactivityPeriod: 0,
      now: BASE_NOW,
    });

    expect(model.status).toBe("insufficient-data");
    expect(model.consistencyScore).toBe(0);
    expect(model.checkInCount).toBe(0);
    expect(model.points).toHaveLength(0);
    expect(model.segments).toHaveLength(0);
    expect(Number.isFinite(model.baselineY)).toBe(true);
    expect(Number.isFinite(model.closeCallThresholdY)).toBe(true);
  });

  it("handles a single fresh sample gracefully without division-by-zero NaN", () => {
    const model = computeHeartbeatSparkline({
      timestamps: [BASE_NOW - 3 * DAY_SECONDS],
      inactivityPeriod: THIRTY_DAYS,
      now: BASE_NOW,
    });

    expect(model.status).toBe("insufficient-data");
    expect(model.consistencyScore).toBe(0);
    expect(model.points).toHaveLength(1);
    expect(Number.isFinite(model.points[0].x)).toBe(true);
    expect(Number.isFinite(model.points[0].y)).toBe(true);
    expect(Number.isNaN(model.points[0].x)).toBe(false);
    expect(Number.isNaN(model.points[0].y)).toBe(false);
  });

  it("classifies regular check-ins across 12 months as consistent", () => {
    const timestamps: number[] = [
      BASE_NOW - HEARTBEAT_WINDOW_SECONDS - 120 * DAY_SECONDS, // old gap outside 12m window ignored
      BASE_NOW - HEARTBEAT_WINDOW_SECONDS - 10 * DAY_SECONDS,
    ];
    for (let dayOffset = 360; dayOffset >= 15; dayOffset -= 15) {
      timestamps.push(BASE_NOW - dayOffset * DAY_SECONDS);
    }
    timestamps.push(BASE_NOW - 2 * DAY_SECONDS);

    const model = computeHeartbeatSparkline({
      timestamps,
      inactivityPeriod: THIRTY_DAYS,
      now: BASE_NOW,
    });

    expect(model.status).toBe("consistent");
    expect(model.consistencyScore).toBeGreaterThanOrEqual(75);
    expect(model.gapCount).toBe(0);
    expect(model.closeCallCount).toBe(0);
    expect(model.points.every((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y))).toBe(true);
  });

  it("flags near-expiration close calls and missed-deadline gaps as irregular", () => {
    const t0 = BASE_NOW - 80 * DAY_SECONDS;
    const t1 = t0 + 10 * DAY_SECONDS; // normal (10d / 30d)
    const t2 = t1 + 26 * DAY_SECONDS; // close call (26d / 30d = 0.87 >= 0.75)
    const t3 = t2 + 36 * DAY_SECONDS; // gap (36d / 30d = 1.20 >= 1.0)
    const t4 = t3 + 6 * DAY_SECONDS; // recovered recently (2d ago)

    const model = computeHeartbeatSparkline({
      timestamps: [t0, t1, t2, t3, t4],
      inactivityPeriod: THIRTY_DAYS,
      now: BASE_NOW,
    });

    expect(model.status).toBe("irregular");
    expect(model.closeCallCount).toBe(1);
    expect(model.gapCount).toBe(1);
    expect(model.segments.some((seg) => seg.isCloseCall)).toBe(true);
    expect(model.segments.some((seg) => seg.isGap)).toBe(true);
  });

  it("detects overdue vaults when elapsed time exceeds inactivity period or emergency mode is active", () => {
    const overdueModel = computeHeartbeatSparkline({
      vaultCreatedAt: BASE_NOW - 45 * DAY_SECONDS,
      lastProofOfLife: BASE_NOW - 34 * DAY_SECONDS,
      inactivityPeriod: THIRTY_DAYS,
      now: BASE_NOW,
    });

    expect(overdueModel.status).toBe("overdue");
    expect(overdueModel.gapCount).toBeGreaterThanOrEqual(1);

    const emergencyModel = computeHeartbeatSparkline({
      timestamps: [BASE_NOW - 2 * DAY_SECONDS],
      inactivityPeriod: THIRTY_DAYS,
      emergencyMode: true,
      now: BASE_NOW,
    });

    expect(emergencyModel.status).toBe("overdue");
    expect(emergencyModel.consistencyScore).toBe(0);
  });

  it("computes bounded interval punctuality across all utilization bands", () => {
    expect(computeIntervalPunctuality(-1)).toBe(100);
    expect(computeIntervalPunctuality(0)).toBe(100);
    expect(computeIntervalPunctuality(0.375)).toBe(88);
    expect(computeIntervalPunctuality(0.75)).toBe(75);
    expect(computeIntervalPunctuality(0.875)).toBe(50);
    expect(computeIntervalPunctuality(1.0)).toBe(25);
    expect(computeIntervalPunctuality(2.0)).toBe(0);
  });

  it("extracts vault-matching heartbeat events and persists deduplicated local samples", () => {
    const activities: ActivityEvent[] = [
      {
        action: "Proof-of-life recorded for Vault #7",
        actor: "0xabc",
        timestamp: BASE_NOW - 20 * DAY_SECONDS,
        status: "success",
      },
      {
        action: "Proof-of-life recorded for Vault #9",
        actor: "0xabc",
        timestamp: BASE_NOW - 15 * DAY_SECONDS,
        status: "success",
      },
      {
        action: "Document Added",
        actor: "0xabc",
        timestamp: BASE_NOW - 10 * DAY_SECONDS,
        status: "success",
      },
      {
        action: "Heartbeat relayed",
        actor: "0xabc",
        timestamp: BASE_NOW - 5 * DAY_SECONDS,
        status: "success",
      },
    ];

    const extracted = extractHeartbeatTimestampsFromActivities(activities, 7);
    expect(extracted).toEqual([
      BASE_NOW - 20 * DAY_SECONDS,
      BASE_NOW - 5 * DAY_SECONDS,
    ]);

    recordStoredHeartbeat("stellar:testnet:7", BASE_NOW - 100);
    recordStoredHeartbeat("stellar:testnet:7", BASE_NOW - 80); // within 60s dedupe window
    const stored = readStoredHeartbeats("stellar:testnet:7");
    expect(stored).toEqual([BASE_NOW - 80]);
  });

  it("renders accessible WAI-ARIA SVG with title, desc, and visual gap/close-call markers", () => {
    const t0 = BASE_NOW - 70 * DAY_SECONDS;
    const t1 = t0 + 25 * DAY_SECONDS; // close call
    const t2 = t1 + 35 * DAY_SECONDS; // gap
    const t3 = t2 + 8 * DAY_SECONDS;

    const { container } = render(
      <HeartbeatSparkline
        vaultName="Estate Vault"
        timestamps={[t0, t1, t2, t3]}
        inactivityPeriod={THIRTY_DAYS}
        now={BASE_NOW}
      />
    );

    const svg = screen.getByRole("img", {
      name: /Estate Vault 12-month heartbeat consistency/i,
    });
    expect(svg).toBeInTheDocument();

    const labelledBy = svg.getAttribute("aria-labelledby") || "";
    const ids = labelledBy.split(" ").filter(Boolean);
    expect(ids).toHaveLength(2);

    const titleEl = document.getElementById(ids[0]);
    const descEl = document.getElementById(ids[1]);
    expect(titleEl?.textContent).toContain("Estate Vault");
    expect(descEl?.textContent).toContain("overdue gap");
    expect(descEl?.textContent).toContain("near-expiration close call");

    expect(container.querySelector('[data-sparkline-gap="true"]')).toBeTruthy();
    expect(
      container.querySelector('[data-sparkline-close-call="true"]')
    ).toBeTruthy();
  });

  it("respects prefers-reduced-motion by disabling pulse animations", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    const { container } = render(
      <HeartbeatSparkline
        vaultName="Quiet Vault"
        timestamps={[
          BASE_NOW - 25 * DAY_SECONDS,
          BASE_NOW - 15 * DAY_SECONDS,
          BASE_NOW - 5 * DAY_SECONDS,
        ]}
        inactivityPeriod={THIRTY_DAYS}
        now={BASE_NOW}
      />
    );

    const wrapper = screen.getByTestId("heartbeat-sparkline");
    expect(wrapper).toHaveAttribute("data-reduced-motion", "true");
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });
});
