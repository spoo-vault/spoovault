import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Chip, Skeleton } from "@heroui/react";
import { motion, useReducedMotion } from "framer-motion";
import {
  FiShield,
  FiFile,
  FiUsers,
  FiActivity,
  FiHeart,
  FiAlertTriangle,
  FiCheckCircle,
  FiClock,
  FiRefreshCw,
  FiZap,
  FiArrowUpRight,
  FiInfo,
  FiKey,
} from "react-icons/fi";
import { useWeb3 } from "../context/Web3Context";
import {
  contractService,
  VaultData,
  DocumentData,
  ActivityEvent,
  VaultReleaseState,
} from "../services/contract.service";
import { parseEncryptedMetadataPayload } from "../services/secrets.service";
import { captureError } from "../services/telemetry.service";
import { toast } from "react-hot-toast";
import { buttonClasses } from "../utils/buttonClasses";

const DAY_SECONDS = 24 * 60 * 60;
const ACTIVITY_WINDOW_DAYS = 14;

const glassCard =
  "rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.4)]";

export type HealthGrade = "critical" | "weak" | "fair" | "strong";

export interface SecurityHealth {
  score: number;
  guardianQuorum: number;
  encryptionStrength: number;
  heartbeatFreshness: number;
  grade: HealthGrade;
  recommendations: string[];
}

export const computeSecurityHealth = (
  vaults: VaultData[],
  documents: DocumentData[],
  releaseStates: Record<number, VaultReleaseState>,
  now: number = Math.floor(Date.now() / 1000)
): SecurityHealth => {
  const recommendations: string[] = [];

  const uniqueGuardians = new Set<string>();
  vaults.forEach((vault) =>
    vault.guardians.forEach((guardian) => uniqueGuardians.add(guardian.toLowerCase()))
  );

  // Guardian quorum (0-40): redundancy across vaults + healthy threshold ratios.
  const redundancyScore = Math.min(uniqueGuardians.size / 5, 1) * 20;
  let thresholdPoints = 0;
  let hasSingleApproverThreshold = false;
  let hasDeadlockThreshold = false;
  vaults.forEach((vault) => {
    const count = vault.guardians.length;
    const threshold = vault.approvalThreshold;
    if (count >= 3 && threshold >= 2 && threshold < count) {
      thresholdPoints += 20;
    } else if (threshold >= 2 && count >= 2) {
      thresholdPoints += 10;
      if (threshold >= count) hasDeadlockThreshold = true;
    }
    if (threshold <= 1) hasSingleApproverThreshold = true;
  });
  const thresholdScore = vaults.length > 0 ? Math.min(thresholdPoints / vaults.length, 20) : 0;
  const guardianQuorum = Math.round(redundancyScore + thresholdScore);

  // Encryption strength (0-30): VSS commitment coverage + multi-party access coverage.
  let vssCovered = 0;
  let multiPartyCovered = 0;
  documents.forEach((doc) => {
    if (parseEncryptedMetadataPayload(doc.encryptedMetadata).commitments.length > 0) {
      vssCovered += 1;
    }
    if (doc.requiredAccess >= 2) {
      multiPartyCovered += 1;
    }
  });
  const encryptionStrength =
    documents.length > 0
      ? Math.round(
          (vssCovered / documents.length) * 15 + (multiPartyCovered / documents.length) * 15
        )
      : 0;

  // Heartbeat freshness (0-30): average remaining inactivity window per vault.
  let freshnessPoints = 0;
  let staleVaultCount = 0;
  const heartbeatVaults = vaults.filter((vault) => releaseStates[vault.id]);
  heartbeatVaults.forEach((vault) => {
    const state = releaseStates[vault.id];
    const period = Math.max(state.inactivityPeriod, 1);
    if (state.lastProofOfLife <= 0 || state.emergencyMode) {
      staleVaultCount += 1;
      return;
    }
    const elapsed = Math.max(0, now - state.lastProofOfLife);
    const ratio = Math.min(Math.max((period - elapsed) / period, 0), 1);
    if (ratio < 0.25) staleVaultCount += 1;
    freshnessPoints += ratio * 30;
  });
  const heartbeatFreshness =
    heartbeatVaults.length > 0
      ? Math.round(freshnessPoints / heartbeatVaults.length)
      : 0;

  const score = Math.max(
    0,
    Math.min(100, guardianQuorum + encryptionStrength + heartbeatFreshness)
  );

  if (vaults.length === 0) {
    recommendations.push("Create your first access vault to start building a security baseline.");
  }
  if (uniqueGuardians.size < 3) {
    recommendations.push(
      "Assign at least 3 guardians across your vaults for resilient key sharding."
    );
  }
  if (hasSingleApproverThreshold) {
    recommendations.push(
      "Raise approval thresholds above 1 so a single guardian cannot unlock documents alone."
    );
  }
  if (hasDeadlockThreshold) {
    recommendations.push(
      "Lower thresholds below the guardian count to avoid deadlock if a guardian becomes unreachable."
    );
  }
  if (documents.length > 0 && vssCovered < documents.length) {
    recommendations.push(
      "Re-share documents with verifiable secret sharing (VSS) so guardian shares can be verified."
    );
  }
  if (documents.length > 0 && multiPartyCovered < documents.length) {
    recommendations.push(
      "Require multi-guardian approval on critical documents instead of single-party access."
    );
  }
  if (staleVaultCount > 0) {
    recommendations.push(
      `${staleVaultCount} vault ${staleVaultCount === 1 ? "heartbeat is" : "heartbeats are"} stale or missing. Record proof of life to keep the dead-man switch armed safely.`
    );
  }

  const grade: HealthGrade =
    score >= 80 ? "strong" : score >= 55 ? "fair" : score >= 30 ? "weak" : "critical";

  return {
    score,
    guardianQuorum,
    encryptionStrength,
    heartbeatFreshness,
    grade,
    recommendations: recommendations.slice(0, 5),
  };
};

