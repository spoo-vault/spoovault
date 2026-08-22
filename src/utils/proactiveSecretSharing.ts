/**
 * Proactive Secret Sharing (PSS) utilities.
 *
 * Implements the zero-sharing share-refresh protocol used by SpooVault
 * guardian rotation (see issue #91). Guardians hold Shamir shares of a
 * document master key S. During a refresh every guardian i publishes a
 * commitment to a zero-polynomial h_i(x) with h_i(0) = 0 and privately
 * sends h_i(j) to guardian j. Each guardian then updates:
 *
 *     S_j' = S_j + sum_{i} h_i(j)
 *
 * The shared secret S(0) is unchanged because sum_i h_i(0) = 0, while any
 * set of shares that includes pre-refresh material becomes useless - old
 * and new shares can no longer be combined to reconstruct S.
 *
 * All arithmetic happens in the prime field GF(p), p = 2^127 - 1.
 */

export const PSS_FIELD_PRIME = (1n << 127n) - 1n;

export interface Share {
  /** Evaluation point x_j (never 0). */
  x: bigint;
  /** Share value y_j = f(x_j). */
  y: bigint;
}

/** Uniform random bigint in [0, p). */
function randomFieldElement(): bigint {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value % PSS_FIELD_PRIME;
}

function mod(value: bigint): bigint {
  return ((value % PSS_FIELD_PRIME) + PSS_FIELD_PRIME) % PSS_FIELD_PRIME;
}

/**
 * Build a random polynomial of the given degree whose intercept at x = 0
 * equals `intercept`. For zero-polynomials pass intercept = 0.
 */
export function makeRandomPolynomial(intercept: bigint, degree: number): bigint[] {
  if (!Number.isInteger(degree) || degree < 0) {
    throw new Error("Polynomial degree must be a non-negative integer");
  }
  const coeffs: bigint[] = [mod(intercept)];
  for (let i = 0; i < degree; i++) {
    coeffs.push(randomFieldElement());
  }
  return coeffs;
}

/** Horner evaluation of a polynomial (little-endian coefficients). */
export function evaluatePolynomial(coeffs: bigint[], x: bigint): bigint {
  let result = 0n;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    result = mod(result * mod(x) + coeffs[i]);
  }
  return result;
}

/**
 * Split `secret` into `numShares` shares with reconstruction threshold
 * `threshold` using Shamir's Secret Sharing.
 */
export function splitSecret(secret: bigint, threshold: number, numShares: number): Share[] {
  if (threshold < 1 || threshold > numShares) {
    throw new Error("Threshold must satisfy 1 <= threshold <= numShares");
  }
  const poly = makeRandomPolynomial(mod(secret), threshold - 1);
  const shares: Share[] = [];
  for (let j = 1; j <= numShares; j++) {
    const x = BigInt(j);
    shares.push({ x, y: evaluatePolynomial(poly, x) });
  }
  return shares;
}

/**
 * Generate one guardian's zero-share contributions h_i(j) for every
 * evaluation point. The returned map satisfies h_i(0) = 0 by construction.
 */
export function generateZeroShares(
  threshold: number,
  points: bigint[]
): Map<bigint, bigint> {
  const zeroPoly = makeRandomPolynomial(0n, threshold - 1);
  const contributions = new Map<bigint, bigint>();
  for (const point of points) {
    contributions.set(point, evaluatePolynomial(zeroPoly, point));
  }
  return contributions;
}

/**
 * Apply one guardian's refresh contribution to a share: S_j <- S_j + h_i(j).
 */
export function addContribution(share: Share, contribution: bigint): Share {
  return { x: share.x, y: mod(share.y + contribution) };
}

/**
 * Lagrange interpolation at x = 0 over the provided shares.
 * Requires at least `threshold` distinct points.
 */
export function combineShares(shares: Share[], threshold: number): bigint {
  if (shares.length < threshold) {
    throw new Error(`Need at least ${threshold} shares to reconstruct`);
  }
  const used = shares.slice(0, threshold);
  let secret = 0n;
  for (let i = 0; i < used.length; i++) {
    let numerator = 1n;
    let denominator = 1n;
    for (let j = 0; j < used.length; j++) {
      if (i === j) continue;
      numerator = mod(numerator * used[j].x);
      denominator = mod(denominator * (used[j].x - used[i].x));
    }
    // Denominator inverse via Fermat's little theorem (p prime).
    const inverse = powMod(denominator, PSS_FIELD_PRIME - 2n);
    secret = mod(secret + used[i].y * mod(numerator * inverse));
  }
  return secret;
}

function powMod(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

export interface ProactiveRefreshResult {
  /** Refreshed shares S_j' - one per guardian, same order as inputs. */
  refreshedShares: Share[];
  /** The master key recovered from the refreshed shares (== original). */
  recoveredSecret: bigint;
  /** Epoch label incremented by the caller for each refresh round. */
  epoch: number;
}

/**
 * Orchestrate a full multi-party proactive refresh.
 *
 * Every guardian generates its zero-polynomial contributions; an optional
 * `delayFn` simulates network latency between guardian submissions so the
 * protocol can be exercised under realistic asynchronous conditions.
 */
export async function proactiveRefresh(
  shares: Share[],
  threshold: number,
  epoch: number,
  delayFn?: (guardianIndex: number) => Promise<void>
): Promise<ProactiveRefreshResult> {
  const points = shares.map((s) => s.x);

  const allContributions: Map<bigint, bigint>[] = [];
  for (let i = 0; i < shares.length; i++) {
    if (delayFn) {
      await delayFn(i);
    }
    allContributions.push(generateZeroShares(threshold, points));
  }

  const refreshedShares = shares.map((share) => {
    let updated = share;
    for (let i = 0; i < allContributions.length; i++) {
      updated = addContribution(updated, allContributions[i].get(share.x)!);
    }
    return updated;
  });

  return {
    refreshedShares,
    recoveredSecret: combineShares(refreshedShares, threshold),
    epoch,
  };
}
