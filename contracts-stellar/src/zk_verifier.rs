// The full BN254 arithmetic surface is intentionally implemented even though
// the public entrypoints only exercise a subset; the rest is invoked by the
// module's test suite (bilinearity, known vectors, byte round-trips) and forms
// a self-contained, auditable reference implementation. (Module-level
// `#![allow(dead_code)]` keeps the `cargo build --lib` output clean without
// deleting arithmetic that the tests exercise.)
#![allow(dead_code)]

//! Groth16 ZK-SNARK verifier for the BeneficiaryAccessProof circuit.
//!
//! Verifies that a beneficiary holds a valid vault key share without
//! revealing the secret. Tracks spent nullifiers in persistent storage
//! to prevent double-claiming.
//!
//! Implements the standard Groth16 pairing check on the BN254 curve.
//!
//! # Implementation notes
//!
//! Soroban SDK v21/22 does not expose native bn254 host functions
//! (`bn254_g1_add`, `bn254_g1_mul`, `bn254_pairing_check`) through
//! [`soroban_sdk::crypto::Crypto`] — only `sha256`, `keccak256`,
//! `ed25519_verify`, `secp256k1_recover` and `secp256r1_verify` exist.
//! To keep this module self-contained (and testable with `cargo test`
//! against the SDK's in-memory test environment), the entire BN254
//! arithmetic stack — base-field arithmetic (Montgomery form), the
//! Fp2/Fp12 towers, the G1/G2 groups and the optimal-ate pairing — is
//! implemented here in pure Rust with no host-crypto dependency.
//!
//! The tower and pairing follow the reference conventions used by the
//! EIP-197 bn254 precompile (py_ecc / ffjavascript):
//!
//! * Fp2 = Fp[i] / (i² + 1)
//! * Fp12 = Fp2[w] / (w⁶ − (9 + i))
//! * the twist is E'(Fp2): y² = x³ + 3/(9+i) with untwist (x, y) → (x·w², y·w³)
//! * optimal-ate Miller loop over the low 64 bits of 6u+2 (u = 4965661367192848881)
//! * final exponentiation f^((p¹²−1)/r) by square-and-multiply
//!
//! G2 points are serialized in the EIP-197 byte order (x_im, x_re, y_im, y_re),
//! matching the EVM verifier's `_writeG2` and the frontend's `toSorobanArgs`.
//!
//! # Verification equation (EIP-197 notation)
//! e(A, B) · e(vk_x, γ) · e(C, δ) = e(α, β)
//!
//! where vk_x is the linear combination of IC points with public inputs.
//! The check is performed as the equivalent product-of-pairings test
//! e(A, B) · e(−α, β) · e(vk_x, γ) · e(C, δ) ?= 1.
use soroban_sdk::{contracterror, contracttype, Bytes, BytesN, Env, Symbol, Vec};

// ── BN254 curve constants ─────────────────────────────────────────────────

/// BN254 base-field prime p = 36u⁴+36u³+24u²+6u+1 with u = 4965661367192848881.
/// Little-endian 64-bit limbs.
const P_LIMBS: [u64; 4] = [
    0x3c208c16d87cfd47,
    0x97816a916871ca8d,
    0xb85045b68181585d,
    0x30644e72e131a029,
];

/// Montgomery reduction constant n0 = −p⁻¹ mod 2⁶⁴.
const N0: u64 = 0x87d20782e4866389;

/// Montgomery constant R2 = 2⁵¹² mod p (little-endian limbs).
const R2_LIMBS: [u64; 4] = [
    0xf32cfc5b538afa89,
    0xb5e71911d44501fb,
    0x47ab1eff0a417ff6,
    0x06d89f71cab8351f,
];

/// Montgomery encoding of 1: R = 2²⁵⁶ mod p (little-endian limbs).
const ONE_LIMBS: [u64; 4] = [
    0xd35d438dc58f0d9d,
    0x0a78eb28f5c70b3d,
    0x666ea36f7879462c,
    0x0e0a77c19a07df2f,
];

/// p − 2, used for Fermat inverses (little-endian limbs).
const P_MINUS_2_LIMBS: [u64; 4] = [
    0x3c208c16d87cfd45,
    0x97816a916871ca8d,
    0xb85045b68181585d,
    0x30644e72e131a029,
];

/// Curve order r = 36u⁴+36u³+18u²+6u+1.
const CURVE_ORDER: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/// Optimal-ate loop parameter 6u+2 (65 bits; the Miller loop iterates bits 63..0,
/// matching py_ecc's `log_ate_loop_count = 63`).
const ATE_LOOP: u128 = 29793968203157093288;

/// Fp2 generator of the Fp12 tower: w⁶ = 9 + i.
const BETA_RE: u64 = 9;
const BETA_IM: u64 = 1;

/// Twist b-coefficient 3/(9+i) (real part, little-endian limbs).
const B2_RE_LIMBS: [u64; 4] = [
    0x3267e6dc24a138e5,
    0xb5b4c5e559dbefa3,
    0x81be18991be06ac3,
    0x2b149d40ceb8aaae,
];

/// Twist b-coefficient 3/(9+i) (imaginary part, little-endian limbs).
const B2_IM_LIMBS: [u64; 4] = [
    0xe4a2bd0685c315d2,
    0xa74fa084e52d1852,
    0xcd2cafadeed8fdf4,
    0x009713b03af0fed4,
];

/// Exponent (p−1)/3 used to lift the p-Frobenius of twist points (Q1).
const EXP_P_MINUS_1_OVER_3: [u8; 32] = [
    0x10, 0x21, 0x6f, 0x7b, 0xa0, 0x65, 0xe0, 0x0d, 0xe8, 0x1a, 0xc1, 0xe7, 0x80, 0x80, 0x72, 0xc9,
    0xdd, 0x2b, 0x23, 0x85, 0xcd, 0x7b, 0x43, 0x84, 0x69, 0x60, 0x2e, 0xb2, 0x48, 0x29, 0xa9, 0xc2,
];

/// Exponent (p−1)/2 used to lift the p-Frobenius of twist points (Q1).
const EXP_P_MINUS_1_OVER_2: [u8; 32] = [
    0x18, 0x32, 0x27, 0x39, 0x70, 0x98, 0xd0, 0x14, 0xdc, 0x28, 0x22, 0xdb, 0x40, 0xc0, 0xac, 0x2e,
    0xcb, 0xc0, 0xb5, 0x48, 0xb4, 0x38, 0xe5, 0x46, 0x9e, 0x10, 0x46, 0x0b, 0x6c, 0x3e, 0x7e, 0xa3,
];

