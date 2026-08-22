import { describe, it, expect } from "vitest";
import { computeSecurityHealth } from "../utils/securityHealth";
import type {
  VaultData,
  DocumentData,
  VaultReleaseState,
} from "../services/contract.service";

const NOW = 1_000_000_000;

const makeVault = (
  id: number,
  guardians: string[] = [],
  approvalThreshold: number = 1,
  network: "avalanche" | "stellar" = "avalanche"
): VaultData => ({
  id,
  creator: "0xcreator0000000000000000000000000000000000",
  name: `Vault ${id}`,
  description: "test vault",
  guardians,
  approvalThreshold,
  isActive: true,
  createdAt: NOW - 86400 * 5,
  network,
});

const makeDoc = (
  id: number,
  vaultId: number,
  encryptedMetadata: string = "raw-ciphertext",
  requiredAccess: number = 0
): DocumentData => ({
  id,
  vaultId,
  encryptedMetadata,
  ipfsHash: "ipfs://test",
  uploadedBy: "0xuploader0000000000000000000000000000000000",
  uploadedAt: NOW - 86400 * 3,
  requiredAccess,
});

const makeReleaseState = (
  inactivityPeriod: number = 86400 * 30,
  lastProofOfLife: number = NOW,
  emergencyMode: boolean = false
): VaultReleaseState => ({
  emergencyMode,
  inactivityPeriod,
  lastProofOfLife,
  postDeathUnlocked: false,
});

const VSS_METADATA = JSON.stringify({
  ciphertext: "encrypted-data",
  commitments: ["vss-commitment-1", "vss-commitment-2"],
});

