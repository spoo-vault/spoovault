/**
 * Proactive Secret Sharing (PSS) utilities.
 *
 * Implements the zero-sharing share-refresh protocol used by SpooVault
 * guardian rotation (see issue #75 and issue #91). Guardians hold Shamir /
 * Feldmann VSS shares of a document master key S. During a refresh, every
 * guardian i publishes commitments to a zero-polynomial h_i(x) with h_i(0) = 0
 * and privately sends h_i(j) to guardian j. Each guardian then updates:
 *
 *     S_j' = S_j + sum_{i} h_i(j)
 *
 * The shared secret S(0) is unchanged because sum_i h_i(0) = 0, while any
 * set of shares that includes pre-refresh material becomes useless - old
 * and new shares can no longer be combined to reconstruct S.
 *
 * Supports both:
 * 1. 256-bit safe-prime Feldmann VSS protocol over (VSS_Q, VSS_P, VSS_G) matching
 *    on-chain SpooVault commitments and encrypted guardian shares.
 * 2. Pure GF(2^127 - 1) field arithmetic building blocks.
 */

import {
  VSS_Q,
  VSS_P,
  VSS_G,
  verifyShare,
  reconstructSecret,
} from "../services/secrets.service";

export { VSS_Q, VSS_P, VSS_G };

// ============================================================================
// Feldmann VSS Proactive Secret Sharing (256-bit safe prime field)
// ============================================================================

export interface ZeroPolynomialVSS {
  /** Guardian index (1-based). */
  guardianIndex: number;
  /** Polynomial coefficients [b_0=0, b_1, ..., b_{k-1}] mod VSS_Q. */
  coefficients: bigint[];
  /** Feldman coefficient commitments [Z_0, Z_1, ..., Z_{k-1}] mod VSS_P in hex. */
  zeroCommitments: string[];
  /** Subshares h_i(j) evaluated for each guardian j in 1..numGuardians. */
  subshares: Map<number, bigint>;
}

export interface ProactiveRefreshVSSResult {
  /** Refreshed guardian shares formatted as `${x}-vss${lenHex}${hexVal}`. */
  refreshedShares: string[];
  /** Refreshed public Feldmann VSS polynomial commitments. */
  refreshedCommitments: string[];
  /** Master key recovered from refreshed shares (strictly identical to original). */
  recoveredSecret: string;
  /** Share epoch number. */
  epoch: number;
}

// Modular arithmetic helpers for VSS
function modAdd(a: bigint, b: bigint, m: bigint): bigint {
  return ((a + b) % m + m) % m;
}

function modMul(a: bigint, b: bigint, m: bigint): bigint {
  return ((a * b) % m + m) % m;
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let res = 1n;
  let b = ((base % m) + m) % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) {
      res = (res * b) % m;
    }
    b = (b * b) % m;
    e >>= 1n;
  }
  return res;
}

/** Uniform random bigint in [0, VSS_Q). */
function randomVssScalar(): bigint {
  const bytes = new Uint8Array(32);
  const cryptoObj =
    typeof window !== "undefined" && window.crypto
      ? window.crypto
      : typeof globalThis !== "undefined" && globalThis.crypto
      ? globalThis.crypto
      : undefined;

  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
    let hex = "";
    for (let j = 0; j < 32; j++) {
      hex += bytes[j].toString(16).padStart(2, "0");
    }
    return BigInt("0x" + hex) % VSS_Q;
  }

  let hex = "";
  for (let j = 0; j < 32; j++) {
    hex += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return BigInt("0x" + hex) % VSS_Q;
}

/**
 * Generate a guardian's zero-sharing polynomial h_i(x) with h_i(0) = 0,
 * its Feldmann commitments Z_{i,m} = g^{b_{i,m}} mod P, and subshares h_i(j) mod Q.
 */