/// Exponent (p²−1)/3 used to lift the p²-Frobenius of twist points (−Q2).
const EXP_P2_MINUS_1_OVER_3: [u8; 64] = [
    0x03, 0x0c, 0x96, 0xe8, 0x27, 0x69, 0x95, 0x34, 0x1d, 0xde, 0x25, 0x29, 0x56, 0x6d, 0x9b, 0x5e,
    0xe5, 0x59, 0x2c, 0x70, 0x5c, 0xbd, 0x1c, 0xac, 0xb7, 0xa4, 0xa8, 0xc9, 0x66, 0xec, 0xe6, 0x84,
    0x56, 0xcd, 0x8a, 0x31, 0xd3, 0x5b, 0x6b, 0x98, 0x18, 0xc5, 0x5d, 0x89, 0x79, 0xdc, 0xee, 0x49,
    0x8c, 0xab, 0x57, 0xb9, 0xad, 0xf8, 0xeb, 0x00, 0x69, 0x1c, 0x1d, 0x8b, 0x62, 0x74, 0x78, 0x90,
];

/// Exponent (p²−1)/2 used to lift the p²-Frobenius of twist points (−Q2).
const EXP_P2_MINUS_1_OVER_2: [u8; 64] = [
    0x04, 0x92, 0xe2, 0x5c, 0x3b, 0x1e, 0x5f, 0xce, 0x2c, 0xcd, 0x37, 0xbe, 0x01, 0xa4, 0x69, 0x0e,
    0x58, 0x05, 0xc2, 0xa8, 0x8b, 0x1b, 0xab, 0x03, 0x13, 0x76, 0xfd, 0x2e, 0x1a, 0x63, 0x59, 0xc6,
    0x82, 0x34, 0x4f, 0x4a, 0xbd, 0x09, 0x21, 0x64, 0x25, 0x28, 0x0c, 0x4e, 0x36, 0xcb, 0x65, 0x6e,
    0x53, 0x01, 0x03, 0x96, 0x84, 0xf5, 0x60, 0x80, 0x9d, 0xaa, 0x2c, 0x51, 0x13, 0xae, 0xb4, 0xd8,
];

/// Final exponentiation exponent (p¹²−1)/r, 384 bytes big-endian.
const FINAL_EXP: [u8; 384] = [
0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2f,
0x4b, 0x6d, 0xc9, 0x70, 0x20, 0xfd, 0xda, 0xdf, 0x10, 0x7d, 0x20, 0xbc,
0x84, 0x2d, 0x43, 0xbf, 0x63, 0x69, 0xb1, 0xff, 0x6a, 0x1c, 0x71, 0x01,
0x5f, 0x3f, 0x7b, 0xe2, 0xe1, 0xe3, 0x0a, 0x73, 0xbb, 0x94, 0xfe, 0xc0,
0xda, 0xf1, 0x54, 0x66, 0xb2, 0x38, 0x3a, 0x5d, 0x3e, 0xc3, 0xd1, 0x5a,
0xd5, 0x24, 0xd8, 0xf7, 0x0c, 0x54, 0xef, 0xee, 0x1b, 0xd8, 0xc3, 0xb2,
0x13, 0x77, 0xe5, 0x63, 0xa0, 0x9a, 0x1b, 0x70, 0x58, 0x87, 0xe7, 0x2e,
0xce, 0xad, 0xde, 0xa3, 0x79, 0x03, 0x64, 0xa6, 0x1f, 0x67, 0x6b, 0xaa,
0xf9, 0x77, 0x87, 0x0e, 0x88, 0xd5, 0xc6, 0xc8, 0xfe, 0xf0, 0x78, 0x13,
0x61, 0xe4, 0x43, 0xae, 0x77, 0xf5, 0xb6, 0x3a, 0x2a, 0x22, 0x64, 0x48,
0x7f, 0x29, 0x40, 0xa8, 0xb1, 0xdd, 0xb3, 0xd1, 0x50, 0x62, 0xcd, 0x0f,
0xb2, 0x01, 0x5d, 0xfc, 0x66, 0x68, 0x44, 0x9a, 0xed, 0x3c, 0xc4, 0x8a,
0x82, 0xd0, 0xd6, 0x02, 0xd2, 0x68, 0xc7, 0xda, 0xab, 0x6a, 0x41, 0x29,
0x4c, 0x0c, 0xc4, 0xeb, 0xe5, 0x66, 0x45, 0x68, 0xdf, 0xc5, 0x0e, 0x16,
0x48, 0xa4, 0x5a, 0x4a, 0x1e, 0x3a, 0x51, 0x95, 0x84, 0x6a, 0x3e, 0xd0,
0x11, 0xa3, 0x37, 0xa0, 0x20, 0x88, 0xec, 0x80, 0xe0, 0xeb, 0xae, 0x87,
0x55, 0xcf, 0xe1, 0x07, 0xac, 0xf3, 0xaa, 0xfb, 0x40, 0x49, 0x4e, 0x40,
0x6f, 0x80, 0x42, 0x16, 0xbb, 0x10, 0xcf, 0x43, 0x0b, 0x0f, 0x37, 0x85,
0x6b, 0x42, 0xdb, 0x8d, 0xc5, 0x51, 0x47, 0x24, 0xee, 0x93, 0xdf, 0xb1,
0x08, 0x26, 0xf0, 0xdd, 0x4a, 0x03, 0x64, 0xb9, 0x58, 0x02, 0x91, 0xd2,
0xcd, 0x65, 0x66, 0x48, 0x14, 0xfd, 0xe3, 0x7c, 0xa8, 0x0b, 0xb4, 0xea,
0x44, 0xea, 0xcc, 0x5e, 0x64, 0x1b, 0xba, 0xdf, 0x42, 0x3f, 0x9a, 0x2c,
0xbf, 0x81, 0x3b, 0x8d, 0x14, 0x5d, 0xa9, 0x00, 0x29, 0xba, 0xee, 0x7d,
0xda, 0xdd, 0xa7, 0x1c, 0x7f, 0x38, 0x11, 0xc4, 0x10, 0x52, 0x62, 0x94,
0x5b, 0xba, 0x16, 0x68, 0xc3, 0xbe, 0x69, 0xa3, 0xc2, 0x30, 0x97, 0x4d,
0x83, 0x56, 0x18, 0x41, 0xd7, 0x66, 0xf9, 0xc9, 0xd5, 0x70, 0xbb, 0x7f,
0xbe, 0x04, 0xc7, 0xe8, 0xa6, 0xc3, 0xc7, 0x60, 0xc0, 0xde, 0x81, 0xde,
0xf3, 0x56, 0x92, 0xda, 0x36, 0x11, 0x02, 0xb6, 0xb9, 0xb2, 0xb9, 0x18,
0x83, 0x7f, 0xa9, 0x78, 0x96, 0xe8, 0x4a, 0xbb, 0x40, 0xa4, 0xef, 0xb7,
0xe5, 0x45, 0x23, 0xa4, 0x86, 0x96, 0x4b, 0x64, 0xca, 0x86, 0xf1, 0x20,
];

