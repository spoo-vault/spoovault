import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  combineShares,
  evaluatePolynomial,
  PSS_FIELD_PRIME,
} from "../utils/proactiveSecretSharing";

const fieldElement = fc.bigInt({ min: 0n, max: PSS_FIELD_PRIME - 1n });

const sharingCase = fc.integer({ min: 1, max: 12 }).chain((total) =>
  fc.integer({ min: 1, max: total }).chain((threshold) =>
    fc.record({
      coefficients: fc.array(fieldElement, { minLength: threshold, maxLength: threshold }),
      indices: fc.shuffledSubarray(Array.from({ length: total }, (_, i) => BigInt(i + 1)), {
        minLength: threshold,
        maxLength: threshold,
      }),
    })
  )
);

function referenceEvaluate(coefficients: bigint[], x: bigint): bigint {
  const sum = coefficients.reduce((value, coefficient, degree) =>
    value + coefficient * x ** BigInt(degree), 0n);
  return (sum % PSS_FIELD_PRIME + PSS_FIELD_PRIME) % PSS_FIELD_PRIME;
}

describe("Shamir secret sharing properties", () => {
  it("recovers the exact secret from a random threshold subset", () => {
    fc.assert(fc.property(sharingCase, ({ coefficients, indices }) => {
      const shares = indices.map((x) => ({ x, y: evaluatePolynomial(coefficients, x) }));
      expect(shares.map(({ y }) => y)).toEqual(
        indices.map((x) => referenceEvaluate(coefficients, x))
      );
      expect(combineShares(shares, coefficients.length)).toBe(coefficients[0]);
    }), { numRuns: 10_000 });
  }, 30_000);

  it("rejects sub-threshold reconstruction and finds an alternative compatible secret", () => {
    fc.assert(fc.property(sharingCase, ({ coefficients, indices }) => {
      const observed = indices.slice(0, -1);
      const shares = observed.map((x) => ({ x, y: referenceEvaluate(coefficients, x) }));
      expect(() => combineShares(shares, coefficients.length)).toThrow(/at least/);

      // Add the polynomial whose roots are the observed coordinates. Its
      // constant term is nonzero, so the same shares fit a different secret.
      const difference = observed.reduce((polynomial, root) => {
        const product = Array<bigint>(polynomial.length + 1).fill(0n);
        for (const [i, coefficient] of polynomial.entries()) {
          product[i] -= coefficient * root;
          product[i + 1] += coefficient;
        }
        return product;
      }, [1n]);
      const alternative = coefficients.map((coefficient, i) => coefficient + difference[i]);

      expect(referenceEvaluate(alternative, 0n)).not.toBe(coefficients[0]);
      expect(observed.map((x) => referenceEvaluate(alternative, x))).toEqual(
        shares.map(({ y }) => y)
      );
    }), { numRuns: 10_000 });
  }, 30_000);
});