describe("computeSecurityHealth", () => {
  it("returns critical grade with zero score when no vaults exist", () => {
    const health = computeSecurityHealth([], [], {}, NOW);
    expect(health.score).toBe(0);
    expect(health.grade).toBe("critical");
    expect(health.recommendations).toContain(
      "Create your first access vault to start building a security baseline."
    );
  });

  it("scores guardian quorum up to 40 points based on redundancy and thresholds", () => {
    const vaults = [
      makeVault(
        1,
        [
          "0x1111111111111111111111111111111111111111",
          "0x2222222222222222222222222222222222222222",
          "0x3333333333333333333333333333333333333333",
          "0x4444444444444444444444444444444444444444",
          "0x5555555555555555555555555555555555555555",
        ],
        3
      ),
    ];
    const health = computeSecurityHealth(vaults, [], {}, NOW);

    // 5 unique guardians → redundancyScore = 20, thresholdPoints = 20
    // guardianQuorum = 40
    expect(health.guardianQuorum).toBe(40);
    expect(health.score).toBe(40);
    expect(
      health.score + health.encryptionStrength + health.heartbeatFreshness
    ).toBe(40);
  });

  it("recommends raising single-approver thresholds above 1", () => {
    const vaults = [
      makeVault(1, ["0x1111111111111111111111111111111111111111"], 1),
    ];
    const health = computeSecurityHealth(vaults, [], {}, NOW);
    expect(health.recommendations).toContain(
      "Raise approval thresholds above 1 so a single guardian cannot unlock documents alone."
    );
  });

  it("recommends lowering deadlock thresholds when threshold equals guardian count", () => {
    const vaults = [
      makeVault(
        1,
        [
          "0x1111111111111111111111111111111111111111",
          "0x2222222222222222222222222222222222222222",
        ],
        2
      ),
    ];
    const health = computeSecurityHealth(vaults, [], {}, NOW);
    expect(health.recommendations).toContain(
      "Lower thresholds below the guardian count to avoid deadlock if a guardian becomes unreachable."
    );
  });

  it("awards full encryption strength when all documents have VSS commitments", () => {
    const vaults = [
      makeVault(1, ["0x1111111111111111111111111111111111111111"]),
    ];
    const docs = [makeDoc(1, 1, VSS_METADATA), makeDoc(2, 1, VSS_METADATA)];
    const health = computeSecurityHealth(vaults, docs, {}, NOW);

    // 2 docs with VSS → vssCovered=2, multiPartyCovered=0 (requiredAccess=0)
    // encryptionStrength = (2/2)*15 + (0/2)*15 = 15
    expect(health.encryptionStrength).toBe(15);
  });

  it("penalises documents without VSS commitments", () => {
    const vaults = [
      makeVault(1, ["0x1111111111111111111111111111111111111111"]),
    ];
    const docs = [
      makeDoc(1, 1, "raw-ciphertext-without-vss"),
      makeDoc(2, 1, "another-raw-ciphertext"),
    ];
    const health = computeSecurityHealth(vaults, docs, {}, NOW);

    expect(health.encryptionStrength).toBe(0);
    expect(health.recommendations).toContain(
      "Re-share documents with verifiable secret sharing (VSS) so guardian shares can be verified."
    );
  });

  it("scores heartbeat freshness at full points when recently proven", () => {
    const vaults = [
      makeVault(1, ["0x1111111111111111111111111111111111111111"]),
    ];
    const releaseStates: Record<number, VaultReleaseState> = {
      1: makeReleaseState(86400 * 30, NOW - 86400 * 5),
    };
    const health = computeSecurityHealth(vaults, [], releaseStates, NOW);

    // elapsed = 5 days, period = 30 days → ratio = 25/30 ≈ 0.833
    // freshnessPoints = 0.833 * 30 ≈ 25
    expect(health.heartbeatFreshness).toBe(25);
  });

  it("marks vaults as stale when heartbeat is older than 75% of the period", () => {
    const vaults = [
      makeVault(1, ["0x1111111111111111111111111111111111111111"]),
    ];
    const releaseStates: Record<number, VaultReleaseState> = {
      1: makeReleaseState(86400 * 30, NOW - 86400 * 29),
    };
    const health = computeSecurityHealth(vaults, [], releaseStates, NOW);

    // elapsed = 29 days, period = 30 days → ratio = 1/30 ≈ 0.033 < 0.25 → stale
    expect(health.heartbeatFreshness).toBe(1);
    expect(health.recommendations.some((r) => r.includes("heartbeat"))).toBe(
      true
    );
  });

  it("counts emergency-mode vaults as stale", () => {
    const vaults = [
      makeVault(1, ["0x1111111111111111111111111111111111111111"]),
    ];
    const releaseStates: Record<number, VaultReleaseState> = {
      1: makeReleaseState(86400 * 30, NOW, true),
    };
    const health = computeSecurityHealth(vaults, [], releaseStates, NOW);

    expect(health.heartbeatFreshness).toBe(0);
    expect(health.recommendations.some((r) => r.includes("stale"))).toBe(true);
  });

  it("counts vaults with lastProofOfLife of 0 as stale", () => {
    const vaults = [
      makeVault(1, ["0x1111111111111111111111111111111111111111"]),
    ];
    const releaseStates: Record<number, VaultReleaseState> = {
      1: makeReleaseState(86400 * 30, 0),
    };
    const health = computeSecurityHealth(vaults, [], releaseStates, NOW);

    expect(health.heartbeatFreshness).toBe(0);
  });

  it("caps recommendations list at 5 items", () => {
    const vaults = [
      makeVault(1, ["0x1111111111111111111111111111111111111111"], 1),
      makeVault(2, ["0x2222222222222222222222222222222222222222"], 1),
    ];
    const docs = [
      makeDoc(1, 1, "raw-ciphertext"),
      makeDoc(2, 1, "raw-ciphertext"),
    ];
    const releaseStates: Record<number, VaultReleaseState> = {
      1: makeReleaseState(86400 * 30, 0),
      2: makeReleaseState(86400 * 30, 0),
    };
    const health = computeSecurityHealth(vaults, docs, releaseStates, NOW);

    expect(health.recommendations.length).toBeLessThanOrEqual(5);
  });

  it("assigns correct grades based on score thresholds", () => {
    // Critical: score < 30
    const critical = computeSecurityHealth(
      [makeVault(1, ["0xaaaa"], 1)],
      [],
      { 1: makeReleaseState(86400 * 30, 0) },
      NOW
    );
    expect(critical.score).toBeLessThan(30);
    expect(critical.grade).toBe("critical");

    // Strong: score >= 80
    const strongVaults = [
      makeVault(
        1,
        [
          "0x1111111111111111111111111111111111111111",
          "0x2222222222222222222222222222222222222222",
          "0x3333333333333333333333333333333333333333",
          "0x4444444444444444444444444444444444444444",
          "0x5555555555555555555555555555555555555555",
        ],
        3
      ),
    ];
    const strongDocs = [makeDoc(1, 1, VSS_METADATA)];
    const strongReleaseStates: Record<number, VaultReleaseState> = {
      1: makeReleaseState(86400 * 30, NOW),
    };
    const strong = computeSecurityHealth(
      strongVaults,
      strongDocs,
      strongReleaseStates,
      NOW
    );

    // guardianQuorum: 5 guardians → 20 + 20 = 40
    // encryptionStrength: 1 doc with VSS, 0 multi-party → 15
    // heartbeatFreshness: ratio ≈ 1.0 → 30
    // score = 40 + 15 + 30 = 85 >= 80 → strong
    expect(strong.score).toBeGreaterThanOrEqual(80);
    expect(strong.grade).toBe("strong");
  });

  it("handles vaults without release states gracefully (no heartbeat points)", () => {
    const vaults = [
      makeVault(1, ["0x1111111111111111111111111111111111111111"]),
    ];
    const health = computeSecurityHealth(vaults, [], {}, NOW);

    // guardianQuorum = 4 (1 guardian → 20% of 20 = 4), encryptionStrength = 0, heartbeatFreshness = 0
    expect(health.heartbeatFreshness).toBe(0);
    expect(health.score).toBe(4);
    expect(health.grade).toBe("critical");
  });

  it("awards multi-party encryption points when requiredAccess >= 2", () => {
    const vaults = [
      makeVault(1, ["0x1111111111111111111111111111111111111111"]),
    ];
    const docs = [
      makeDoc(1, 1, VSS_METADATA, 2),
      makeDoc(2, 1, VSS_METADATA, 2),
    ];
    const health = computeSecurityHealth(vaults, docs, {}, NOW);

    // vssCovered=2, multiPartyCovered=2
    // encryptionStrength = (2/2)*15 + (2/2)*15 = 30
    expect(health.encryptionStrength).toBe(30);
  });

  it("aggregates unique guardians across multiple vaults", () => {
    const g1 = "0x1111111111111111111111111111111111111111";
    const g2 = "0x2222222222222222222222222222222222222222";
    const g3 = "0x3333333333333333333333333333333333333333";
    const g4 = "0x4444444444444444444444444444444444444444";
    const g5 = "0x5555555555555555555555555555555555555555";
    const vaults = [
      makeVault(1, [g1, g2, g3], 2),
      makeVault(2, [g4, g5, g1], 2),
    ];
    const health = computeSecurityHealth(vaults, [], {}, NOW);

    // 5 unique guardians → redundancyScore = 20
    // Threshold 2 with 3 guardians, 2 vaults → thresholdPoints = 40, score = 20
    // guardianQuorum = 40
    expect(health.guardianQuorum).toBe(40);
  });
});