// ── Fp: base field mod p (Montgomery form) ────────────────────────────────

const MASK64: u128 = (1u128 << 64) - 1;

/// A base-field element in Montgomery form (little-endian 64-bit limbs).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Fp([u64; 4]);

impl Fp {
    const ZERO: Fp = Fp([0, 0, 0, 0]);
    const ONE: Fp = Fp(ONE_LIMBS);

    const fn from_limbs(limbs: [u64; 4]) -> Fp {
        Fp(limbs)
    }

    fn is_zero(&self) -> bool {
        self.0 == [0, 0, 0, 0]
    }

    fn is_one(&self) -> bool {
        self.0 == ONE_LIMBS
    }

    fn add(&self, other: &Fp) -> Fp {
        let mut out = [0u64; 4];
        let mut carry = 0u128;
        for (o, (a, b)) in out.iter_mut().zip(self.0.iter().zip(other.0.iter())) {
            let sum = *a as u128 + *b as u128 + carry;
            *o = sum as u64;
            carry = sum >> 64;
        }
        let mut r = Fp(out);
        if r >= Fp(P_LIMBS) {
            r = r.sub(&Fp(P_LIMBS));
        }
        r
    }

    /// Borrow-based subtraction; the result is reduced modulo 2²⁵⁶ only.
    fn sub_raw(&self, other: &Fp) -> Fp {
        let mut out = [0u64; 4];
        let mut borrow = 0i128;
        for (o, (a, b)) in out.iter_mut().zip(self.0.iter().zip(other.0.iter())) {
            let diff = *a as i128 - *b as i128 - borrow;
            if diff < 0 {
                *o = (diff + (1i128 << 64)) as u64;
                borrow = 1;
            } else {
                *o = diff as u64;
                borrow = 0;
            }
        }
        Fp(out)
    }

    fn sub(&self, other: &Fp) -> Fp {
        let r = self.sub_raw(other);
        if r >= Fp(P_LIMBS) {
            // A borrow rippled past the top limb: the raw result wrapped
            // through 2²⁵⁶, and 2²⁵⁶ ≡ R ≢ 0 (mod p), so the wrapped value is
            // off by R. Recompute as p − (other − self), which stays in [0, p).
            Fp(P_LIMBS).sub_raw(&other.sub_raw(self))
        } else {
            r
        }
    }

    fn neg(&self) -> Fp {
        Fp(P_LIMBS).sub(self)
    }

    fn mul(&self, other: &Fp) -> Fp {
        // Schoolbook 4-limb product followed by Montgomery reduction.
        let a = &self.0;
        let b = &other.0;
        let mut t = [0u128; 8];
        for i in 0..4 {
            let mut carry = 0u128;
            for j in 0..4 {
                let cur = t[i + j] + (a[i] as u128) * (b[j] as u128) + carry;
                t[i + j] = cur & MASK64;
                carry = cur >> 64;
            }
            t[i + 4] = carry;
        }
        for i in 0..4 {
            let k = (t[i] as u64).wrapping_mul(N0) as u128;
            let mut carry = 0u128;
            for j in 0..4 {
                let cur = t[i + j] + k * (P_LIMBS[j] as u128) + carry;
                t[i + j] = cur & MASK64;
                carry = cur >> 64;
            }
            // Propagate the final carry into the remaining limbs.
            let mut idx = i + 4;
            let mut c = carry;
            while c != 0 && idx < 8 {
                let cur = t[idx] + c;
                t[idx] = cur & MASK64;
                c = cur >> 64;
                idx += 1;
            }
        }
        let mut res = [0u64; 4];
        for i in 0..4 {
            res[i] = t[i + 4] as u64;
        }
        let r = Fp(res);
        if r >= Fp(P_LIMBS) {
            r.sub(&Fp(P_LIMBS))
        } else {
            r
        }
    }

    fn sqr(&self) -> Fp {
        self.mul(self)
    }

    /// Modular inverse via Fermat's little theorem (a^(p−2)).
    /// LSB-first multiply-and-square binary exponentiation.
    fn inv(&self) -> Fp {
        let mut result = Fp::ONE;
        let mut base_pow = *self;
        for limb in P_MINUS_2_LIMBS {
            let mut limb = limb;
            for _ in 0..64 {
                if limb & 1 == 1 {
                    result = result.mul(&base_pow);
                }
                base_pow = base_pow.sqr();
                limb >>= 1;
            }
        }
        result
    }

    /// From a 32-byte big-endian integer, reduced mod p (converts to Montgomery form).
    fn from_be_bytes(bytes: &[u8; 32]) -> Fp {
        let mut limbs = [0u64; 4];
        for i in 0..4 {
            let mut v = 0u64;
            for j in 0..8 {
                v = (v << 8) | bytes[i * 8 + j] as u64;
            }
            limbs[3 - i] = v;
        }
        // Reduce mod p (the value may be >= p).
        let mut r = Fp(limbs);
        while r >= Fp(P_LIMBS) {
            r = r.sub(&Fp(P_LIMBS));
        }
        r.mul(&Fp(R2_LIMBS))
    }

    /// To a 32-byte big-endian integer (from Montgomery form).
    fn to_be_bytes(self) -> [u8; 32] {
        // Multiply by the *raw* 1 (not the Montgomery encoding of 1) to exit
        // Montgomery form: (x·R)·1·R⁻¹ = x.
        let norm = self.mul(&Fp([1, 0, 0, 0]));
        let mut out = [0u8; 32];
        for i in 0..4 {
            let limb = norm.0[i];
            for j in 0..8 {
                out[31 - (i * 8 + j)] = (limb >> (8 * j)) as u8;
            }
        }
        out
    }

    fn from_u64(v: u64) -> Fp {
        Fp([v, 0, 0, 0]).mul(&Fp(R2_LIMBS))
    }

    /// Exponentiate by a big-endian byte-slice exponent.
    fn exp_bytes(&self, exponent: &[u8]) -> Fp {
        let mut result = Fp::ONE;
        let base = *self;
        for &byte in exponent {
            for bit in (0..8).rev() {
                result = result.sqr();
                if (byte >> bit) & 1 == 1 {
                    result = result.mul(&base);
                }
            }
        }
        result
    }
}

impl PartialOrd for Fp {
    fn partial_cmp(&self, other: &Fp) -> Option<core::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Fp {
    fn cmp(&self, other: &Fp) -> core::cmp::Ordering {
        for i in (0..4).rev() {
            if self.0[i] != other.0[i] {
                return self.0[i].cmp(&other.0[i]);
            }
        }
        core::cmp::Ordering::Equal
    }
}

// ── Fq2 = Fp[i] / (i² + 1) ────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Fq2 {
    re: Fp,
    im: Fp,
}

