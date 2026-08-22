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
} from "../utils/proactiveSecretSharing";

const SECRET = 0x123456789abcdef0fedcba987654321n;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Proactive Secret Sharing (zero-sharing refresh)", () => {
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
      // h_i evaluated at its own point is defined; the defining constraint
      // is on the polynomial intercept, which we verify by refreshing a
      // share with only that guardian's contribution: f(x)+h(x) keeps the
      // same secret because intercept(h)=0.
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
    // f(x) = 5 + 3x + 2x^2 -> f(2) = 5 + 6 + 8 = 19
    const coeffs = [5n, 3n, 2n];
    expect(evaluatePolynomial(coeffs, 2n)).toBe(19n);
    expect(evaluatePolynomial(makeRandomPolynomial(42n, 3), 0n)).toBe(42n);
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