interface HeartbeatStatus {
  daysRemaining: number;
  totalDays: number;
  triggered: boolean;
}

const getHeartbeatStatus = (
  state: VaultReleaseState | undefined,
  now: number
): HeartbeatStatus | null => {
  if (!state) return null;
  const totalDays = Math.max(1, Math.round(state.inactivityPeriod / DAY_SECONDS));
  const elapsedDays = state.lastProofOfLife > 0 ? (now - state.lastProofOfLife) / DAY_SECONDS : totalDays;
  return {
    daysRemaining: Math.max(0, Math.ceil(totalDays - elapsedDays)),
    totalDays,
    triggered: state.emergencyMode || elapsedDays >= totalDays,
  };
};

const EmptyChartHint = ({ message }: { message: string }) => (
  <div className="min-h-[8rem] flex items-center justify-center rounded-xl border border-dashed border-white/15 bg-white/[0.02] p-6">
    <p className="text-sm text-gray-500 text-center max-w-xs">{message}</p>
  </div>
);

const gradeColorClass: Record<HealthGrade, string> = {
  strong: "text-emerald-300",
  fair: "text-sky-300",
  weak: "text-amber-300",
  critical: "text-rose-300",
};

const gradeChipColor: Record<HealthGrade, "success" | "primary" | "warning" | "danger"> = {
  strong: "success",
  fair: "primary",
  weak: "warning",
  critical: "danger",
};

const gaugeStroke: Record<HealthGrade, string> = {
  strong: "#34d399",
  fair: "#38bdf8",
  weak: "#fbbf24",
  critical: "#fb7185",
};