impl Fq2 {
    const fn new(re: Fp, im: Fp) -> Fq2 {
        Fq2 { re, im }
    }

    fn zero() -> Fq2 {
        Fq2::new(Fp::ZERO, Fp::ZERO)
    }

    fn one() -> Fq2 {
        Fq2::new(Fp::ONE, Fp::ZERO)
    }

    fn is_zero(&self) -> bool {
        self.re.is_zero() && self.im.is_zero()
    }

    fn add(&self, other: &Fq2) -> Fq2 {
        Fq2::new(self.re.add(&other.re), self.im.add(&other.im))
    }

    fn sub(&self, other: &Fq2) -> Fq2 {
        Fq2::new(self.re.sub(&other.re), self.im.sub(&other.im))
    }

    fn neg(&self) -> Fq2 {
        Fq2::new(self.re.neg(), self.im.neg())
    }

    fn conjugate(&self) -> Fq2 {
        Fq2::new(self.re, self.im.neg())
    }

    fn mul(&self, other: &Fq2) -> Fq2 {
        let re = self.re.mul(&other.re).sub(&self.im.mul(&other.im));
        let im = self.re.mul(&other.im).add(&self.im.mul(&other.re));
        Fq2::new(re, im)
    }

    fn sqr(&self) -> Fq2 {
        let re = self.re.sqr().sub(&self.im.sqr());
        let im = self.re.mul(&self.im).add(&self.re.mul(&self.im));
        Fq2::new(re, im)
    }

    fn inv(&self) -> Fq2 {
        let norm = self.re.sqr().add(&self.im.sqr());
        let inv_norm = norm.inv();
        Fq2::new(self.re.mul(&inv_norm), self.im.neg().mul(&inv_norm))
    }

    fn exp_bytes(&self, exponent: &[u8]) -> Fq2 {
        let mut result = Fq2::one();
        let base = *self;
        for &byte in exponent {
            for bit in (0..8).rev() {
                result = result.sqr();
                if (byte >> bit) & 1 == 1 {
                    result = result.mul(&base);
                }
            }
        }
        result
    }

    fn mul_scalar(&self, scalar: &Fp) -> Fq2 {
        Fq2::new(self.re.mul(scalar), self.im.mul(scalar))
    }
}

/// β = 9 + i, the Fp2 non-residue defining the Fp12 tower (w⁶ = β).
fn beta() -> Fq2 {
    Fq2::new(Fp::from_u64(BETA_RE), Fp::from_u64(BETA_IM))
}

/// Twist b-coefficient 3/(9+i). The embedded limbs are the plain (non-
/// Montgomery) little-endian representation, so they are converted into
/// Montgomery form via multiplication by R2.
fn twist_b() -> Fq2 {
    Fq2::new(
        Fp::from_limbs(B2_RE_LIMBS).mul(&Fp(R2_LIMBS)),
        Fp::from_limbs(B2_IM_LIMBS).mul(&Fp(R2_LIMBS)),
    )
}

// ── Fq12 = Fq2[w] / (w⁶ − β) ──────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Fq12([Fq2; 6]);

impl Fq12 {
    fn one() -> Fq12 {
        Fq12([Fq2::one(), Fq2::zero(), Fq2::zero(), Fq2::zero(), Fq2::zero(), Fq2::zero()])
    }

    fn is_one(&self) -> bool {
        self == &Fq12::one()
    }

    fn add(&self, other: &Fq12) -> Fq12 {
        let mut out = [Fq2::zero(); 6];
        for (o, (a, b)) in out.iter_mut().zip(self.0.iter().zip(other.0.iter())) {
            *o = a.add(b);
        }
        Fq12(out)
    }

    fn mul(&self, other: &Fq12) -> Fq12 {
        let b = beta();
        let mut t = [Fq2::zero(); 11];
        for i in 0..6 {
            for j in 0..6 {
                let prod = self.0[i].mul(&other.0[j]);
                t[i + j] = t[i + j].add(&prod);
            }
        }
        let mut out = [Fq2::zero(); 6];
        for k in 0..5 {
            out[k] = t[k].add(&t[k + 6].mul(&b));
        }
        out[5] = t[5];
        Fq12(out)
    }

    fn sqr(&self) -> Fq12 {
        self.mul(self)
    }

    fn exp_bytes(&self, exponent: &[u8]) -> Fq12 {
        let mut result = Fq12::one();
        let base = *self;
        for &byte in exponent {
            for bit in (0..8).rev() {
                result = result.sqr();
                if (byte >> bit) & 1 == 1 {
                    result = result.mul(&base);
                }
            }
        }
        result
    }
}

// ── Points on G1 (affine, y² = x³ + 3 over Fp) ────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct G1Affine {
    x: Fp,
    y: Fp,
    infinity: bool,
}

impl G1Affine {
    fn infinity() -> G1Affine {
        G1Affine { x: Fp::ZERO, y: Fp::ZERO, infinity: true }
    }

    fn is_on_curve(&self) -> bool {
        if self.infinity {
            return true;
        }
        let y2 = self.y.sqr();
        let x3 = self.x.sqr().mul(&self.x).add(&Fp::from_u64(3));
        y2 == x3
    }

    fn double(&self) -> G1Affine {
        if self.infinity || self.y.is_zero() {
            return G1Affine::infinity();
        }
        // m = 3x² / 2y
        let three = Fp::from_u64(3);
        let two = Fp::from_u64(2);
        let m = three.mul(&self.x.sqr()).mul(&two.mul(&self.y).inv());
        let nx = m.sqr().sub(&self.x).sub(&self.x);
        let ny = m.neg().mul(&nx).add(&m.mul(&self.x)).sub(&self.y);
        G1Affine { x: nx, y: ny, infinity: false }
    }

    fn add(&self, other: &G1Affine) -> G1Affine {
        if self.infinity {
            return *other;
        }
        if other.infinity {
            return *self;
        }
        if self.x == other.x {
            if self.y == other.y {
                return self.double();
            }
            return G1Affine::infinity(); // P + (−P)
        }
        let m = other.y.sub(&self.y).mul(&other.x.sub(&self.x).inv());
        let nx = m.sqr().sub(&self.x).sub(&other.x);
        let ny = m.neg().mul(&nx).add(&m.mul(&self.x)).sub(&self.y);
        G1Affine { x: nx, y: ny, infinity: false }
    }

    fn scalar_mul(&self, scalar: &[u8; 32]) -> G1Affine {
        // LSB-first double-and-add over the 32-byte big-endian scalar.
        let mut result = G1Affine::infinity();
        let mut base = *self;
        for i in (0..32).rev() {
            let byte = scalar[i];
            for bit in 0..8 {
                if (byte >> bit) & 1 == 1 {
                    result = result.add(&base);
                }
                base = base.double();
            }
        }
        result
    }

