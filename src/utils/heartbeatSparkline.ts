import type { ActivityEvent } from "../services/contract.service";

export type HeartbeatConsistencyStatus =
  | "consistent"
  | "irregular"
  | "overdue"
  | "insufficient-data";

export interface HeartbeatSparklinePoint {
  index: number;
  timestamp: number;
  intervalSeconds: number;
  utilizationRatio: number;
  punctuality: number;
  x: number;
  y: number;
  isCloseCall: boolean;
  isGap: boolean;
  isProjectedNow?: boolean;
}

export interface HeartbeatSparklineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  isCloseCall: boolean;
  isGap: boolean;
}

export interface HeartbeatSparklineModel {
  status: HeartbeatConsistencyStatus;
  consistencyScore: number;
  checkInCount: number;
  intervalCount: number;
  closeCallCount: number;
  gapCount: number;
  lastCheckInAt: number | null;
  inactivityPeriodSeconds: number;
  windowMonths: number;
  width: number;
  height: number;
  baselineY: number;
  closeCallThresholdY: number;
  points: HeartbeatSparklinePoint[];
  segments: HeartbeatSparklineSegment[];
  polylinePoints: string;
  areaPath: string;
  summaryLabel: string;
  accessibleDescription: string;
}

export interface HeartbeatSparklineInput {
  timestamps?: number[];
  activities?: ActivityEvent[];
  vaultId?: number;
  vaultName?: string;
  vaultCreatedAt?: number;
  lastProofOfLife?: number;
  inactivityPeriod?: number;
  emergencyMode?: boolean;
  postDeathUnlocked?: boolean;
  now?: number;
  windowSeconds?: number;
  width?: number;
  height?: number;
  paddingX?: number;
  paddingY?: number;
}

export const DAY_SECONDS = 24 * 60 * 60;
export const DEFAULT_INACTIVITY_PERIOD_SECONDS = 30 * DAY_SECONDS;
export const HEARTBEAT_WINDOW_MONTHS = 12;
export const HEARTBEAT_WINDOW_SECONDS = 365 * DAY_SECONDS;
export const CLOSE_CALL_RATIO_THRESHOLD = 0.75;
export const GAP_RATIO_THRESHOLD = 1.0;
export const HEARTBEAT_HISTORY_STORAGE_KEY = "spoovault-heartbeat-history-v1";

const MAX_STORED_HEARTBEATS_PER_VAULT = 64;
const DEDUPE_TOLERANCE_SECONDS = 60;
const HEARTBEAT_ACTION_PATTERN =
  /proof[-_\s]*of[-_\s]*life|heartbeat|prove[-_\s]*life/i;

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
};

const roundCoord = (value: number, fallback = 0): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.round(value * 100) / 100;
};

export const computeIntervalPunctuality = (utilizationRatio: number): number => {
  if (!Number.isFinite(utilizationRatio) || utilizationRatio <= 0) {
    return 100;
  }
  if (utilizationRatio <= CLOSE_CALL_RATIO_THRESHOLD) {
    const score = 100 - (utilizationRatio / CLOSE_CALL_RATIO_THRESHOLD) * 25;
    return clamp(Math.round(score), 0, 100);
  }
  if (utilizationRatio < GAP_RATIO_THRESHOLD) {
    const progress =
      (utilizationRatio - CLOSE_CALL_RATIO_THRESHOLD) /
      (GAP_RATIO_THRESHOLD - CLOSE_CALL_RATIO_THRESHOLD);
    const score = 75 - progress * 50;
    return clamp(Math.round(score), 0, 100);
  }
  const overdueProgress = (utilizationRatio - GAP_RATIO_THRESHOLD) / 0.5;
  return clamp(Math.round(25 - overdueProgress * 25), 0, 25);
};

