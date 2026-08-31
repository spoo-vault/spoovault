//! Soroban cross-chain identity binding registry.
//!
//! Mirrors the EVM `CrossChainIdentityRegistry.sol` contract: a binding is
//! only recorded after BOTH signatures of
//! `BindIdentity(evmAddress, stellarPubkey, timestamp)` are verified on-chain
//! by the host crypto functions:
//!
//! - Stellar signature: Ed25519 over the 32-byte keccak256 message hash
//!   (produced by Freighter `signBlob`), verified with `ed25519_verify`.
//! - EVM signature: EIP-191 `personal_sign` over the message hash, recovered
//!   with `secp256k1_recover`; the recovered address must match
//!   `keccak256(pubkey)[12..32]` of the submitted EVM address.
//!
//! Invalid, stale or single-signed binding requests panic (revert). Lookups
//! mirror `resolveEvmToStellar` / `resolveStellarToEvm` on the EVM side.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Bytes, BytesN, Env,
};

/// Byte prefix of the signed payload; must match the EVM contract.
const BIND_PREFIX: &[u8] = b"BindIdentity";
/// EIP-191 `personal_sign` prefix for a 32-byte digest.
const ETH_PREFIX: &[u8] = b"\x19Ethereum Signed Message:\n32";
/// Bindings older than this (seconds) are rejected as stale.
const MAX_BINDING_AGE: u64 = 24 * 60 * 60;
/// Bindings further than this into the future are rejected (clock skew).
const MAX_FUTURE_DRIFT: u64 = 5 * 60;

