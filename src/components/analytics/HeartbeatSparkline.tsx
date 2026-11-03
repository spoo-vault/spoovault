import { useId, useMemo } from "react";
import * as framerMotion from "framer-motion";
import {
  computeHeartbeatSparkline,
  type HeartbeatConsistencyStatus,
  type HeartbeatSparklineInput,
} from "../../utils/heartbeatSparkline";

export interface HeartbeatSparklineProps extends HeartbeatSparklineInput {
  compact?: boolean;
  className?: string;
}

const STATUS_STROKE: Record<HeartbeatConsistencyStatus, string> = {
  consistent: "#34d399",
  irregular: "#fbbf24",
  overdue: "#fb7185",
  "insufficient-data": "#94a3b8",
};

const STATUS_BADGE_CLASS: Record<HeartbeatConsistencyStatus, string> = {
  consistent:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  irregular:
    "border-amber-500/30 bg-amber-500/10 text-amber-300",
  overdue:
    "border-rose-500/35 bg-rose-500/12 text-rose-300",
  "insufficient-data":
    "border-gray-700/80 bg-gray-800/60 text-gray-400",
};

const useSafeReducedMotion = (): boolean => {
  let hookPrefers = false;
  try {
    const hook = (
      framerMotion as unknown as { useReducedMotion?: () => boolean | null }
    ).useReducedMotion;
    if (typeof hook === "function") {
      hookPrefers = Boolean(hook());
    }
  } catch {
    hookPrefers = false;
  }

  if (hookPrefers) {
    return true;
  }

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      return Boolean(
        window.matchMedia("(prefers-reduced-motion: reduce)")?.matches
      );
    } catch {
      return false;
    }
  }
  return false;
};

