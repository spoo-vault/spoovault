//! Soroban native Ed25519 / Curve25519 threshold signature verification module.
//!
//! Verifies multi-guardian threshold signatures in a single Soroban contract invocation
//! using Soroban host environment crypto primitives (`env.crypto().ed25519_verify`).
//! Includes nonce replay protection and ledger sequence expiration bounds.

use soroban_sdk::{contracterror, contracttype, panic_with_error, Bytes, BytesN, Env, Vec};

/// Byte prefix for domain-separated threshold signature payloads.
pub const THRESHOLD_PREFIX: &[u8] = b"SpooVaultThresholdSig";

/// Lifetime constants for persistent storage of used nonces (~30 days = 518,400 ledgers)
pub const NONCE_LIFETIME_THRESHOLD: u32 = 120_960;
pub const NONCE_BUMP_AMOUNT: u32 = 518_400;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ThresholdError {
    InvalidSignature = 1,
    ThresholdNotMet = 2,
    DuplicateSigner = 3,
    PayloadExpired = 4,
    NonceAlreadyUsed = 5,
    LengthMismatch = 6,
    InvalidThreshold = 7,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ThresholdDataKey {
    UsedNonce(u64),
}

/// Verifies a batch of Ed25519 threshold signatures against a signed message payload.
///
/// Parameters:
/// - `env`: Soroban environment reference
/// - `message`: Raw message bytes being signed / approved
/// - `signatures`: Batch of 64-byte Ed25519 signatures
/// - `public_keys`: Batch of 32-byte Ed25519 public keys corresponding to signers
/// - `threshold`: Minimum required distinct valid signatures ($K$)
/// - `nonce`: Unique replay-protection nonce
/// - `expiration_ledger`: Ledger sequence number after which the payload is invalid
pub fn verify_threshold_signatures_internal(
    env: &Env,
    message: &Bytes,
    signatures: &Vec<BytesN<64>>,
    public_keys: &Vec<BytesN<32>>,
    threshold: u32,
    nonce: u64,
    expiration_ledger: u32,
) -> bool {
    // 1. Validate threshold bounds
    let sig_count = signatures.len();
    let pk_count = public_keys.len();

    if threshold == 0 || sig_count < threshold || sig_count != pk_count {
        panic_with_error!(env, ThresholdError::InvalidSignature);
    }

    // 2. Check expiration ledger sequence
    let current_ledger = env.ledger().sequence();
    if current_ledger > expiration_ledger {
        panic_with_error!(env, ThresholdError::InvalidSignature);
    }

    // 3. Check nonce replay protection
    let nonce_key = ThresholdDataKey::UsedNonce(nonce);
    if env.storage().persistent().has(&nonce_key) {
        panic_with_error!(env, ThresholdError::InvalidSignature);
    }

    // 4. Ensure all public keys are distinct (prevent duplicate signature counting)
    for i in 0..pk_count {
        let pk_i = public_keys.get(i).unwrap();
        for j in (i + 1)..pk_count {
            let pk_j = public_keys.get(j).unwrap();
            if pk_i == pk_j {
                panic_with_error!(env, ThresholdError::InvalidSignature);
            }
        }
    }

    // 5. Construct payload: THRESHOLD_PREFIX || nonce (8 bytes BE) || expiration_ledger (4 bytes BE) || message
    let mut payload = Bytes::new(env);
    payload.extend_from_slice(THRESHOLD_PREFIX);
    payload.extend_from_slice(&nonce.to_be_bytes());
    payload.extend_from_slice(&expiration_ledger.to_be_bytes());
    payload.append(message);

    // 6. Verify each Ed25519 signature with Soroban host crypto primitive
    for i in 0..sig_count {
        let pk = public_keys.get(i).unwrap();
        let sig = signatures.get(i).unwrap();
        // Host crypto panics / halts if signature is invalid
        env.crypto().ed25519_verify(&pk, &payload, &sig);
    }

    // 7. Mark nonce as consumed and extend TTL
    env.storage().persistent().set(&nonce_key, &true);
    env.storage()
        .persistent()
        .extend_ttl(&nonce_key, NONCE_LIFETIME_THRESHOLD, NONCE_BUMP_AMOUNT);

    true
}