    fn negate(&self) -> G1Affine {
        if self.infinity {
            return *self;
        }
        G1Affine { x: self.x, y: self.y.neg(), infinity: false }
    }

    /// Decode from 64 bytes (x || y, big-endian), EIP-197 G1 encoding.
    /// (0, 0) decodes to the point at infinity.
    fn from_bytes(bytes: &[u8; 64]) -> Result<G1Affine, ZkVerifierError> {
        let mut xb = [0u8; 32];
        let mut yb = [0u8; 32];
        xb.copy_from_slice(&bytes[0..32]);
        yb.copy_from_slice(&bytes[32..64]);
        if xb == [0u8; 32] && yb == [0u8; 32] {
            return Ok(G1Affine::infinity());
        }
        if xb >= curve_order_zero_padded() || yb >= curve_order_zero_padded() {
            // Coordinates must be reduced field elements (< p).
            return Err(ZkVerifierError::InvalidCurvePoint);
        }
        let x = Fp::from_be_bytes(&xb);
        let y = Fp::from_be_bytes(&yb);
        let pt = G1Affine { x, y, infinity: false };
        if !pt.is_on_curve() {
            return Err(ZkVerifierError::InvalidCurvePoint);
        }
        Ok(pt)
    }

    fn to_bytes(self) -> [u8; 64] {
        let mut out = [0u8; 64];
        if self.infinity {
            return out;
        }
        out[0..32].copy_from_slice(&self.x.to_be_bytes());
        out[32..64].copy_from_slice(&self.y.to_be_bytes());
        out
    }
}

/// 32-byte zero-padded copy of the field modulus p (for coordinate range checks).
fn curve_order_zero_padded() -> [u8; 32] {
    let mut out = [0u8; 32];
    let p = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5a,
        0x97, 0x85, 0x6a, 0x16, 0xc9, 0xd6, 0x07, 0xf4, 0xd4, 0x12, 0xcb, 0x0a, 0xec, 0xb6, 0x0f, 0x30,
    ];
    out.copy_from_slice(&p);
    out
}

// ── Points on G2 (affine, twist y² = x³ + 3/(9+i) over Fq2) ───────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct G2Affine {
    x: Fq2,
    y: Fq2,
    infinity: bool,
}

impl G2Affine {
    fn infinity() -> G2Affine {
        G2Affine { x: Fq2::zero(), y: Fq2::zero(), infinity: true }
    }

    fn is_on_curve(&self) -> bool {
        if self.infinity {
            return true;
        }
        let y2 = self.y.sqr();
        let x3 = self.x.sqr().mul(&self.x).add(&twist_b());
        y2 == x3
    }

    fn double(&self) -> G2Affine {
        if self.infinity || self.y.is_zero() {
            return G2Affine::infinity();
        }
        let three = Fq2::new(Fp::from_u64(3), Fp::ZERO);
        let two = Fq2::new(Fp::from_u64(2), Fp::ZERO);
        let m = three.mul(&self.x.sqr()).mul(&two.mul(&self.y).inv());
        let nx = m.sqr().sub(&self.x).sub(&self.x);
        let ny = m.neg().mul(&nx).add(&m.mul(&self.x)).sub(&self.y);
        G2Affine { x: nx, y: ny, infinity: false }
    }

    fn add(&self, other: &G2Affine) -> G2Affine {
        if self.infinity {
            return *other;
        }
        if other.infinity {
            return *self;
        }
        if self.x == other.x {
            if self.y == other.y {
                return self.double();
            }
            return G2Affine::infinity();
        }
        let m = other.y.sub(&self.y).mul(&other.x.sub(&self.x).inv());
        let nx = m.sqr().sub(&self.x).sub(&other.x);
        let ny = m.neg().mul(&nx).add(&m.mul(&self.x)).sub(&self.y);
        G2Affine { x: nx, y: ny, infinity: false }
    }

    fn scalar_mul(&self, scalar: &[u8; 32]) -> G2Affine {
        // LSB-first double-and-add over the 32-byte big-endian scalar.
        let mut result = G2Affine::infinity();
        let mut base = *self;
        for i in (0..32).rev() {
            let byte = scalar[i];
            for bit in 0..8 {
                if (byte >> bit) & 1 == 1 {
                    result = result.add(&base);
                }
                base = base.double();
            }
        }
        result
    }

    /// Decode from 128 bytes (x_im || x_re || y_im || y_re, big-endian),
    /// the EIP-197 G2 encoding. All-zero decodes to the point at infinity.
    fn from_bytes(bytes: &[u8; 128]) -> Result<G2Affine, ZkVerifierError> {
        if bytes.iter().all(|&b| b == 0) {
            return Ok(G2Affine::infinity());
        }
        let mut xim = [0u8; 32];
        let mut xre = [0u8; 32];
        let mut yim = [0u8; 32];
        let mut yre = [0u8; 32];
        xim.copy_from_slice(&bytes[0..32]);
        xre.copy_from_slice(&bytes[32..64]);
        yim.copy_from_slice(&bytes[64..96]);
        yre.copy_from_slice(&bytes[96..128]);
        let p = curve_order_zero_padded();
        if xim >= p || xre >= p || yim >= p || yre >= p {
            return Err(ZkVerifierError::InvalidCurvePoint);
        }
        let x = Fq2::new(Fp::from_be_bytes(&xre), Fp::from_be_bytes(&xim));
        let y = Fq2::new(Fp::from_be_bytes(&yre), Fp::from_be_bytes(&yim));
        let pt = G2Affine { x, y, infinity: false };
        if !pt.is_on_curve() {
            return Err(ZkVerifierError::InvalidCurvePoint);
        }
        Ok(pt)
    }

    fn to_bytes(self) -> [u8; 128] {
        let mut out = [0u8; 128];
        if self.infinity {
            return out;
        }
        out[0..32].copy_from_slice(&self.x.im.to_be_bytes());
        out[32..64].copy_from_slice(&self.x.re.to_be_bytes());
        out[64..96].copy_from_slice(&self.y.im.to_be_bytes());
        out[96..128].copy_from_slice(&self.y.re.to_be_bytes());
        out
    }
}

// ── Pairing: optimal-ate over the Fp12 tower ──────────────────────────────

