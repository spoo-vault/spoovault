/**
 * Shared Wesolowski VDF helpers for Hardhat tests (CommonJS).
 * Mirrors src/utils/vdf.ts Fiat–Shamir + prove so on-chain checks match.
 */
const { keccak256, solidityPacked, hexlify } = require("ethers");

function toBytesBE(value) {
  let hex = BigInt(value).toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}

function byteLength(value) {
  const v = BigInt(value);
  if (v === 0n) return 1;
  return Math.ceil(v.toString(16).length / 2);
}

function toBytesBEPadded(value, width) {
  const raw = toBytesBE(value);
  if (raw.length === width) return raw;
  if (raw.length > width) return raw.subarray(raw.length - width);
  const out = Buffer.alloc(width);
  raw.copy(out, width - raw.length);
  return out;
}

function modPow(base, exp, mod) {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = BigInt(exp);
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function evaluateVdf(x, T, N) {
  let y = BigInt(x) % BigInt(N);
  const n = BigInt(N);
  for (let i = 0; i < T; i++) y = (y * y) % n;
  return y;
}

function fiatShamirChallenge(x, y, T, N, challengeBits = 128) {
  const n = BigInt(N);
  const onChain = byteLength(n) <= 32;
  const width = onChain ? 32 : byteLength(n);
  const digest = keccak256(
    solidityPacked(
      ["bytes", "bytes", "uint64", "bytes"],
      [
        toBytesBEPadded(BigInt(x) % n, width),
        toBytesBEPadded(BigInt(y) % n, width),
        BigInt(T),
        toBytesBEPadded(n, width),
      ]
    )
  );
  const mask = (1n << BigInt(challengeBits)) - 1n;
  let l = BigInt(digest) & mask;
  if (l < 3n) l = 3n;
  if ((l & 1n) === 0n) l += 1n;
  return l;
}

function proveWesolowski(x, T, N, challengeBits = 128) {
  const n = BigInt(N);
  const xMod = BigInt(x) % n;
  let y = xMod;
  for (let i = 0; i < T; i++) y = (y * y) % n;

  const l = fiatShamirChallenge(xMod, y, T, n, challengeBits);
  let pi = 1n;
  let rem = 1n;
  for (let i = 0; i < T; i++) {
    const doubled = rem << 1n;
    const bit = doubled >= l ? 1n : 0n;
    rem = doubled % l;
    pi = (pi * pi) % n;
    if (bit === 1n) pi = (pi * xMod) % n;
  }
  return { y, pi, l, r: rem };
}

function findPrimeNear(start) {
  let n = BigInt(start) | 1n;
  const isProbablePrime = (cand) => {
    if (cand < 2n) return false;
    if (cand === 2n || cand === 3n) return true;
    if ((cand & 1n) === 0n) return false;
    let d = cand - 1n;
    let s = 0n;
    while ((d & 1n) === 0n) {
      d >>= 1n;
      s += 1n;
    }
    for (const a of [2n, 3n, 5n, 7n, 11n, 13n, 17n]) {
      let x = modPow(a % cand, d, cand);
      if (x === 1n || x === cand - 1n) continue;
      let ok = false;
      for (let r = 1n; r < s; r++) {
        x = (x * x) % cand;
        if (x === cand - 1n) {
          ok = true;
          break;
        }
      }
      if (!ok) return false;
    }
    return true;
  };
  while (!isProbablePrime(n)) n += 2n;
  return n;
}

function fixedTestModulus(bits = 256) {
  const half = bits / 2;
  const P = findPrimeNear((1n << BigInt(half - 1)) + 12345n);
  const Q = findPrimeNear((1n << BigInt(half - 1)) + 67891n);
  return P * Q;
}

function proofToContractArgs(x, T, N, proof) {
  return {
    x: BigInt(x) % BigInt(N),
    y: proof.y,
    pi: proof.pi,
    N: BigInt(N),
    T,
    l: proof.l,
  };
}

module.exports = {
  evaluateVdf,
  proveWesolowski,
  fiatShamirChallenge,
  fixedTestModulus,
  proofToContractArgs,
  byteLength,
  modPow,
  hexlify,
};
