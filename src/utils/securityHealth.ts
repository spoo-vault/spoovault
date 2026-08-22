import { parseEncryptedMetadataPayload } from "../services/secrets.service";
import type {
  VaultData,
  DocumentData,
  VaultReleaseState,
} from "../services/contract.service";

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
    vault.guardians.forEach((guardian) =>
      uniqueGuardians.add(guardian.toLowerCase())
    )
  );

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
  const thresholdScore =
    vaults.length > 0 ? Math.min(thresholdPoints / vaults.length, 20) : 0;
  const guardianQuorum = Math.round(redundancyScore + thresholdScore);

  let vssCovered = 0;
  let multiPartyCovered = 0;
  documents.forEach((doc) => {
    if (
      parseEncryptedMetadataPayload(doc.encryptedMetadata).commitments.length >
      0
    ) {
      vssCovered += 1;
    }
    if (doc.requiredAccess >= 2) {
      multiPartyCovered += 1;
    }
  });
  const encryptionStrength =
    documents.length > 0
      ? Math.round(
          (vssCovered / documents.length) * 15 +
            (multiPartyCovered / documents.length) * 15
        )
      : 0;

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
    recommendations.push(
      "Create your first access vault to start building a security baseline."
    );
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
      `${staleVaultCount} vault ${
        staleVaultCount === 1 ? "heartbeat is" : "heartbeats are"
      } stale or missing. Record proof of life to keep the dead-man switch armed safely.`
    );
  }

  const grade: HealthGrade =
    score >= 80
      ? "strong"
      : score >= 55
      ? "fair"
      : score >= 30
      ? "weak"
      : "critical";

  return {
    score,
    guardianQuorum,
    encryptionStrength,
    heartbeatFreshness,
    grade,
    recommendations: recommendations.slice(0, 5),
  };
};