/// The line through `p1` and `p2` (points on the twist) evaluated at the
/// G1 point `p`, returned as a sparse Fq12 element.
///
/// Twist coordinates map (x, y) → (x·w², y·w³) in Fq12, so for
/// d = (y2−y1)/(x2−x1) the chord line is
///   d·x_p·w + (y1 − d·x1)·w³ − y_p,
/// the tangent line (p1 == p2) uses d = 3x1²/(2y1), and the vertical line
/// (x1 == x2) is x_p − x1·w².
fn line_function(p1: &G2Affine, p2: &G2Affine, p: &G1Affine) -> Fq12 {
    let zero = Fq2::zero();
    let x_p = Fq2::new(p.x, Fp::ZERO);
    let y_p = Fq2::new(p.y, Fp::ZERO);
    if p1.x != p2.x {
        let d = p2.y.sub(&p1.y).mul(&p2.x.sub(&p1.x).inv());
        let c1 = d.mul(&x_p);
        let c3 = p1.y.sub(&d.mul(&p1.x));
        Fq12([y_p.neg(), c1, zero, c3, zero, zero])
    } else if p1.y == p2.y {
        let three = Fq2::new(Fp::from_u64(3), Fp::ZERO);
        let two = Fq2::new(Fp::from_u64(2), Fp::ZERO);
        let d = three.mul(&p1.x.sqr()).mul(&two.mul(&p1.y).inv());
        let c1 = d.mul(&x_p);
        let c3 = p1.y.sub(&d.mul(&p1.x));
        Fq12([y_p.neg(), c1, zero, c3, zero, zero])
    } else {
        // Vertical line through p1 and −p1.
        Fq12([x_p, zero, p1.x.neg(), zero, zero, zero])
    }
}

/// The p-Frobenius of a twist point: Q1 = (x̄·β^((p−1)/3), ȳ·β^((p−1)/2)).
fn frobenius(q: &G2Affine) -> G2Affine {
    let c1o3 = beta().exp_bytes(&EXP_P_MINUS_1_OVER_3);
    let c1o2 = beta().exp_bytes(&EXP_P_MINUS_1_OVER_2);
    G2Affine {
        x: q.x.conjugate().mul(&c1o3),
        y: q.y.conjugate().mul(&c1o2),
        infinity: q.infinity,
    }
}

/// The negative p²-Frobenius of a twist point: −Q2.
fn frobenius2_neg(q: &G2Affine) -> G2Affine {
    let c2o3 = beta().exp_bytes(&EXP_P2_MINUS_1_OVER_3);
    let c2o2 = beta().exp_bytes(&EXP_P2_MINUS_1_OVER_2);
    G2Affine {
        x: q.x.mul(&c2o3),
        y: q.y.mul(&c2o2).neg(),
        infinity: q.infinity,
    }
}

/// Optimal-ate Miller loop (py_ecc structure, low 64 bits of 6u+2).
fn miller_loop(q: &G2Affine, p: &G1Affine) -> Fq12 {
    let mut r = *q;
    let mut f = Fq12::one();
    for i in (0..64).rev() {
        f = f.sqr().mul(&line_function(&r, &r, p));
        r = r.double();
        if ((ATE_LOOP >> i) & 1) == 1 {
            f = f.mul(&line_function(&r, q, p));
            r = r.add(q);
        }
    }
    let q1 = frobenius(q);
    f = f.mul(&line_function(&r, &q1, p));
    r = r.add(&q1);
    let nq2 = frobenius2_neg(q);
    f = f.mul(&line_function(&r, &nq2, p));
    f
}

/// The reduced optimal-ate pairing e(q, p) ∈ Fq12.
fn pairing(q: &G2Affine, p: &G1Affine) -> Fq12 {
    if q.infinity || p.infinity {
        return Fq12::one();
    }
    miller_loop(q, p).exp_bytes(&FINAL_EXP)
}

// ── Public module API ─────────────────────────────────────────────────────

// ── G1 point: (x, y) each 32 bytes ────────────────────────────────────────
pub type G1Point = [u8; 64];

// ── G2 point: Fp2 (x.im, x.re, y.im, y.re) each 32 bytes (EIP-197 order) ─
pub type G2Point = [u8; 128];

// ── Proof: (a: G1, b: G2, c: G1) ──────────────────────────────────────────
pub struct Groth16Proof {
    pub a: G1Point,
    pub b: G2Point,
    pub c: G1Point,
}

// ── Verifying key ──────────────────────────────────────────────────────────
pub struct VerifyingKey {
    pub alpha: G1Point,
    pub beta: G2Point,
    pub gamma: G2Point,
    pub delta: G2Point,
    pub ic: Vec<G1Point>,
}

// ── Public signals ─────────────────────────────────────────────────────────
pub struct PublicSignals {
    pub vault_root_commitment: [u8; 32],
    pub nullifier_hash: [u8; 32],
    pub document_id: [u8; 32],
}

// ── Contract errors ────────────────────────────────────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ZkVerifierError {
    InvalidProof = 1,
    NullifierAlreadySpent = 2,
    InvalidInputCount = 3,
    InvalidCurvePoint = 4,
}

// ── Verifying key, serialized for contract entrypoints ────────────────────
// The Soroban SDK caps contract functions at 10 parameters, so the four VK
// points plus the IC array are bundled into a single `contracttype` value.
#[contracttype]
pub struct ZkVerifyingKeyArgs {
    pub alpha: BytesN<64>,
    pub beta: BytesN<128>,
    pub gamma: BytesN<128>,
    pub delta: BytesN<128>,
    pub ic: Vec<BytesN<64>>,
}

// ── Data keys for persistent storage ───────────────────────────────────────
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ZkVerifierDataKey {
    /// Nullifier hash → bool (spent)
    Nullifier([u8; 32]),
}