export function generateZeroPolynomialVSS(
  threshold: number,
  numGuardians: number,
  guardianIndex: number = 1
): ZeroPolynomialVSS {
  if (threshold < 1 || threshold > numGuardians) {
    throw new Error("Threshold must satisfy 1 <= threshold <= numGuardians");
  }

  // h_i(x) = b_0 + b_1 x + ... + b_{k-1} x^{k-1} with b_0 = 0
  const coefficients: bigint[] = new Array(threshold);
  coefficients[0] = 0n; // h_i(0) = 0 by definition

  for (let m = 1; m < threshold; m++) {
    coefficients[m] = randomVssScalar();
  }

  // Compute zero-commitments Z_{i,m} = g^{b_{i,m}} mod P
  const zeroCommitments: string[] = new Array(threshold);
  for (let m = 0; m < threshold; m++) {
    const comm = modPow(VSS_G, coefficients[m], VSS_P);
    zeroCommitments[m] = comm.toString(16).padStart(66, "0");
  }

  // Evaluate h_i(j) for every guardian point j = 1..numGuardians
  const subshares = new Map<number, bigint>();
  for (let j = 1; j <= numGuardians; j++) {
    const jBig = BigInt(j);
    let val = 0n;
    let jPower = 1n;
    for (let m = 0; m < threshold; m++) {
      val = modAdd(val, modMul(coefficients[m], jPower, VSS_Q), VSS_Q);
      jPower = modMul(jPower, jBig, VSS_Q);
    }
    subshares.set(j, val);
  }

  return {
    guardianIndex,
    coefficients,
    zeroCommitments,
    subshares,
  };
}

/**
 * Verify a zero-share contribution h_i(j) against guardian i's zero-commitments:
 * Checks whether g^{h_i(j)} mod P == prod_{m=0}^{k-1} (Z_{i,m})^{(j^m mod Q)} mod P.
 */
export function verifyZeroShareContribution(
  contribution: bigint,
  x: number,
  zeroCommitments: string[]
): boolean {
  try {
    const k = zeroCommitments.length;
    const xBig = BigInt(x);

    // Left-hand side: g^{h_i(j)} mod P
    const lhs = modPow(VSS_G, contribution, VSS_P);

    // Right-hand side: prod_{m=0}^{k-1} (Z_{i,m})^{j^m} mod P
    let rhs = 1n;
    for (let m = 0; m < k; m++) {
      const zm = BigInt("0x" + zeroCommitments[m]);
      const xPower = modPow(xBig, BigInt(m), VSS_Q);
      const term = modPow(zm, xPower, VSS_P);
      rhs = modMul(rhs, term, VSS_P);
    }

    return lhs === rhs;
  } catch {
    return false;
  }
}

/**
 * Update one guardian's Feldmann VSS share with all zero-share contributions:
 * S_j' = S_j + sum_{i} h_i(j) mod VSS_Q.
 */
export function updateShareVSS(
  currentShareStr: string,
  zeroContributions: bigint[]
): string {
  const parts = currentShareStr.split("-");
  if (parts.length !== 2) {
    throw new Error(`Invalid share string format: ${currentShareStr}`);
  }
  const x = parseInt(parts[0], 10);
  let hex = parts[1];
  let lenHex = "40"; // default 64 chars
  if (hex.startsWith("vss")) {
    lenHex = hex.slice(3, 5);
    hex = hex.slice(5);
  } else {
    throw new Error("Cannot update legacy non-VSS share with VSS zero-shares");
  }

  let y = BigInt("0x" + hex);
  for (const contrib of zeroContributions) {
    y = modAdd(y, contrib, VSS_Q);
  }

  const updatedHex = y.toString(16).padStart(64, "0");
  return `${x}-vss${lenHex}${updatedHex}`;
}

/**
 * Update the Feldmann VSS public polynomial commitments:
 * C'_m = C_m * prod_{i} Z_{i,m} mod VSS_P.
 * For m=0: C'_0 = C_0 because sum_i h_i(0) = 0 and each Z_{i,0} = 1.
 */