/// A recorded cross-chain identity binding.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdentityBinding {
    pub evm_address: BytesN<20>,
    pub stellar_pubkey: BytesN<32>,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IdentityDataKey {
    EvmToStellar(BytesN<20>),
    StellarToEvm(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum IdentityRegistryError {
    InvalidTimestamp = 1,
    AlreadyBound = 2,
    EvmAddressMismatch = 3,
    InvalidEvmSignature = 4,
    InvalidStellarSignature = 5,
    NotBound = 6,
}

#[contract]
pub struct IdentityRegistry;

#[contractimpl]
impl IdentityRegistry {
    /// Records a dual-signed EVM <-> Stellar identity binding.
    ///
    /// The `evm_signature` is the 64-byte (r || s) ECDSA signature over the
    /// EIP-191 digest of the message hash; `evm_recovery_id` selects the
    /// correct y-parity of the recovered public key.
    pub fn bind_identity(
        env: Env,
        evm_address: BytesN<20>,
        stellar_pubkey: BytesN<32>,
        timestamp: u64,
        evm_signature: BytesN<64>,
        evm_recovery_id: u32,
        stellar_signature: BytesN<64>,
    ) -> IdentityBinding {
        let now = env.ledger().timestamp();
        if timestamp < now.saturating_sub(MAX_BINDING_AGE)
            || timestamp > now.saturating_add(MAX_FUTURE_DRIFT)
        {
            panic_with_error!(&env, IdentityRegistryError::InvalidTimestamp);
        }

        if env
            .storage()
            .persistent()
            .has(&IdentityDataKey::EvmToStellar(evm_address.clone()))
            || env
                .storage()
                .persistent()
                .has(&IdentityDataKey::StellarToEvm(stellar_pubkey.clone()))
        {
            panic_with_error!(&env, IdentityRegistryError::AlreadyBound);
        }

        // payload = "BindIdentity" || evm_address(20) || stellar_pubkey(32) || timestamp(8, BE)
        let contract_id = env.current_contract_address();
        let mut payload = Bytes::new(&env);
        payload.extend_from_slice(BIND_PREFIX);
        payload.extend_from_slice(&contract_id.to_array());
        payload.extend_from_array(&evm_address.to_array());
        payload.extend_from_array(&stellar_pubkey.to_array());
        payload.extend_from_slice(&timestamp.to_be_bytes());
        let message_hash: BytesN<32> = env.crypto().keccak256(&payload);

        // ---- EVM signature (MetaMask personal_sign) --------------------------
        let mut eth_input = Bytes::new(&env);
        eth_input.extend_from_slice(ETH_PREFIX);
        eth_input.extend_from_array(&message_hash.to_array());
        let evm_digest: BytesN<32> = env.crypto().keccak256(&eth_input);

        // Panics (reverts) when the signature itself is malformed.
        let recovered_pubkey: BytesN<65> =
            env.crypto()
                .secp256k1_recover(&evm_digest, &evm_signature, evm_recovery_id);
        let pubkey_hash: BytesN<32> = env.crypto().keccak256(&Bytes::from(recovered_pubkey));
        let hash_bytes: Bytes = pubkey_hash.into();
        let recovered_evm: BytesN<20> = match hash_bytes.slice(12..32).try_into() {
            Ok(addr) => addr,
            Err(_) => panic_with_error!(&env, IdentityRegistryError::InvalidEvmSignature),
        };
        if recovered_evm != evm_address {
            panic_with_error!(&env, IdentityRegistryError::EvmAddressMismatch);
        }

        // ---- Stellar signature (Freighter signBlob / Ed25519) ----------------
        // Panics (reverts) when the Ed25519 signature does not verify.
        let message_hash_bytes: Bytes = message_hash.clone().into();
        env.crypto()
            .ed25519_verify(&stellar_pubkey, &message_hash_bytes, &stellar_signature);

        let binding = IdentityBinding {
            evm_address: evm_address.clone(),
            stellar_pubkey: stellar_pubkey.clone(),
            timestamp,
        };
        env.storage().persistent().set(
            &IdentityDataKey::EvmToStellar(evm_address),
            &binding,
        );
        env.storage().persistent().set(
            &IdentityDataKey::StellarToEvm(stellar_pubkey),
            &binding,
        );
        binding
    }

    /// Resolves an EVM address to its bound Stellar identity.
    pub fn resolve_evm_to_stellar(env: Env, evm_address: BytesN<20>) -> Option<IdentityBinding> {
        env.storage()
            .persistent()
            .get(&IdentityDataKey::EvmToStellar(evm_address))
    }

    /// Resolves a Stellar public key to its bound EVM identity.
    pub fn resolve_stellar_to_evm(env: Env, stellar_pubkey: BytesN<32>) -> Option<IdentityBinding> {
        env.storage()
            .persistent()
            .get(&IdentityDataKey::StellarToEvm(stellar_pubkey))
    }

    /// Returns whether an EVM address has a recorded binding.
    pub fn is_bound(env: Env, evm_address: BytesN<20>) -> bool {
        env.storage()
            .persistent()
            .has(&IdentityDataKey::EvmToStellar(evm_address))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use k256::ecdsa::signature::hazmat::PrehashSigner;
    use k256::ecdsa::SigningKey as EvmSigningKey;
    use sha3::{Digest, Keccak256};
    use soroban_sdk::testutils::Ledger as _;
    use soroban_sdk::{BytesN, Env};
    use std::vec::Vec;

    struct TestKeys {
        evm_address: BytesN<20>,
        stellar_pubkey: BytesN<32>,
        evm_signature: BytesN<64>,
        evm_recovery_id: u32,
        stellar_signature: BytesN<64>,
    }

fn build_signed_binding(env: &Env, timestamp: u64, contract_id: &BytesN<32>) -> TestKeys {
    let stellar_sk = SigningKey::from_bytes(&[7u8; 32]);
    let stellar_pubkey: [u8; 32] = stellar_sk.verifying_key().to_bytes();

    let evm_sk = EvmSigningKey::from_bytes(&[9u8; 32].into()).unwrap();
              let evm_pk65: [u8; 65] = evm_sk
        .verifying_key()
        .to_encoded_point(false)
        .as_bytes()
        .try_into()
        .unwrap();
    let evm_hash: [u8; 32] = Keccak256::digest(&evm_pk65).into();
    let mut evm_address_bytes = [0u8; 20];
    evm_address_bytes.copy_from_slice(&evm_hash[12..]);
    let evm_address = BytesN::from_array(env, &evm_address_bytes);

    let mut payload = Vec::new();
    payload.extend_from_slice(BIND_PREFIX);
    payload.extend_from_slice(&contract_id.to_array());
    payload.extend_from_slice(&evm_address_bytes);
    payload.extend_from_slice(&stellar_pubkey);
    payload.extend_from_slice(&timestamp.to_be_bytes());
    let message_hash: [u8; 32] = Keccak256::digest(&payload).into();

    let mut eth_input = Vec::new();
    eth_input.extend_from_slice(ETH_PREFIX);
    eth_input.extend_from_slice(&message_hash);
    let evm_digest: [u8; 32] = Keccak256::digest(&eth_input).into();
    let evm_sig = evm_sk.sign_prehash(&evm_digest).unwrap();
    let evm_sig_arr: [u8; 64] = evm_sig.to_bytes().as_slice().try_into().unwrap();

    let digest_bn = BytesN::from_array(env, &evm_digest);
    let sig_bn = BytesN::from_array(env, &evm_sig_arr);
    let mut recovery_id = 0u32;
    for rid in 0..4u32 {
        let recovered: [u8; 65] = env
            .crypto()
            .secp256k1_recover(&digest_bn, &sig_bn, rid)
            .to_array();
        if recovered == evm_pk65 {
            recovery_id = rid;
            break;
        }
    }

        // Stellar signature over the 32-byte message hash
        let stellar_sig: [u8; 64] = stellar_sk.sign(&message_hash).to_bytes();

        TestKeys {
            evm_address,
            stellar_pubkey: BytesN::from_array(env, &stellar_pubkey),
            evm_signature: sig_bn,
            evm_recovery_id: recovery_id,
            stellar_signature: BytesN::from_array(env, &stellar_sig),
        }
    }

    #[test]
    fn test_bind_and_resolve_identity() {
        let env = Env::default();
        env.ledger().set_timestamp(1_700_000_000);
        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let timestamp = env.ledger().timestamp();
        let keys = build_signed_binding(&env, timestamp, &contract_id.contract_id());

        let binding = client.bind_identity(
            &keys.evm_address,
            &keys.stellar_pubkey,
            &timestamp,
            &keys.evm_signature,
            &keys.evm_recovery_id,
            &keys.stellar_signature,
        );
        assert_eq!(binding.evm_address, keys.evm_address);
        assert_eq!(binding.stellar_pubkey, keys.stellar_pubkey);
        assert_eq!(binding.timestamp, timestamp);

        let resolved_stellar = client
            .resolve_evm_to_stellar(&keys.evm_address)
            .expect("binding must exist");
        assert_eq!(resolved_stellar.stellar_pubkey, keys.stellar_pubkey);

        let resolved_evm = client
            .resolve_stellar_to_evm(&keys.stellar_pubkey)
            .expect("binding must exist");
        assert_eq!(resolved_evm.evm_address, keys.evm_address);

        assert!(client.is_bound(&keys.evm_address));
    }

    #[test]
    fn test_unbound_resolution_returns_none() {
        let env = Env::default();
        env.ledger().set_timestamp(1_700_000_000);
        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let unbound_evm = BytesN::from_array(&env, &[1u8; 20]);
        let unbound_pk = BytesN::from_array(&env, &[2u8; 32]);
        assert!(client.resolve_evm_to_stellar(&unbound_evm).is_none());
        assert!(client.resolve_stellar_to_evm(&unbound_pk).is_none());
        assert!(!client.is_bound(&unbound_evm));
    }

    #[test]
    #[should_panic]
    fn test_invalid_stellar_signature_reverts() {
        let env = Env::default();
        env.ledger().set_timestamp(1_700_000_000);
        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let timestamp = env.ledger().timestamp();
        let keys = build_signed_binding(&env, timestamp, &contract_id.contract_id());

        let mut bad_sig = keys.stellar_signature.to_array();
        bad_sig[0] ^= 0xff;
        let bad_stellar_sig = BytesN::from_array(&env, &bad_sig);

        client.bind_identity(
            &keys.evm_address,
            &keys.stellar_pubkey,
            &timestamp,
            &keys.evm_signature,
            &keys.evm_recovery_id,
            &bad_stellar_sig,
        );
    }

    #[test]
    #[should_panic]
    fn test_single_signed_request_reverts() {
        let env = Env::default();
        env.ledger().set_timestamp(1_700_000_000);
        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let timestamp = env.ledger().timestamp();
        let keys = build_signed_binding(&env, timestamp, &contract_id.contract_id());

        // Zeroed EVM signature cannot recover a valid address -> reverts.
        let zero_sig = BytesN::from_array(&env, &[0u8; 64]);
        client.bind_identity(
            &keys.evm_address,
            &keys.stellar_pubkey,
            &timestamp,
            &zero_sig,
            0,
            &keys.stellar_signature,
        );
    }

    #[test]
    #[should_panic]
    fn test_wrong_evm_address_reverts() {
        let env = Env::default();
        env.ledger().set_timestamp(1_700_000_000);
        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let timestamp = env.ledger().timestamp();
        let keys = build_signed_binding(&env, timestamp, &contract_id.contract_id());

        // Signature recovers a different address than the one being bound.
        let wrong_evm = BytesN::from_array(&env, &[0xabu8; 20]);
        client.bind_identity(
            &wrong_evm,
            &keys.stellar_pubkey,
            &timestamp,
            &keys.evm_signature,
            &keys.evm_recovery_id,
            &keys.stellar_signature,
        );
    }

    #[test]
    #[should_panic]
    fn test_stale_timestamp_reverts() {
        let env = Env::default();
        env.ledger().set_timestamp(1_700_000_000);
        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let keys = build_signed_binding(&env, 1_600_000_000, &contract_id.contract_id()); // signed a long time ago
        client.bind_identity(
            &keys.evm_address,
            &keys.stellar_pubkey,
            &1_600_000_000,
            &keys.evm_signature,
            &keys.evm_recovery_id,
            &keys.stellar_signature,
        );
    }

    #[test]
    #[should_panic]
    fn test_duplicate_binding_reverts() {
        let env = Env::default();
        env.ledger().set_timestamp(1_700_000_000);
        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let timestamp = env.ledger().timestamp();
        let keys = build_signed_binding(&env, timestamp, &contract_id.contract_id());

        client.bind_identity(
            &keys.evm_address,
            &keys.stellar_pubkey,
            &timestamp,
            &keys.evm_signature,
            &keys.evm_recovery_id,
            &keys.stellar_signature,
        );
        // Second binding attempt for the same EVM address reverts.
        client.bind_identity(
            &keys.evm_address,
            &keys.stellar_pubkey,
            &timestamp,
            &keys.evm_signature,
            &keys.evm_recovery_id,
            &keys.stellar_signature,
        );
    }
}