export const HeartbeatSparkline = ({
  compact = false,
  className = "",
  width = compact ? 96 : 132,
  height = compact ? 24 : 30,
  ...sparklineInput
}: HeartbeatSparklineProps) => {
  const rawId = useId();
  const safeId = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const titleId = `hb-sparkline-title-${safeId}`;
  const descId = `hb-sparkline-desc-${safeId}`;
  const gradientId = `hb-sparkline-grad-${safeId}`;

  const prefersReducedMotion = useSafeReducedMotion();

  const model = useMemo(
    () =>
      computeHeartbeatSparkline({
        ...sparklineInput,
        width,
        height,
      }),
    [
      sparklineInput.timestamps,
      sparklineInput.activities,
      sparklineInput.vaultId,
      sparklineInput.vaultName,
      sparklineInput.vaultCreatedAt,
      sparklineInput.lastProofOfLife,
      sparklineInput.inactivityPeriod,
      sparklineInput.emergencyMode,
      sparklineInput.postDeathUnlocked,
      sparklineInput.now,
      sparklineInput.windowSeconds,
      sparklineInput.paddingX,
      sparklineInput.paddingY,
      width,
      height,
    ]
  );

  const primaryStroke = STATUS_STROKE[model.status];
  const latestPoint =
    model.points.length > 0 ? model.points[model.points.length - 1] : null;
  const chartTitle = sparklineInput.vaultName
    ? `${sparklineInput.vaultName} 12-month heartbeat consistency: ${model.summaryLabel}`
    : `12-month heartbeat consistency: ${model.summaryLabel}`;

  const alertChipText =
    model.gapCount > 0
      ? `${model.gapCount} ${model.gapCount === 1 ? "gap" : "gaps"}`
      : model.closeCallCount > 0
      ? `${model.closeCallCount} close ${
          model.closeCallCount === 1 ? "call" : "calls"
        }`
      : null;

  return (
    <div
      className={`flex items-center justify-between gap-2.5 ${className}`.trim()}
      data-testid="heartbeat-sparkline"
      data-status={model.status}
      data-reduced-motion={prefersReducedMotion ? "true" : "false"}
    >
      {!compact && (
        <div className="min-w-0 flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] font-medium text-gray-300">
              12m Heartbeat
            </span>
            <span
              className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none ${
                STATUS_BADGE_CLASS[model.status]
              }`}
            >
              {model.summaryLabel}
            </span>
          </div>
          {alertChipText && (
            <span
              className={`text-[10px] ${
                model.gapCount > 0 ? "text-rose-300/90" : "text-amber-300/90"
              }`}
            >
              {alertChipText} highlighted
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 flex-shrink-0">
        {compact && (
          <span
            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none ${
              STATUS_BADGE_CLASS[model.status]
            }`}
          >
            {model.summaryLabel}
          </span>
        )}

        <svg
          width={model.width}
          height={model.height}
          viewBox={`0 0 ${model.width} ${model.height}`}
          role="img"
          aria-labelledby={`${titleId} ${descId}`}
          className="overflow-visible flex-shrink-0 select-none"
        >
          <title id={titleId}>{chartTitle}</title>
          <desc id={descId}>{model.accessibleDescription}</desc>

          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={primaryStroke} stopOpacity="0.24" />
              <stop offset="100%" stopColor={primaryStroke} stopOpacity="0" />
            </linearGradient>
          </defs>

          <line
            x1={4}
            y1={model.closeCallThresholdY}
            x2={model.width - 4}
            y2={model.closeCallThresholdY}
            stroke="rgba(148, 163, 184, 0.22)"
            strokeWidth={1}
            strokeDasharray="2 2"
          />

          {model.segments.length === 0 ? (
            <>
              <line
                x1={4}
                y1={latestPoint ? latestPoint.y : model.baselineY}
                x2={model.width - 4}
                y2={latestPoint ? latestPoint.y : model.baselineY}
                stroke={primaryStroke}
                strokeOpacity={0.55}
                strokeWidth={1.5}
                strokeDasharray="3 3"
                data-sparkline-baseline="true"
              />
              {latestPoint && (
                <circle
                  cx={latestPoint.x}
                  cy={latestPoint.y}
                  r={2.5}
                  fill={primaryStroke}
                />
              )}
            </>
          ) : (
            <>
              {model.areaPath && (
                <path d={model.areaPath} fill={`url(#${gradientId})`} />
              )}

              {model.segments.map((seg, idx) => {
                const segColor = seg.isGap
                  ? "#fb7185"
                  : seg.isCloseCall
                  ? "#fbbf24"
                  : primaryStroke;

                return (
                  <line
                    key={idx}
                    x1={seg.x1}
                    y1={seg.y1}
                    x2={seg.x2}
                    y2={seg.y2}
                    stroke={segColor}
                    strokeWidth={seg.isGap || seg.isCloseCall ? 2 : 1.75}
                    strokeLinecap="round"
                    strokeDasharray={seg.isGap ? "3 2" : undefined}
                    data-sparkline-gap={seg.isGap ? "true" : undefined}
                    data-sparkline-close-call={
                      seg.isCloseCall ? "true" : undefined
                    }
                  />
                );
              })}

              {model.points.map((pt) => {
                const isLatest = latestPoint?.index === pt.index;
                if (!pt.isGap && !pt.isCloseCall && !isLatest) {
                  return null;
                }

                const dotColor = pt.isGap
                  ? "#fb7185"
                  : pt.isCloseCall
                  ? "#fbbf24"
                  : primaryStroke;

                return (
                  <g key={pt.index}>
                    {isLatest &&
                      !prefersReducedMotion &&
                      (model.status === "overdue" ||
                        model.status === "consistent") && (
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={4.5}
                          fill={dotColor}
                          fillOpacity={0.22}
                          className="animate-pulse"
                        />
                      )}
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r={pt.isGap || pt.isCloseCall || isLatest ? 2.6 : 2}
                      fill={dotColor}
                      stroke="#090d16"
                      strokeWidth={1}
                      data-point-alert={
                        pt.isGap
                          ? "gap"
                          : pt.isCloseCall
                          ? "close-call"
                          : undefined
                      }
                    />
                  </g>
                );
              })}
            </>
          )}
        </svg>
      </div>
    </div>
  );
};

export default HeartbeatSparkline;
