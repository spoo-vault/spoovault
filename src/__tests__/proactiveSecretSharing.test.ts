import { describe, it, expect } from "vitest";
import {
  PSS_FIELD_PRIME,
  makeRandomPolynomial,
  evaluatePolynomial,
  splitSecret,
  generateZeroShares,
  addContribution,
  combineShares,
  proactiveRefresh,
  type Share,
  VSS_Q,
  generateZeroPolynomialVSS,
  verifyZeroShareContribution,
  updateShareVSS,
  updateCommitmentsVSS,
  proactiveRefreshVSS,
} from "../utils/proactiveSecretSharing";
import {
  splitSecretVSS,
  verifyShare,
  reconstructSecret,
} from "../services/secrets.service";

const SECRET = 0x123456789abcdef0fedcba987654321n;
const AES_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Proactive Secret Sharing (zero-sharing refresh - GF(2^127 - 1))", () => {
  it("should split a secret and reconstruct it from a threshold of shares", () => {
    const shares = splitSecret(SECRET, 3, 5);
    expect(shares).toHaveLength(5);
    expect(combineShares(shares.slice(0, 3), 3)).toBe(SECRET);
    expect(combineShares(shares.slice(2, 5), 3)).toBe(SECRET);
  });

  it("should fail to reconstruct with fewer shares than the threshold", () => {
    const shares = splitSecret(SECRET, 3, 5);
    expect(() => combineShares(shares.slice(0, 2), 3)).toThrow();
  });

  it("should keep the master key unchanged after a proactive refresh", () => {
    const shares = splitSecret(SECRET, 3, 4);
    const { refreshedShares, recoveredSecret } = proactiveRefreshSync(shares, 3);

    expect(recoveredSecret).toBe(SECRET);
    expect(combineShares(refreshedShares.slice(1, 4), 3)).toBe(SECRET);
    // Shares themselves must have changed.
    const changed = refreshedShares.filter(
      (s, i) => s.y !== shares[i].y
    );
    expect(changed.length).toBeGreaterThan(0);
  });

  it("must never allow old shares to be combined with new shares", () => {
    const shares = splitSecret(SECRET, 3, 4);
    const { refreshedShares } = proactiveRefreshSync(shares, 3);

    // Any mixture containing at least one stale share must not reveal S.
    const mixtures: Share[][] = [
      [shares[0], refreshedShares[1], refreshedShares[2]],
      [refreshedShares[0], shares[1], refreshedShares[3]],
      [refreshedShares[0], refreshedShares[1], shares[2]],
      [shares[0], shares[1], refreshedShares[2]],
    ];

    for (const mixture of mixtures) {
      expect(combineShares(mixture, 3)).not.toBe(SECRET);
    }
  });

  it("should verify the zero-polynomial property h(0) = 0 for every guardian", () => {
    const points = [1n, 2n, 3n, 4n];
    for (let guardian = 0; guardian < 4; guardian++) {
      const contributions = generateZeroShares(3, points);
      const shares = splitSecret(SECRET, 3, 4);
      const updated = shares.map((s) => addContribution(s, contributions.get(s.x)!));
      expect(combineShares(updated.slice(0, 3), 3)).toBe(SECRET);
    }
  });

  it("should run a multi-party refresh under simulated network delays", async () => {
    const shares = splitSecret(SECRET, 3, 4);
    const submissionOrder: number[] = [];

    const result = await proactiveRefresh(shares, 3, 7, async (guardianIndex) => {
      // Staggered latency: later guardians respond slower (network jitter).
      await wait(guardianIndex * 15 + 5);
      submissionOrder.push(guardianIndex);
    });

    expect(submissionOrder).toEqual([0, 1, 2, 3]);
    expect(result.epoch).toBe(7);
    expect(result.recoveredSecret).toBe(SECRET);
    expect(combineShares(result.refreshedShares.slice(0, 3), 3)).toBe(SECRET);
  });

  it("should support multiple sequential refresh rounds (epoch chaining)", async () => {
    let shares = splitSecret(SECRET, 2, 3);

    for (let epoch = 1; epoch <= 3; epoch++) {
      const result = await proactiveRefresh(shares, 2, epoch, async () => {
        await wait(2);
      });
      expect(result.recoveredSecret).toBe(SECRET);
      shares = result.refreshedShares;
    }

    expect(combineShares(shares.slice(0, 2), 2)).toBe(SECRET);
  });

  it("should perform all arithmetic inside GF(2^127 - 1)", () => {
    const bigSecret = PSS_FIELD_PRIME - 5n;
    const shares = splitSecret(bigSecret, 2, 3);
    const { recoveredSecret } = proactiveRefreshSync(shares, 2);
    expect(recoveredSecret).toBe(bigSecret % PSS_FIELD_PRIME);
  });

  it("should reject invalid thresholds", () => {
    expect(() => splitSecret(1n, 0, 3)).toThrow();
    expect(() => splitSecret(1n, 4, 3)).toThrow();
  });

  it("should evaluate polynomials with deterministic inputs correctly", () => {
    const coeffs = [5n, 3n, 2n];
    expect(evaluatePolynomial(coeffs, 2n)).toBe(19n);
    expect(evaluatePolynomial(makeRandomPolynomial(42n, 3), 0n)).toBe(42n);
  });
});