export const extractHeartbeatTimestampsFromActivities = (
  activities: ActivityEvent[] | undefined,
  vaultId?: number
): number[] => {
  if (!Array.isArray(activities) || activities.length === 0) {
    return [];
  }

  const timestamps: number[] = [];
  for (const event of activities) {
    if (!event || typeof event.action !== "string") continue;
    if (!HEARTBEAT_ACTION_PATTERN.test(event.action)) continue;

    if (vaultId !== undefined) {
      const vaultTagMatch = event.action.match(/vault\s*#?(\d+)/i);
      if (vaultTagMatch && Number(vaultTagMatch[1]) !== vaultId) {
        continue;
      }
    }

    if (Number.isFinite(event.timestamp) && event.timestamp > 0) {
      timestamps.push(Math.floor(event.timestamp));
    }
  }

  return timestamps;
};

type StoredHeartbeatMap = Record<string, number[]>;

const getSafeStorage = (): Storage | null => {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Node 22 without --localstorage-file or restricted iframe environments
  }
  return null;
};

const readHeartbeatStore = (): StoredHeartbeatMap => {
  const storage = getSafeStorage();
  if (!storage) {
    return {};
  }
  try {
    const raw = storage.getItem(HEARTBEAT_HISTORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as StoredHeartbeatMap;
  } catch {
    return {};
  }
};

export const readStoredHeartbeats = (vaultKey: string): number[] => {
  if (!vaultKey) return [];
  const store = readHeartbeatStore();
  const entries = store[vaultKey];
  if (!Array.isArray(entries)) return [];
  return entries.filter((ts) => Number.isFinite(ts) && ts > 0);
};

export const recordStoredHeartbeat = (
  vaultKey: string,
  timestampSec: number = Math.floor(Date.now() / 1000)
): number[] => {
  if (!vaultKey || !Number.isFinite(timestampSec) || timestampSec <= 0) {
    return [];
  }
  const store = readHeartbeatStore();
  const existing = Array.isArray(store[vaultKey]) ? store[vaultKey] : [];
  const cutoff = Math.floor(timestampSec) - HEARTBEAT_WINDOW_SECONDS;
  const merged = [...existing, Math.floor(timestampSec)]
    .filter((ts) => Number.isFinite(ts) && ts >= cutoff)
    .sort((a, b) => a - b);

  const deduped: number[] = [];
  for (const ts of merged) {
    if (
      deduped.length === 0 ||
      ts - deduped[deduped.length - 1] >= DEDUPE_TOLERANCE_SECONDS
    ) {
      deduped.push(ts);
    } else {
      deduped[deduped.length - 1] = ts;
    }
  }

  const trimmed = deduped.slice(-MAX_STORED_HEARTBEATS_PER_VAULT);
  const storage = getSafeStorage();
  if (storage) {
    try {
      store[vaultKey] = trimmed;
      storage.setItem(
        HEARTBEAT_HISTORY_STORAGE_KEY,
        JSON.stringify(store)
      );
    } catch {
      // Ignore storage quota errors
    }
  }
  return trimmed;
};

const normalizeTimestamps = (
  candidates: number[],
  nowSec: number,
  windowSeconds: number
): { anchorBeforeWindow: number | null; inWindow: number[] } => {
  const valid = candidates
    .filter((ts) => Number.isFinite(ts) && ts > 0 && ts <= nowSec + 60)
    .map((ts) => Math.min(Math.floor(ts), nowSec))
    .sort((a, b) => a - b);

  const deduped: number[] = [];
  for (const ts of valid) {
    if (
      deduped.length === 0 ||
      ts - deduped[deduped.length - 1] >= DEDUPE_TOLERANCE_SECONDS
    ) {
      deduped.push(ts);
    } else {
      deduped[deduped.length - 1] = ts;
    }
  }

  const windowStart = nowSec - windowSeconds;
  let anchorBeforeWindow: number | null = null;
  const inWindow: number[] = [];

  for (const ts of deduped) {
    if (ts < windowStart) {
      anchorBeforeWindow = ts;
    } else {
      inWindow.push(ts);
    }
  }

  return { anchorBeforeWindow, inWindow };
};

const formatElapsedDays = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "today";
  const days = Math.floor(seconds / DAY_SECONDS);
  if (days <= 0) {
    const hours = Math.max(1, Math.floor(seconds / 3600));
    return `${hours}h ago`;
  }
  return `${days}d ago`;
};