export function updateCommitmentsVSS(
  currentCommitments: string[],
  zeroCommitmentsMatrix: string[][]
): string[] {
  const k = currentCommitments.length;
  const updated: string[] = new Array(k);

  for (let m = 0; m < k; m++) {
    let cm = BigInt("0x" + currentCommitments[m]);
    for (const guardianCommitments of zeroCommitmentsMatrix) {
      if (guardianCommitments.length !== k) {
        throw new Error("Mismatched zero-commitment vector length");
      }
      const zm = BigInt("0x" + guardianCommitments[m]);
      cm = modMul(cm, zm, VSS_P);
    }
    updated[m] = cm.toString(16).padStart(66, "0");
  }

  // Strictly assert C'_0 == C_0 (master key commitment invariance)
  const initialC0 = BigInt("0x" + currentCommitments[0]);
  const finalC0 = BigInt("0x" + updated[0]);
  if (initialC0 !== finalC0) {
    throw new Error("Master secret commitment changed during zero-sharing refresh");
  }

  return updated;
}

/**
 * Orchestrate a full multi-party proactive refresh over Feldmann VSS.
 * Supports asynchronous guardian execution with optional simulated network latency.
 */
export async function proactiveRefreshVSS(
  shares: string[],
  commitments: string[],
  threshold: number,
  epoch: number,
  delayFn?: (guardianIndex: number) => Promise<void>
): Promise<ProactiveRefreshVSSResult> {
  const n = shares.length;
  if (threshold < 1 || threshold > n) {
    throw new Error("Threshold must satisfy 1 <= threshold <= numShares");
  }

  // Step 1: Every guardian generates their zero-polynomial & commitments
  const zeroPolys: ZeroPolynomialVSS[] = [];
  for (let i = 0; i < n; i++) {
    if (delayFn) {
      await delayFn(i);
    }
    zeroPolys.push(generateZeroPolynomialVSS(threshold, n, i + 1));
  }

  // Step 2: Verify all zero-share contributions h_i(j) against published zero-commitments
  for (let i = 0; i < n; i++) {
    const poly = zeroPolys[i];
    for (let j = 1; j <= n; j++) {
      const contrib = poly.subshares.get(j)!;
      const valid = verifyZeroShareContribution(contrib, j, poly.zeroCommitments);
      if (!valid) {
        throw new Error(
          `Zero-share contribution from guardian ${i + 1} to guardian ${j} failed verification`
        );
      }
    }
  }

  // Step 3: Each guardian updates their share S_j' = S_j + sum_i h_i(j)
  const refreshedShares: string[] = [];
  for (let j = 0; j < n; j++) {
    const guardianPoint = j + 1;
    const contributions = zeroPolys.map((p) => p.subshares.get(guardianPoint)!);
    const updatedShare = updateShareVSS(shares[j], contributions);
    refreshedShares.push(updatedShare);
  }

  // Step 4: Update public commitments C'_m = C_m * prod_i Z_{i,m} mod P
  const zeroCommitmentsMatrix = zeroPolys.map((p) => p.zeroCommitments);
  const refreshedCommitments = updateCommitmentsVSS(commitments, zeroCommitmentsMatrix);

  // Step 5: Verify that all refreshed shares verify against the updated commitments
  for (const share of refreshedShares) {
    if (!verifyShare(share, refreshedCommitments)) {
      throw new Error("Refreshed share failed verification against updated commitments");
    }
  }

  // Step 6: Verify master key reconstruction
  const recoveredSecret = reconstructSecret(refreshedShares.slice(0, threshold));
  const originalSecret = reconstructSecret(shares.slice(0, threshold));
  if (recoveredSecret !== originalSecret) {
    throw new Error("Master secret altered after proactive secret resharing");
  }

  return {
    refreshedShares,
    refreshedCommitments,
    recoveredSecret,
    epoch,
  };
}

// ============================================================================
// GF(2^127 - 1) Shamir Building Blocks (Backward-Compatible Utilities)
// ============================================================================

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
  if (typeof globalThis !== "undefined" && globalThis.crypto) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
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
 * `threshold` using Shamir's Secret Sharing over GF(2^127 - 1).
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
 * Orchestrate a full multi-party proactive refresh over GF(2^127 - 1).
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