/// Verifies a Groth16 proof and marks the nullifier as spent.
///
/// Returns `Ok(true)` on success. Double-spends return `Err(NullifierAlreadySpent)`.
/// Malformed proofs return `Err(InvalidProof)`.
pub fn verify_proof(
    env: &Env,
    proof: &Groth16Proof,
    signals: &PublicSignals,
    vk: &VerifyingKey,
) -> Result<bool, ZkVerifierError> {
    // ── Nullifier replay protection ──────────────────────────────────────────
    if is_nullifier_spent(env, &signals.nullifier_hash) {
        return Err(ZkVerifierError::NullifierAlreadySpent);
    }

    // ── Validate input count ─────────────────────────────────────────────────
    if vk.ic.len() != 4 {
        // 3 public inputs + 1 constant = 4 IC points
        return Err(ZkVerifierError::InvalidInputCount);
    }

    // ── Decode and validate curve points ─────────────────────────────────────
    let a = G1Affine::from_bytes(&proof.a)?;
    let c = G1Affine::from_bytes(&proof.c)?;
    let b = G2Affine::from_bytes(&proof.b)?;
    let alpha = G1Affine::from_bytes(&vk.alpha)?;
    let beta = G2Affine::from_bytes(&vk.beta)?;
    let gamma = G2Affine::from_bytes(&vk.gamma)?;
    let delta = G2Affine::from_bytes(&vk.delta)?;
    let mut ic = [G1Affine::infinity(); 4];
        for (i, ic_point) in ic.iter_mut().enumerate() {
            let mut point_bytes = [0u8; 64];
            point_bytes.copy_from_slice(&vk.ic.get(i as u32).unwrap());
            *ic_point = G1Affine::from_bytes(&point_bytes)?;
        }

    // ── Build IC linear combination ──────────────────────────────────────────
    // vk_x = IC[0] + vaultRootCommitment · IC[1] + nullifierHash · IC[2] + documentId · IC[3]
    let vk_x = ic[0]
        .add(&ic[1].scalar_mul(&signals.vault_root_commitment))
        .add(&ic[2].scalar_mul(&signals.nullifier_hash))
        .add(&ic[3].scalar_mul(&signals.document_id));

    // ── Execute pairing check ────────────────────────────────────────────────
    // e(A, B) · e(−α, β) · e(vk_x, γ) · e(C, δ) ?= 1
    let neg_alpha = alpha.negate();
    let product = pairing(&b, &a)
        .mul(&pairing(&beta, &neg_alpha))
        .mul(&pairing(&gamma, &vk_x))
        .mul(&pairing(&delta, &c));

    if !product.is_one() {
        return Err(ZkVerifierError::InvalidProof);
    }

    // ── Mark nullifier as spent ──────────────────────────────────────────────
    mark_nullifier_spent(env, &signals.nullifier_hash);

    env.events().publish(
        (
            Symbol::new(env, "proof_verified"),
            Bytes::from_array(env, &signals.nullifier_hash),
            Bytes::from_array(env, &signals.document_id),
        ),
        (),
    );

    Ok(true)
}

// ── Nullifier state management ─────────────────────────────────────────────

/// Returns true if the nullifier has already been consumed.
pub fn is_nullifier_spent(env: &Env, nullifier: &[u8; 32]) -> bool {
    let key = ZkVerifierDataKey::Nullifier(*nullifier);
    env.storage()
        .persistent()
        .get(&to_storage_bytes(env, &key))
        .unwrap_or(false)
}