export const computeHeartbeatSparkline = (
  input: HeartbeatSparklineInput = {}
): HeartbeatSparklineModel => {
  const safeNow =
    Number.isFinite(input.now) && (input.now as number) > 0
      ? Math.floor(input.now as number)
      : Math.floor(Date.now() / 1000);

  const safePeriod =
    Number.isFinite(input.inactivityPeriod) &&
    (input.inactivityPeriod as number) > 0
      ? Math.floor(input.inactivityPeriod as number)
      : DEFAULT_INACTIVITY_PERIOD_SECONDS;

  const safeWindow =
    Number.isFinite(input.windowSeconds) &&
    (input.windowSeconds as number) > 0
      ? Math.floor(input.windowSeconds as number)
      : HEARTBEAT_WINDOW_SECONDS;

  const width =
    Number.isFinite(input.width) && (input.width as number) >= 24
      ? (input.width as number)
      : 120;
  const height =
    Number.isFinite(input.height) && (input.height as number) >= 16
      ? (input.height as number)
      : 32;
  const paddingX =
    Number.isFinite(input.paddingX) && (input.paddingX as number) >= 0
      ? Math.min(input.paddingX as number, width / 4)
      : 4;
  const paddingY =
    Number.isFinite(input.paddingY) && (input.paddingY as number) >= 0
      ? Math.min(input.paddingY as number, height / 4)
      : 4;

  const innerWidth = Math.max(1, width - paddingX * 2);
  const innerHeight = Math.max(1, height - paddingY * 2);

  const punctualityToY = (punctuality: number): number => {
    const normalized = clamp(punctuality, 0, 100) / 100;
    return roundCoord(paddingY + (1 - normalized) * innerHeight, height / 2);
  };

  const baselineY = roundCoord(paddingY + innerHeight * 0.5, height / 2);
  const closeCallThresholdY = punctualityToY(75);

  const rawCandidates: number[] = [];
  if (Array.isArray(input.timestamps)) {
    rawCandidates.push(...input.timestamps);
  }
  if (Array.isArray(input.activities)) {
    rawCandidates.push(
      ...extractHeartbeatTimestampsFromActivities(
        input.activities,
        input.vaultId
      )
    );
  }
  if (
    Number.isFinite(input.vaultCreatedAt) &&
    (input.vaultCreatedAt as number) > 0
  ) {
    rawCandidates.push(input.vaultCreatedAt as number);
  }
  if (
    Number.isFinite(input.lastProofOfLife) &&
    (input.lastProofOfLife as number) > 0
  ) {
    rawCandidates.push(input.lastProofOfLife as number);
  }

  const { anchorBeforeWindow, inWindow } = normalizeTimestamps(
    rawCandidates,
    safeNow,
    safeWindow
  );

  const sequence =
    anchorBeforeWindow !== null ? [anchorBeforeWindow, ...inWindow] : [...inWindow];
  const checkInCount = inWindow.length;
  const lastCheckInAt =
    sequence.length > 0 ? sequence[sequence.length - 1] : null;
  const forcedOverdue = Boolean(input.emergencyMode || input.postDeathUnlocked);
  const vaultLabel = input.vaultName ? `${input.vaultName} ` : "";

  if (sequence.length === 0) {
    const status: HeartbeatConsistencyStatus = forcedOverdue
      ? "overdue"
      : "insufficient-data";
    const summaryLabel = forcedOverdue ? "Overdue" : "No check-ins yet";
    const accessibleDescription = forcedOverdue
      ? `${vaultLabel}heartbeat status is overdue with no recorded proof-of-life check-ins in the last 12 months.`
      : `${vaultLabel}has no recorded proof-of-life check-ins over the last 12 months.`;

    return {
      status,
      consistencyScore: 0,
      checkInCount: 0,
      intervalCount: 0,
      closeCallCount: 0,
      gapCount: forcedOverdue ? 1 : 0,
      lastCheckInAt: null,
      inactivityPeriodSeconds: safePeriod,
      windowMonths: HEARTBEAT_WINDOW_MONTHS,
      width,
      height,
      baselineY,
      closeCallThresholdY,
      points: [],
      segments: [],
      polylinePoints: "",
      areaPath: "",
      summaryLabel,
      accessibleDescription,
    };
  }

  interface RawSample {
    timestamp: number;
    intervalSeconds: number;
    utilizationRatio: number;
    punctuality: number;
    isCloseCall: boolean;
    isGap: boolean;
    isProjectedNow?: boolean;
  }

  const rawSamples: RawSample[] = [];
  for (let i = 1; i < sequence.length; i += 1) {
    const intervalSeconds = Math.max(0, sequence[i] - sequence[i - 1]);
    const utilizationRatio = intervalSeconds / safePeriod;
    const punctuality = computeIntervalPunctuality(utilizationRatio);
    const isGap = utilizationRatio >= GAP_RATIO_THRESHOLD;
    const isCloseCall =
      !isGap && utilizationRatio >= CLOSE_CALL_RATIO_THRESHOLD;
    rawSamples.push({
      timestamp: sequence[i],
      intervalSeconds,
      utilizationRatio: roundCoord(utilizationRatio, 0),
      punctuality,
      isCloseCall,
      isGap,
    });
  }

  const latestRecordedTs = sequence[sequence.length - 1];
  const currentElapsedSeconds = Math.max(0, safeNow - latestRecordedTs);
  const currentElapsedRatio = currentElapsedSeconds / safePeriod;
  const currentIsGap =
    forcedOverdue || currentElapsedRatio >= GAP_RATIO_THRESHOLD;
  const currentIsCloseCall =
    !currentIsGap && currentElapsedRatio >= CLOSE_CALL_RATIO_THRESHOLD;

  if (
    (currentIsGap || currentIsCloseCall) &&
    (currentElapsedSeconds >= DEDUPE_TOLERANCE_SECONDS || forcedOverdue)
  ) {
    const effectiveRatio = forcedOverdue
      ? Math.max(currentElapsedRatio, GAP_RATIO_THRESHOLD)
      : currentElapsedRatio;
    rawSamples.push({
      timestamp: safeNow,
      intervalSeconds: currentElapsedSeconds,
      utilizationRatio: roundCoord(effectiveRatio, 1),
      punctuality: forcedOverdue
        ? 0
        : computeIntervalPunctuality(effectiveRatio),
      isCloseCall: currentIsCloseCall,
      isGap: currentIsGap,
      isProjectedNow: true,
    });
  }

  if (rawSamples.length === 0) {
    const singlePunctuality = computeIntervalPunctuality(currentElapsedRatio);
    const singlePoint: HeartbeatSparklinePoint = {
      index: 0,
      timestamp: latestRecordedTs,
      intervalSeconds: currentElapsedSeconds,
      utilizationRatio: roundCoord(currentElapsedRatio, 0),
      punctuality: singlePunctuality,
      x: roundCoord(width / 2, 60),
      y: punctualityToY(singlePunctuality),
      isCloseCall: false,
      isGap: false,
    };

    return {
      status: "insufficient-data",
      consistencyScore: 0,
      checkInCount: Math.max(1, checkInCount),
      intervalCount: 0,
      closeCallCount: 0,
      gapCount: 0,
      lastCheckInAt,
      inactivityPeriodSeconds: safePeriod,
      windowMonths: HEARTBEAT_WINDOW_MONTHS,
      width,
      height,
      baselineY,
      closeCallThresholdY,
      points: [singlePoint],
      segments: [],
      polylinePoints: `${singlePoint.x},${singlePoint.y}`,
      areaPath: "",
      summaryLabel: "Baseline armed",
      accessibleDescription: `${vaultLabel}has 1 initial proof-of-life timestamp (${formatElapsedDays(
        currentElapsedSeconds
      )}). Record another heartbeat to establish a consistency trend.`,
    };
  }

  const firstSample = rawSamples[0];
  const anchorPunctuality =
    rawSamples.length === 1 && (firstSample.isGap || firstSample.isCloseCall)
      ? 100
      : firstSample.punctuality;

  const plottedSamples: RawSample[] = [
    {
      timestamp: sequence[0],
      intervalSeconds: 0,
      utilizationRatio: 0,
      punctuality: anchorPunctuality,
      isCloseCall: false,
      isGap: false,
    },
    ...rawSamples,
  ];

  const denom = Math.max(1, plottedSamples.length - 1);
  const points: HeartbeatSparklinePoint[] = plottedSamples.map((sample, idx) => {
    const x = roundCoord(paddingX + (idx / denom) * innerWidth, paddingX);
    const y = punctualityToY(sample.punctuality);
    return {
      index: idx,
      timestamp: sample.timestamp,
      intervalSeconds: sample.intervalSeconds,
      utilizationRatio: sample.utilizationRatio,
      punctuality: sample.punctuality,
      x,
      y,
      isCloseCall: sample.isCloseCall,
      isGap: sample.isGap,
      isProjectedNow: sample.isProjectedNow,
    };
  });

  const segments: HeartbeatSparklineSegment[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    segments.push({
      x1: prev.x,
      y1: prev.y,
      x2: curr.x,
      y2: curr.y,
      isCloseCall: curr.isCloseCall,
      isGap: curr.isGap,
    });
  }

  const closeCallCount = rawSamples.filter((s) => s.isCloseCall).length;
  const gapCount = rawSamples.filter((s) => s.isGap).length;

  const meanPunctuality =
    rawSamples.reduce((sum, s) => sum + s.punctuality, 0) / rawSamples.length;

  let rhythmPenalty = 0;
  if (rawSamples.length >= 2) {
    const meanRatio =
      rawSamples.reduce((sum, s) => sum + s.utilizationRatio, 0) /
      rawSamples.length;
    const variance =
      rawSamples.reduce(
        (sum, s) => sum + (s.utilizationRatio - meanRatio) ** 2,
        0
      ) / rawSamples.length;
    const stdDevRatio = Math.sqrt(Math.max(0, variance));
    rhythmPenalty = clamp(stdDevRatio * 35, 0, 25);
  }

  const incidentPenalty = gapCount * 22 + closeCallCount * 10;
  const rawScore = forcedOverdue
    ? 0
    : Math.round(meanPunctuality - rhythmPenalty - incidentPenalty);
  const consistencyScore = clamp(rawScore, 0, 100);

  let status: HeartbeatConsistencyStatus;
  if (currentIsGap) {
    status = "overdue";
  } else if (gapCount > 0 || closeCallCount > 0 || consistencyScore < 70) {
    status = "irregular";
  } else {
    status = "consistent";
  }

  const polylinePoints = points.map((pt) => `${pt.x},${pt.y}`).join(" ");
  const bottomY = roundCoord(height - paddingY, height);
  const areaPath =
    points.length >= 2
      ? `M ${points[0].x} ${bottomY} ` +
        points.map((pt) => `L ${pt.x} ${pt.y}`).join(" ") +
        ` L ${points[points.length - 1].x} ${bottomY} Z`
      : "";

  const summaryLabel =
    status === "consistent"
      ? `${consistencyScore}% consistent`
      : status === "overdue"
      ? "Overdue"
      : `${consistencyScore}% irregular`;

  const incidentSummaryParts: string[] = [];
  if (gapCount > 0) {
    incidentSummaryParts.push(
      `${gapCount} overdue ${gapCount === 1 ? "gap" : "gaps"}`
    );
  }
  if (closeCallCount > 0) {
    incidentSummaryParts.push(
      `${closeCallCount} near-expiration close ${
        closeCallCount === 1 ? "call" : "calls"
      }`
    );
  }
  const incidentClause =
    incidentSummaryParts.length > 0
      ? ` Detected ${incidentSummaryParts.join(" and ")}.`
      : " No missed deadlines or close calls.";

  const accessibleDescription = `${vaultLabel}heartbeat consistency over the last 12 months is ${status} (${consistencyScore}%), across ${rawSamples.length} check-in ${
    rawSamples.length === 1 ? "interval" : "intervals"
  }.${incidentClause} Last check-in ${formatElapsedDays(currentElapsedSeconds)}.`;

  return {
    status,
    consistencyScore,
    checkInCount,
    intervalCount: rawSamples.length,
    closeCallCount,
    gapCount,
    lastCheckInAt,
    inactivityPeriodSeconds: safePeriod,
    windowMonths: HEARTBEAT_WINDOW_MONTHS,
    width,
    height,
    baselineY,
    closeCallThresholdY,
    points,
    segments,
    polylinePoints,
    areaPath,
    summaryLabel,
    accessibleDescription,
  };
};