const AnalyticsDashboard = () => {
  const { account, isConnected, connect, provider, signer, isFujiNetwork, ecosystem } = useWeb3();
  const prefersReducedMotion = useReducedMotion();

  const loadVersionRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [vaults, setVaults] = useState<VaultData[]>([]);
  const [documents, setDocuments] = useState<DocumentData[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [releaseStates, setReleaseStates] = useState<Record<number, VaultReleaseState>>({});
  const [recordingVaultId, setRecordingVaultId] = useState<number | null>(null);

  useEffect(() => {
    if (isConnected && ((provider && signer && isFujiNetwork) || ecosystem === "stellar")) {
      if (provider && signer) {
        contractService.initialize(provider, signer);
      }
      void loadAnalytics();
    } else {
      loadVersionRef.current += 1;
      setLoading(false);
      setVaults([]);
      setDocuments([]);
      setActivity([]);
      setReleaseStates({});
    }
  }, [account, isConnected, provider, signer, isFujiNetwork, ecosystem]);

  const loadAnalytics = async (options?: { silent?: boolean }) => {
    if (!account) {
      setLoading(false);
      return;
    }
    if (!options?.silent) {
      setLoading(true);
    }
    const loadVersion = ++loadVersionRef.current;
    try {
      const vaultsData = await contractService.fetchVaultsForAccount(account);
      if (loadVersionRef.current !== loadVersion) return;

      const vaultIds = vaultsData.map((vault) => vault.id);
      setVaults(vaultsData);

      const [docsData, states, activityData] = await Promise.all([
        contractService.fetchDocumentsForVaults(vaultIds).catch(() => []),
        contractService.fetchVaultReleaseStates(vaultIds).catch(() => ({})),
        contractService
          .getRecentActivity(60)
          .then((events) =>
            events.filter(
              (event) => event.actor.toLowerCase() === account.toLowerCase()
            )
          )
          .catch(() => []),
      ]);
      if (loadVersionRef.current !== loadVersion) return;

      setDocuments(docsData);
      setReleaseStates(states);
      setActivity(activityData);
    } catch (error) {
      captureError("analyticsDashboard.loadData", error, { account: account || "" });
      const message = error instanceof Error ? error.message : "Failed to load analytics data";
      toast.error(message);
    } finally {
      if (!options?.silent && loadVersionRef.current === loadVersion) {
        setLoading(false);
      }
    }
  };

  const handleRecordHeartbeat = async (vaultId: number) => {
    setRecordingVaultId(vaultId);
    try {
      await contractService.recordProofOfLife(vaultId);
      toast.success("Proof-of-life heartbeat recorded");
      await loadAnalytics({ silent: true });
    } catch (error) {
      captureError("analyticsDashboard.recordProofOfLife", error, { vaultId });
      const message = error instanceof Error ? error.message : "Failed to record heartbeat";
      toast.error(message);
    } finally {
      setRecordingVaultId(null);
    }
  };

  const nowSec = useMemo(() => Math.floor(Date.now() / 1000), [vaults, releaseStates]);

  const health = useMemo(
    () => computeSecurityHealth(vaults, documents, releaseStates, nowSec),
    [vaults, documents, releaseStates, nowSec]
  );

  const uniqueGuardianCount = useMemo(() => {
    const guardians = new Set<string>();
    vaults.forEach((vault) =>
      vault.guardians.forEach((guardian) => guardians.add(guardian.toLowerCase()))
    );
    return guardians.size;
  }, [vaults]);

  const guardianDistribution = useMemo(() => {
    const byNetwork: Record<string, Set<string>> = {};
    vaults.forEach((vault) => {
      const network = vault.network ?? "avalanche";
      if (!byNetwork[network]) byNetwork[network] = new Set<string>();
      vault.guardians.forEach((guardian) => byNetwork[network].add(guardian.toLowerCase()));
    });
    return Object.entries(byNetwork)
      .map(([network, guardians]) => ({ network, count: guardians.size }))
      .sort((a, b) => b.count - a.count);
  }, [vaults]);

  const documentDistribution = useMemo(() => {
    const counts = vaults.map((vault) => ({
      vault,
      count: documents.filter((doc) => doc.vaultId === vault.id).length,
    }));
    const max = counts.reduce((acc, entry) => Math.max(acc, entry.count), 0);
    return { counts, max };
  }, [vaults, documents]);

  const activityTimeline = useMemo(() => {
    const buckets = Array.from({ length: ACTIVITY_WINDOW_DAYS }, (_, index) => ({
      dayOffset: ACTIVITY_WINDOW_DAYS - 1 - index,
      label: new Date(
        (nowSec - (ACTIVITY_WINDOW_DAYS - 1 - index) * DAY_SECONDS) * 1000
      ).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      count: 0,
    }));
    const startIndex = nowSec - ACTIVITY_WINDOW_DAYS * DAY_SECONDS;
    activity.forEach((event) => {
      if (event.timestamp < startIndex) return;
      const dayIndex = Math.floor((event.timestamp - startIndex) / DAY_SECONDS);
      if (dayIndex >= 0 && dayIndex < buckets.length) {
        buckets[dayIndex].count += 1;
      }
    });
    const max = buckets.reduce((acc, bucket) => Math.max(acc, bucket.count), 0);
    return { buckets, max };
  }, [activity, nowSec]);

  const heartbeatRows = useMemo(() => {
    return vaults
      .map((vault) => ({ vault, status: getHeartbeatStatus(releaseStates[vault.id], nowSec) }))
      .filter((row): row is { vault: VaultData; status: HeartbeatStatus } => row.status !== null)
      .sort((a, b) => a.status.daysRemaining - b.status.daysRemaining);
  }, [vaults, releaseStates, nowSec]);

  const upcomingDeadline = heartbeatRows.find((row) => !row.status.triggered);

  const gaugeRadius = 54;
  const gaugeCircumference = 2 * Math.PI * gaugeRadius;

  if (!isConnected) {
    return (
      <div className="min-h-[calc(100vh-11rem)] flex items-center justify-center">
        <div className={`w-full max-w-4xl p-8 text-center ${glassCard}`}>
          <div className="w-20 h-20 bg-gradient-to-br from-brand-700 to-brand-900 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <FiZap className="text-white text-3xl" />
          </div>
          <h1 className="text-3xl font-bold mb-4">Security Analytics</h1>
          <p className="text-gray-400 mb-8 max-w-2xl mx-auto">
            Connect your wallet to view your vault security health score, guardian distribution,
            and dead-man switch deadlines.
          </p>
          <Button
            size="lg"
            className={buttonClasses.primaryLg}
            onPress={connect}
            startContent={<FiKey />}
          >
            Connect Wallet
          </Button>
        </div>
      </div>
    );
  }

  if (ecosystem !== "stellar" && !isFujiNetwork) {
    return (
      <div className="min-h-[calc(100vh-11rem)] flex items-center justify-center">
        <div className={`w-full max-w-4xl p-8 text-center ${glassCard}`}>
          <div className="w-20 h-20 bg-gradient-to-br from-yellow-500 to-orange-500 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <FiAlertTriangle className="text-white text-3xl" />
          </div>
          <h1 className="text-3xl font-bold mb-4">Wrong Network</h1>
          <p className="text-gray-400 mb-8 max-w-2xl mx-auto">
            Please switch to Avalanche Fuji Testnet to view security analytics.
          </p>
          <Button
            size="lg"
            className={buttonClasses.warningLg}
            onPress={() =>
              window.ethereum &&
              window.ethereum.request({
                method: "wallet_switchEthereumChain",
                params: [{ chainId: "0xA869" }],
              })
            }
          >
            Switch to Fuji Network
          </Button>
        </div>
      </div>
    );
  }

  const animationDuration = prefersReducedMotion ? 0 : 0.8;

  return (
    <div className="space-y-6">
      <div className={`p-6 lg:p-8 ${glassCard}`}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-brand-700 to-brand-900 flex items-center justify-center">
              <FiActivity className="text-white text-xl" />
            </div>
            <div>
              <h1 className="text-2xl lg:text-3xl font-bold">Security Analytics</h1>
              <p className="text-sm text-gray-400">
                Live vault health, guardian coverage, and inheritance readiness on{" "}
                {ecosystem === "stellar" ? "Stellar" : "Avalanche Fuji"}.
              </p>
            </div>
          </div>
          <Button
            className={buttonClasses.outlineSm}
            startContent={<FiRefreshCw className={loading ? "animate-spin" : ""} />}
            onPress={() => void loadAnalytics()}
            isDisabled={loading}
          >
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className={`lg:col-span-2 p-6 flex flex-col items-center justify-center ${glassCard}`}>
          {loading ? (
            <Skeleton className="rounded-full">
              <div className="w-40 h-40 rounded-full bg-default-300" />
            </Skeleton>
          ) : (
            <>
              <div className="relative w-40 h-40">
                <svg viewBox="0 0 128 128" className="w-full h-full -rotate-90">
                  <circle
                    cx="64"
                    cy="64"
                    r={gaugeRadius}
                    fill="none"
                    stroke="currentColor"
                    className="text-white/10"
                    strokeWidth="10"
                  />
                  <motion.circle
                    cx="64"
                    cy="64"
                    r={gaugeRadius}
                    fill="none"
                    stroke={gaugeStroke[health.grade]}
                    strokeWidth="10"
                    strokeLinecap="round"
                    strokeDasharray={gaugeCircumference}
                    initial={{ strokeDashoffset: gaugeCircumference }}
                    animate={{
                      strokeDashoffset:
                        gaugeCircumference * (1 - health.score / 100),
                    }}
                    transition={{ duration: animationDuration, ease: "easeOut" }}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className={`text-4xl font-bold ${gradeColorClass[health.grade]}`}>
                    {health.score}
                  </span>
                  <span className="text-xs text-gray-400 uppercase tracking-wider">
                    Health Score
                  </span>
                </div>
              </div>
              <Chip
                className="mt-4 capitalize"
                color={gradeChipColor[health.grade]}
                variant="flat"
                size="sm"
              >
                {health.grade}
              </Chip>
              <p className="mt-3 text-xs text-gray-500 text-center max-w-[16rem]">
                Weighted from guardian quorum (40), encryption strength (30), and heartbeat
                freshness (30).
              </p>
            </>
          )}
        </div>

        <div className={`lg:col-span-3 p-6 space-y-5 ${glassCard}`}>
          <h2 className="text-lg font-semibold">Score Breakdown</h2>
          {loading
            ? [...Array(3)].map((_, i) => (
                <Skeleton key={i} className="rounded-lg">
                  <div className="h-10 rounded-lg bg-default-300" />
                </Skeleton>
              ))
            : [
                {
                  label: "Guardian Quorum",
                  value: health.guardianQuorum,
                  max: 40,
                  barClass: "bg-gradient-to-r from-brand-600 to-brand-800",
                },
                {
                  label: "Encryption Strength",
                  value: health.encryptionStrength,
                  max: 30,
                  barClass: "bg-gradient-to-r from-sky-500 to-cyan-500",
                },
                {
                  label: "Heartbeat Freshness",
                  value: health.heartbeatFreshness,
                  max: 30,
                  barClass: "bg-gradient-to-r from-emerald-500 to-green-500",
                },
              ].map((component) => (
                <div key={component.label}>
                  <div className="flex items-center justify-between mb-1.5 text-sm">
                    <span className="text-gray-300">{component.label}</span>
                    <span className="font-semibold">
                      {component.value}
                      <span className="text-gray-500 font-normal">/{component.max}</span>
                    </span>
                  </div>
                  <div className="h-2.5 rounded-full bg-white/10 overflow-hidden">
                    <motion.div
                      className={`h-full rounded-full origin-left ${component.barClass}`}
                      initial={{ transform: "scaleX(0)" }}
                      animate={{
                        transform: `scaleX(${Math.max(component.value / component.max, 0)})`,
                      }}
                      transition={{ duration: animationDuration, ease: "easeOut" }}
                    />
                  </div>
                </div>
              ))}
          {!loading && health.recommendations.length > 0 && (
            <div className="pt-2 border-t border-white/10">
              <div className="flex items-center gap-2 mb-2.5">
                <FiInfo className="text-brand-300" />
                <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-300">
                  Recommendations
                </h3>
              </div>
              <ul className="space-y-2">
                {health.recommendations.map((recommendation) => (
                  <li key={recommendation} className="flex items-start gap-2 text-sm text-gray-400">
                    <FiArrowUpRight className="mt-0.5 flex-shrink-0 text-brand-300" />
                    <span>{recommendation}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Access Vaults", value: vaults.length, icon: <FiShield /> },
          { label: "Encrypted Documents", value: documents.length, icon: <FiFile /> },
          { label: "Unique Guardians", value: uniqueGuardianCount, icon: <FiUsers /> },
          {
            label: "Next Heartbeat Due",
            value: upcomingDeadline ? `${upcomingDeadline.status.daysRemaining}d` : "—",
            icon: <FiClock />,
          },
        ].map((stat) => (
          <div key={stat.label} className={`p-5 ${glassCard}`}>
            <div className="inline-flex p-2.5 rounded-xl bg-white/5 border border-white/10 text-brand-300 mb-3">
              {stat.icon}
            </div>
            {loading ? (
              <Skeleton className="rounded-lg">
                <div className="h-7 w-12 rounded-lg bg-default-300" />
              </Skeleton>
            ) : (
              <h3 className="text-2xl font-bold">{stat.value}</h3>
            )}
            <p className="text-xs text-gray-400 mt-1">{stat.label}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className={`p-6 ${glassCard}`}>
          <div className="flex items-center gap-2 mb-5">
            <FiFile className="text-brand-300" />
            <h2 className="text-lg font-semibold">Document Distribution</h2>
          </div>
          {loading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="rounded-lg">
                  <div className="h-8 rounded-lg bg-default-300" />
                </Skeleton>
              ))}
            </div>
          ) : documentDistribution.counts.length === 0 ? (
            <EmptyChartHint message="Create a vault and upload documents to see their distribution." />
          ) : (
            <div className="space-y-4">
              {documentDistribution.counts.map(({ vault, count }) => (
                <div key={vault.id}>
                  <div className="flex items-center justify-between mb-1.5 text-sm">
                    <span className="text-gray-300 truncate pr-2">{vault.name}</span>
                    <span className="font-semibold flex-shrink-0">{count}</span>
                  </div>
                  <div className="h-2.5 rounded-full bg-white/10 overflow-hidden">
                    <motion.div
                      className="h-full rounded-full origin-left bg-gradient-to-r from-brand-600 to-brand-800"
                      initial={{ transform: "scaleX(0)" }}
                      animate={{
                        transform: `scaleX(${
                          documentDistribution.max > 0 ? count / documentDistribution.max : 0
                        })`,
                      }}
                      transition={{ duration: animationDuration, ease: "easeOut" }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={`p-6 ${glassCard}`}>
          <div className="flex items-center gap-2 mb-5">
            <FiActivity className="text-brand-300" />
            <h2 className="text-lg font-semibold">Activity Timeline</h2>
            <Chip size="sm" variant="flat" className="ml-auto">
              Last {ACTIVITY_WINDOW_DAYS} days
            </Chip>
          </div>
          {loading ? (
            <Skeleton className="rounded-lg">
              <div className="h-44 rounded-lg bg-default-300" />
            </Skeleton>
          ) : activityTimeline.max === 0 ? (
            <EmptyChartHint message="No personal activity recorded yet. Actions like uploads and approvals will appear here." />
          ) : (
            <div className="flex items-end justify-between gap-1 h-44">
              {activityTimeline.buckets.map((bucket) => (
                <div
                  key={bucket.dayOffset}
                  className="flex-1 h-full flex flex-col min-w-0"
                >
                  <div className="flex-1 flex items-end justify-center">
                    <motion.div
                      className="w-full max-w-[1.75rem] rounded-t-md bg-gradient-to-t from-brand-800 to-brand-500 origin-bottom"
                      initial={{ transform: "scaleY(0)" }}
                      animate={{ transform: "scaleY(1)" }}
                      transition={{ duration: animationDuration, ease: "easeOut" }}
                      style={{
                        height: `${Math.max((bucket.count / activityTimeline.max) * 100, 2)}%`,
                      }}
                      title={`${bucket.count} event${bucket.count === 1 ? "" : "s"} on ${bucket.label}`}
                    />
                  </div>
                  <span className="text-[9px] text-gray-500 truncate w-full text-center mt-1.5">
                    {bucket.label}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className={`p-6 ${glassCard}`}>
          <div className="flex items-center gap-2 mb-5">
            <FiUsers className="text-brand-300" />
            <h2 className="text-lg font-semibold">Guardian Distribution</h2>
          </div>
          {loading ? (
            <div className="space-y-4">
              {[...Array(2)].map((_, i) => (
                <Skeleton key={i} className="rounded-lg">
                  <div className="h-12 rounded-lg bg-default-300" />
                </Skeleton>
              ))}
            </div>
          ) : vaults.length === 0 ? (
            <EmptyChartHint message="Guardian coverage appears once you create vaults with assigned guardians." />
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap gap-2">
                {guardianDistribution.map(({ network, count }) => (
                  <Chip
                    key={network}
                    size="sm"
                    variant="flat"
                    color={network === "stellar" ? "secondary" : "danger"}
                    className="capitalize"
                  >
                    {network}: {count} guardian{count === 1 ? "" : "s"}
                  </Chip>
                ))}
              </div>
              <div className="space-y-3">
                {vaults.map((vault) => (
                  <div
                    key={vault.id}
                    className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
                  >
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate pr-2 font-medium">{vault.name}</span>
                      <span className="flex-shrink-0 text-gray-400">
                        {vault.approvalThreshold}-of-{vault.guardians.length} quorum
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
                      <motion.div
                        className="h-full rounded-full origin-left bg-gradient-to-r from-emerald-500 to-green-500"
                        initial={{ transform: "scaleX(0)" }}
                        animate={{
                          transform: `scaleX(${Math.min(
                            vault.guardians.length / 5,
                            1
                          )})`,
                        }}
                        transition={{ duration: animationDuration, ease: "easeOut" }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className={`p-6 ${glassCard}`}>
          <div className="flex items-center gap-2 mb-5">
            <FiHeart className="text-brand-300" />
            <h2 className="text-lg font-semibold">Dead-Man Switch Monitor</h2>
          </div>
          {loading ? (
            <div className="space-y-4">
              {[...Array(2)].map((_, i) => (
                <Skeleton key={i} className="rounded-lg">
                  <div className="h-14 rounded-lg bg-default-300" />
                </Skeleton>
              ))}
            </div>
          ) : heartbeatRows.length === 0 ? (
            <EmptyChartHint message="Inheritance deadlines appear after vaults configure an inactivity period." />
          ) : (
            <div className="space-y-3">
              {heartbeatRows.map(({ vault, status }) => {
                const progress =
                  status.totalDays > 0
                    ? Math.min(((status.totalDays - status.daysRemaining) / status.totalDays) * 100, 100)
                    : 100;
                return (
                  <div
                    key={vault.id}
                    className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 space-y-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate pr-2 text-sm font-medium">{vault.name}</span>
                      {status.triggered ? (
                        <Chip size="sm" variant="flat" color="warning" startContent={<FiClock />}>
                          Triggered
                        </Chip>
                      ) : status.daysRemaining <= 7 ? (
                        <Chip size="sm" variant="flat" color="danger" startContent={<FiAlertTriangle />}>
                          {status.daysRemaining}d left
                        </Chip>
                      ) : (
                        <Chip size="sm" variant="flat" color="success" startContent={<FiCheckCircle />}>
                          {status.daysRemaining}d left
                        </Chip>
                      )}
                    </div>
                    <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                      <motion.div
                        className={`h-full rounded-full origin-left ${
                          status.triggered
                            ? "bg-gradient-to-r from-amber-500 to-orange-500"
                            : status.daysRemaining <= 7
                            ? "bg-gradient-to-r from-rose-500 to-red-500"
                            : "bg-gradient-to-r from-emerald-500 to-green-500"
                        }`}
                        initial={{ transform: "scaleX(0)" }}
                        animate={{ transform: `scaleX(${progress / 100})` }}
                        transition={{ duration: animationDuration, ease: "easeOut" }}
                      />
                    </div>
                    {ecosystem === "avalanche" && (
                      <Button
                        size="sm"
                        variant="flat"
                        className="w-full"
                        startContent={<FiHeart />}
                        isLoading={recordingVaultId === vault.id}
                        isDisabled={recordingVaultId !== null}
                        onPress={() => void handleRecordHeartbeat(vault.id)}
                      >
                        Record Heartbeat
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AnalyticsDashboard;