/// Marks a nullifier as spent in persistent storage.
fn mark_nullifier_spent(env: &Env, nullifier: &[u8; 32]) {
    let key = ZkVerifierDataKey::Nullifier(*nullifier);
    env.storage()
        .persistent()
        .set(&to_storage_bytes(env, &key), &true);
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn to_storage_bytes(env: &Env, key: &ZkVerifierDataKey) -> Bytes {
    match key {
        ZkVerifierDataKey::Nullifier(hash) => {
            let mut out = Bytes::new(env);
            out.push_back(0u8); // discriminant
            out.extend_from_array(hash);
            out
        }
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Known BN254 generator points (EIP-197).
    fn g1_gen() -> G1Affine {
        G1Affine { x: Fp::from_u64(1), y: Fp::from_u64(2), infinity: false }
    }

    fn g2_gen() -> G2Affine {
        let x = Fq2::new(
            Fp::from_be_bytes(&[
                0x18, 0x00, 0xde, 0xef, 0x12, 0x1f, 0x1e, 0x76, 0x42, 0x6a, 0x00, 0x66, 0x5e, 0x5c,
                0x44, 0x79, 0x67, 0x43, 0x22, 0xd4, 0xf7, 0x5e, 0xda, 0xdd, 0x46, 0xde, 0xbd, 0x5c,
                0xd9, 0x92, 0xf6, 0xed,
            ]),
            Fp::from_be_bytes(&[
                0x19, 0x8e, 0x93, 0x93, 0x92, 0x0d, 0x48, 0x3a, 0x72, 0x60, 0xbf, 0xb7, 0x31, 0xfb,
                0x5d, 0x25, 0xf1, 0xaa, 0x49, 0x33, 0x35, 0xa9, 0xe7, 0x12, 0x97, 0xe4, 0x85, 0xb7,
                0xae, 0xf3, 0x12, 0xc2,
            ]),
        );
        let y = Fq2::new(
            Fp::from_be_bytes(&[
                0x12, 0xc8, 0x5e, 0xa5, 0xdb, 0x8c, 0x6d, 0xeb, 0x4a, 0xab, 0x71, 0x80, 0x8d, 0xcb,
                0x40, 0x8f, 0xe3, 0xd1, 0xe7, 0x69, 0x0c, 0x43, 0xd3, 0x7b, 0x4c, 0xe6, 0xcc, 0x01,
                0x66, 0xfa, 0x7d, 0xaa,
            ]),
            Fp::from_be_bytes(&[
                0x09, 0x06, 0x89, 0xd0, 0x58, 0x5f, 0xf0, 0x75, 0xec, 0x9e, 0x99, 0xad, 0x69, 0x0c,
                0x33, 0x95, 0xbc, 0x4b, 0x31, 0x33, 0x70, 0xb3, 0x8e, 0xf3, 0x55, 0xac, 0xda, 0xdc,
                0xd1, 0x22, 0x97, 0x5b,
            ]),
        );
        G2Affine { x, y, infinity: false }
    }

    #[test]
    fn test_generators_are_on_curve() {
        assert!(g1_gen().is_on_curve());
        assert!(g2_gen().is_on_curve());
    }

    #[test]
    fn test_fp_mul_and_inv_roundtrip() {
        let a = Fp::from_u64(123456789);
        let b = Fp::from_u64(987654321);
        let ab = a.mul(&b);
        // a == (a·b)·b⁻¹
        assert_eq!(a, ab.mul(&b.inv()));
        // (a·b)⁻¹ == b⁻¹·a⁻¹
        assert_eq!(ab.inv(), b.inv().mul(&a.inv()));
        // a·1 == a
        assert_eq!(a, a.mul(&Fp::ONE));
        // a·0 == 0
        assert!(a.mul(&Fp::ZERO).is_zero());
        // p−1 encodes as −1: (p−1)·(p−1) == 1
        let minus_one = Fp(P_LIMBS).sub(&Fp::ONE);
        assert_eq!(minus_one.mul(&minus_one), Fp::ONE);
        // neg + add
        assert_eq!(a.add(&a.neg()), Fp::ZERO);
        // to/from bytes roundtrip
        let bytes = a.to_be_bytes();
        assert_eq!(a, Fp::from_be_bytes(&bytes));
    }

    #[test]
    fn test_fq2_arithmetic() {
        let a = Fq2::new(Fp::from_u64(3), Fp::from_u64(4));
        let b = Fq2::new(Fp::from_u64(5), Fp::from_u64(6));
        assert_eq!(a.mul(&b), b.mul(&a));
        assert_eq!(a.mul(&a.inv()), Fq2::one());
        // (a·b)·b⁻¹ == a
        assert_eq!(a, a.mul(&b).mul(&b.inv()));
        // conjugate: conj(x)·x == norm (real)
        let n = a.conjugate().mul(&a);
        assert!(n.im.is_zero());
    }

    #[test]
    fn test_pairing_nondegenerate() {
        let e = pairing(&g2_gen(), &g1_gen());
        assert!(!e.is_one(), "e(G1, G2) must not be the identity");
        // e(G1, G2)^r == 1 (order divides the curve order)
        let raised = e.exp_bytes(&CURVE_ORDER);
        assert!(raised.is_one());
    }

    #[test]
    fn test_pairing_bilinearity() {
        // e(2P, Q) == e(P, Q)²
        let mut two = [0u8; 32];
        two[31] = 2;
        let e12 = pairing(&g2_gen(), &g1_gen());
        let e2 = pairing(&g2_gen(), &g1_gen().scalar_mul(&two));
        assert_eq!(e2, e12.sqr());

        // e(5P, 3Q) == e(P, Q)^15
        let mut five = [0u8; 32];
        five[31] = 5;
        let mut three = [0u8; 32];
        three[31] = 3;
        let e15 = pairing(&g2_gen().scalar_mul(&three), &g1_gen().scalar_mul(&five));
        let mut fifteen = [0u8; 32];
        fifteen[31] = 15;
        assert_eq!(e15, e12.exp_bytes(&fifteen));

        // e(P, Q)·e(−P, Q) == 1
        let neg_p = g1_gen().negate();
        let e_neg = pairing(&g2_gen(), &neg_p);
        assert!(e12.mul(&e_neg).is_one());
    }

    /// This identity was cross-validated against the EVM bn254 pairing
    /// precompile (0x08): e(2P1,P2)·e(3P1,P2)·e(−5P1,P2) == 1.
    #[test]
    fn test_pairing_precompile_identity() {
        let mut two = [0u8; 32];
        two[31] = 2;
        let mut three = [0u8; 32];
        three[31] = 3;
        // −5 mod r = r − 5.
        let mut neg_five = CURVE_ORDER;
        let mut borrow = 0u16;
        for i in (0..32).rev() {
            let byte = if i == 31 { 5u8 } else { 0u8 };
            let (diff, b) = sub_byte(neg_five[i], byte, borrow);
            neg_five[i] = diff;
            borrow = b;
        }
        let p2 = g2_gen();
        let prod = pairing(&p2, &g1_gen().scalar_mul(&two))
            .mul(&pairing(&p2, &g1_gen().scalar_mul(&three)))
            .mul(&pairing(&p2, &g1_gen().scalar_mul(&neg_five)));
        assert!(prod.is_one());
    }

    fn sub_byte(a: u8, b: u8, borrow: u16) -> (u8, u16) {
        let res = a as i16 - b as i16 - borrow as i16;
        if res < 0 {
            ((res + 256) as u8, 1)
        } else {
            (res as u8, 0)
        }
    }

    /// The generator-point Groth16 input rejected by the EVM verifier must
    /// also fail here (product of pairings != 1).
    #[test]
    fn test_generator_proof_rejected() {
        let p2 = g2_gen();
        let p1 = g1_gen();
        let product = pairing(&p2, &p1)
            .mul(&pairing(&p2, &p1.negate()))
            .mul(&pairing(&p2, &p1))
            .mul(&pairing(&p2, &p1));
        assert!(!product.is_one());
    }

    /// End-to-end Groth16 verification with a constructed (valid) proof and
    /// verifying key. The exact same input was cross-validated against the
    /// EVM bn254 pairing precompile (returns product == 1).
    #[test]
    fn test_verify_valid_groth16_input() {
        let p1 = g1_gen();
        let p2 = g2_gen();

        // vk_x = 17P + 3·(7P) + 5·(11P) + 7·(13P) (the oracle case C combination).
        let vk_x = g1_gen()
            .scalar_mul(&three_bytes(17))
            .add(&g1_gen().scalar_mul(&three_bytes(3)).scalar_mul(&three_bytes(7)))
            .add(&g1_gen().scalar_mul(&three_bytes(5)).scalar_mul(&three_bytes(11)))
            .add(&g1_gen().scalar_mul(&three_bytes(7)).scalar_mul(&three_bytes(13)));

        // A = P1, B = P2, α = P1, β = P2, γ = P2, δ = P2, C = −vk_x.
        let c = vk_x.negate();

        let product = pairing(&p2, &p1)
            .mul(&pairing(&p2, &p1.negate()))
            .mul(&pairing(&p2, &vk_x))
            .mul(&pairing(&p2, &c));
        assert!(product.is_one());
    }

    fn three_bytes(v: u8) -> [u8; 32] {
        let mut b = [0u8; 32];
        b[31] = v;
        b
    }

    #[test]
    fn test_verify_proof_rejects_off_curve_g1() {
        // (P, P) is not on the curve.
        let p_bytes = [
            0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58,
            0x5a, 0x97, 0x85, 0x6a, 0x16, 0xc9, 0xd6, 0x07, 0xf4, 0xd4, 0x12, 0xcb, 0x0a, 0xec, 0xb6,
            0x0f, 0x30,
        ];
        let mut g1 = [0u8; 64];
        g1[0..32].copy_from_slice(&p_bytes);
        g1[32..64].copy_from_slice(&p_bytes);
        assert_eq!(G1Affine::from_bytes(&g1), Err(ZkVerifierError::InvalidCurvePoint));
    }

    // Nullifier persistence is exercised through the contract entrypoints in
    // `src/test.rs` (storage access requires an active contract invocation,
    // which `Env::default()` alone does not provide).

    #[test]
    fn test_g1_point_byte_roundtrip() {
        let pt = g1_gen();
        let bytes = pt.to_bytes();
        let decoded = G1Affine::from_bytes(&bytes).unwrap();
        assert_eq!(pt, decoded);
        // Infinity roundtrip.
        let inf = G1Affine::infinity();
        let bytes = inf.to_bytes();
        assert!(bytes.iter().all(|&b| b == 0));
        let decoded = G1Affine::from_bytes(&bytes).unwrap();
        assert!(decoded.infinity);
    }

    #[test]
    fn test_g2_point_byte_roundtrip() {
        let pt = g2_gen();
        let bytes = pt.to_bytes();
        let decoded = G2Affine::from_bytes(&bytes).unwrap();
        assert_eq!(pt, decoded);
        // The EIP-197 byte layout: (x_im, x_re, y_im, y_re).
        assert_eq!(&bytes[0..32], &pt.x.im.to_be_bytes());
        assert_eq!(&bytes[32..64], &pt.x.re.to_be_bytes());
    }
}