describe("Feldmann VSS Proactive Secret Sharing (256-bit safe prime MPC)", () => {
  it("should generate zero-polynomials satisfying h_i(0) = 0 and valid zero-commitments", () => {
    const zeroPoly = generateZeroPolynomialVSS(3, 4, 1);
    expect(zeroPoly.coefficients[0]).toBe(0n);
    expect(zeroPoly.zeroCommitments).toHaveLength(3);
    // Z_{i,0} = g^0 mod P = 1
    expect(BigInt("0x" + zeroPoly.zeroCommitments[0])).toBe(1n);

    // Subshares map covers all 4 guardians
    expect(zeroPoly.subshares.size).toBe(4);
    for (let j = 1; j <= 4; j++) {
      expect(zeroPoly.subshares.has(j)).toBe(true);
    }
  });

  it("should reject invalid threshold parameters in generateZeroPolynomialVSS", () => {
    expect(() => generateZeroPolynomialVSS(0, 4)).toThrow("Threshold must satisfy");
    expect(() => generateZeroPolynomialVSS(5, 4)).toThrow("Threshold must satisfy");
  });

  it("should verify legitimate zero-share contributions and reject corrupted ones", () => {
    const zeroPoly = generateZeroPolynomialVSS(3, 4, 2);
    for (let j = 1; j <= 4; j++) {
      const contrib = zeroPoly.subshares.get(j)!;
      const isValid = verifyZeroShareContribution(contrib, j, zeroPoly.zeroCommitments);
      expect(isValid).toBe(true);

      // Corrupted contribution must fail verification
      const badContrib = (contrib + 1n) % VSS_Q;
      const isBadValid = verifyZeroShareContribution(badContrib, j, zeroPoly.zeroCommitments);
      expect(isBadValid).toBe(false);
    }
  });

  it("should reject corrupted zero-commitments during contribution verification", () => {
    const zeroPoly = generateZeroPolynomialVSS(3, 4, 1);
    const contrib = zeroPoly.subshares.get(1)!;
    const badCommitments = [...zeroPoly.zeroCommitments];
    badCommitments[1] = "000000000000000000000000000000000000000000000000000000000000000005";
    expect(verifyZeroShareContribution(contrib, 1, badCommitments)).toBe(false);
  });

  it("should update guardian shares with zero-contributions", () => {
    const { shares } = splitSecretVSS(AES_KEY_HEX, 4, 3);
    const contribs = [12345n, 67890n, 54321n];
    const updated = updateShareVSS(shares[0], contribs);

    expect(updated).toMatch(/^1-vss/);
    expect(updated).not.toBe(shares[0]);

    // Reject legacy non-VSS shares
    expect(() => updateShareVSS("1-deadbeef", contribs)).toThrow(
      "Cannot update legacy non-VSS share with VSS zero-shares"
    );
  });

  it("should update VSS commitments homomorphically and strictly preserve C_0", () => {
    const { commitments } = splitSecretVSS(AES_KEY_HEX, 4, 3);
    const zeroPoly1 = generateZeroPolynomialVSS(3, 4, 1);
    const zeroPoly2 = generateZeroPolynomialVSS(3, 4, 2);

    const updatedComm = updateCommitmentsVSS(commitments, [
      zeroPoly1.zeroCommitments,
      zeroPoly2.zeroCommitments,
    ]);

    expect(updatedComm).toHaveLength(3);
    // C'_0 must be strictly identical to initial C_0 (commitment to master key)
    expect(updatedComm[0]).toBe(commitments[0]);
    // Higher order coefficient commitments must have changed
    expect(updatedComm[1]).not.toBe(commitments[1]);
    expect(updatedComm[2]).not.toBe(commitments[2]);
  });

  it("should throw if zero-commitment vector length does not match commitment threshold", () => {
    const { commitments } = splitSecretVSS(AES_KEY_HEX, 4, 3);
    const badMatrix = [["01", "02"]]; // length 2 instead of 3
    expect(() => updateCommitmentsVSS(commitments, badMatrix)).toThrow(
      "Mismatched zero-commitment vector length"
    );
  });

  it("should execute a full multi-party proactive refresh, preserving master key and verifying shares", async () => {
    const N = 4;
    const K = 3;
    const { shares, commitments } = splitSecretVSS(AES_KEY_HEX, N, K);

    const result = await proactiveRefreshVSS(shares, commitments, K, 1);

    expect(result.epoch).toBe(1);
    expect(result.recoveredSecret).toBe(AES_KEY_HEX);
    expect(result.refreshedShares).toHaveLength(N);

    // Shares must have changed
    for (let i = 0; i < N; i++) {
      expect(result.refreshedShares[i]).not.toBe(shares[i]);
    }

    // Every refreshed share must verify against the refreshed commitments
    for (const share of result.refreshedShares) {
      expect(verifyShare(share, result.refreshedCommitments)).toBe(true);
    }

    // Master key commitment must remain invariant
    expect(result.refreshedCommitments[0]).toBe(commitments[0]);

    // Any K refreshed shares reconstruct the unchanged master key
    expect(reconstructSecret([result.refreshedShares[0], result.refreshedShares[1], result.refreshedShares[2]])).toBe(AES_KEY_HEX);
    expect(reconstructSecret([result.refreshedShares[1], result.refreshedShares[2], result.refreshedShares[3]])).toBe(AES_KEY_HEX);
  });

  it("must prevent old shares from being combined with new shares (mobile adversary protection)", async () => {
    const N = 4;
    const K = 3;
    const { shares, commitments } = splitSecretVSS(AES_KEY_HEX, N, K);

    const { refreshedShares } = await proactiveRefreshVSS(shares, commitments, K, 1);

    // Stale/refreshed hybrid sets must fail to reconstruct the original secret key
    const hybridSets: string[][] = [
      [shares[0], refreshedShares[1], refreshedShares[2]],
      [refreshedShares[0], shares[1], refreshedShares[2]],
      [refreshedShares[0], refreshedShares[1], shares[2]],
      [shares[0], shares[1], refreshedShares[3]],
    ];

    for (const set of hybridSets) {
      const reconstructed = reconstructSecret(set);
      expect(reconstructed).not.toBe(AES_KEY_HEX);
    }
  });

  it("should successfully execute multi-party share refresh under simulated network delay", async () => {
    const N = 4;
    const K = 3;
    const { shares, commitments } = splitSecretVSS(AES_KEY_HEX, N, K);
    const arrivalOrder: number[] = [];

    const result = await proactiveRefreshVSS(shares, commitments, K, 2, async (guardianIdx) => {
      // Asynchronous network latency simulation with jitter
      await wait((N - guardianIdx) * 10 + 5);
      arrivalOrder.push(guardianIdx);
    });

    expect(arrivalOrder).toHaveLength(N);
    expect(result.epoch).toBe(2);
    expect(result.recoveredSecret).toBe(AES_KEY_HEX);
    for (const share of result.refreshedShares) {
      expect(verifyShare(share, result.refreshedCommitments)).toBe(true);
    }
  });

  it("should support multiple consecutive refresh rounds (epoch chaining) without key drift", async () => {
    const N = 4;
    const K = 3;
    let { shares, commitments } = splitSecretVSS(AES_KEY_HEX, N, K);

    for (let epoch = 1; epoch <= 3; epoch++) {
      const result = await proactiveRefreshVSS(shares, commitments, K, epoch);
      expect(result.recoveredSecret).toBe(AES_KEY_HEX);
      expect(result.refreshedCommitments[0]).toBe(commitments[0]);

      for (const share of result.refreshedShares) {
        expect(verifyShare(share, result.refreshedCommitments)).toBe(true);
      }

      shares = result.refreshedShares;
      commitments = result.refreshedCommitments;
    }

    expect(reconstructSecret(shares.slice(0, K))).toBe(AES_KEY_HEX);
  });
});

/** Refresh shares using the pure building blocks (no async orchestration). */
function proactiveRefreshSync(shares: Share[], threshold: number) {
  const points = shares.map((s) => s.x);
  const allContributions = Array.from({ length: shares.length }, () =>
    generateZeroShares(threshold, points)
  );
  const refreshedShares = shares.map((share) =>
    allContributions.reduce(
      (acc, contribs) => addContribution(acc, contribs.get(share.x)!),
      share
    )
  );
  return {
    refreshedShares,
    recoveredSecret: combineShares(refreshedShares, threshold),
    epoch: 1,
  };
}
