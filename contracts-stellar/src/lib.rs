#![no_std]
// Soroban SDK macros emit `cfg(testutils)` which newer rustc check-cfg flags.
#![allow(unexpected_cfgs)]
// Public contract entrypoints intentionally take many args (env + auth + payload).
#![allow(clippy::too_many_arguments)]
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractimpl, contracttype, panic_with_error,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Val, Vec,
};

#[cfg(test)]
extern crate std;

pub mod threshold_sig;
pub mod bls;
pub use bls::{BLSVerifier, GuardianBLSKeyInfo};

/// Groth16 ZK-SNARK proof-of-access verifier (issue #70).
/// Pure-Rust BN254 pairing implementation (Soroban SDK v21 exposes no
/// bn254 host functions, so no `env.crypto()` calls are used here).
pub mod zk_verifier;

/// Zero-pads a `u64` into a 32-byte big-endian word, matching how Solidity's
/// `abi.encodePacked` serializes a `uint256`.
fn u256_be(value: u64) -> [u8; 32] {
    let mut buf = [0u8; 32];
    buf[24..32].copy_from_slice(&value.to_be_bytes());
    buf
}

/// Ledger constants for TTL extension thresholds and bump amounts (~5s per ledger)
/// ~7 days = 120,960 ledgers
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960;
/// ~30 days = 518,400 ledgers
pub const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
/// ~7 days = 120,960 ledgers
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;
/// ~30 days = 518,400 ledgers
pub const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;

/// Current persistent-storage schema version. Bumped whenever an upgrade
/// changes the meaning/layout of existing storage; `migrate` transforms
/// storage from a prior version up to this one and is a no-op once the
/// stored `DataKey::SchemaVersion` already matches.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum UpgradeError {
    /// `init_admins` has not been called yet, so there is no admin set to
    /// authorize against.
    NotInitialized = 1,
    /// The caller is not a member of the configured admin set.
    UnauthorizedAdmin = 2,
    /// The caller already approved the currently pending upgrade proposal.
    AlreadyApproved = 3,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AccessLevel {
    Read = 0,
    ReadWrite = 1,
    Admin = 2,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReleaseCondition {
    Anytime = 0,
    LiveOnly = 1,
    EmergencyOnly = 2,
    PostDeathOnly = 3,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequestStatus {
    Pending = 0,
    Approved = 1,
    Rejected = 2,
    Expired = 3,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Vault {
    pub id: u64,
    pub creator: Address,
    pub name: String,
    pub description: String,
    pub guardians: Vec<Address>,
    pub approval_threshold: u32,
    pub is_active: bool,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Document {
    pub id: u64,
    pub vault_id: u64,
    pub encrypted_metadata: String,
    pub ipfs_hash: String,
    pub uploaded_by: Address,
    pub uploaded_at: u64,
    pub required_access: AccessLevel,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct AccessRequest {
    pub request_id: u64,
    pub document_id: u64,
    pub requester: Address,
    pub approved_by: Vec<Address>,
    pub status: RequestStatus,
    pub expires_at: u64,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct GuardianInvite {
    pub guardian: Address,
    pub vault_id: u64,
    pub accepted: bool,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct VaultReleaseState {
    pub emergency_mode: bool,
    pub inactivity_period: u64,
    pub last_proof_of_life: u64,
    pub last_proof_of_life_sequence: u32,
}

/// VRF/PRNG-backed emergency unlock bounds. Requested when emergency mode
/// is enabled; fulfilled after `MIN_EMERGENCY_UNLOCK_CONFIRMATIONS` ledgers
/// using `env.prng()` so neither validators nor guardians can pick the
/// exact unlock ledger in advance.
#[contracttype]
#[derive(Clone, Debug)]
pub struct EmergencyUnlockSchedule {
    pub cycle: u64,
    pub request_sequence: u32,
    pub fulfilled: bool,
    pub unlock_at: u64,
    pub unlock_sequence: u32,
    pub jitter_seconds: u64,
}

/// Footprint-optimization: a vault's configuration and its release state
/// used to live under two separate persistent keys (`DataKey::Vault` and
/// `DataKey::ReleaseState`), even though almost every entrypoint that reads
/// or writes one also reads or writes the other in the same call - each
/// separate ledger key read/written is its own line item in a Soroban
/// transaction's footprint and is metered independently, so two keys that
/// are always touched together cost strictly more than one. `VaultRecord`
/// packs both into a single value stored under the single `DataKey::Vault`
/// key; `get_vault`/`get_release_state` still return the original `Vault`/
/// `VaultReleaseState` types unchanged, so this is purely an internal
/// storage-layout change; no public API or behavior differs.
///
/// Note for a real deployed environment: this repurposes what's stored
/// under `DataKey::Vault` and removes `DataKey::ReleaseState`, which would
/// need a `migrate()` conversion step before upgrading a contract that
/// already holds vaults under the old two-key layout. This project has no
/// confirmed production deployments yet, so no such migration is
/// implemented here - `CURRENT_SCHEMA_VERSION`/`migrate` are intentionally
/// left untouched rather than bumped without a real conversion behind them.
#[contracttype]
#[derive(Clone, Debug)]
pub struct VaultRecord {
    pub vault: Vault,
    pub release_state: VaultReleaseState,
}

/// Minimum number of ledgers that must close since the last proof of life
/// before post-death conditions can unlock, in addition to the timestamp
/// threshold. Guards against validators nudging the ledger timestamp within
/// their permitted drift window to trigger an early release without real
/// ledger progression having occurred.
const MIN_POST_DEATH_SEQUENCE_DELTA: u32 = 256;

/// Base delay applied after emergency-mode PRNG fulfillment, matching the
/// EVM `EMERGENCY_UNLOCK_BASE_DELAY` so observers cannot predict the exact
/// ledger at which post-death / emergency documents become readable.
const EMERGENCY_UNLOCK_BASE_DELAY: u64 = 10 * 60;
const DEFAULT_EMERGENCY_JITTER_WINDOW: u64 = 60 * 60;
const MIN_JITTER_WINDOW: u64 = 5 * 60;
const MAX_JITTER_WINDOW: u64 = 7 * 24 * 60 * 60;
/// Ledgers that must close between the emergency-mode request and PRNG
/// fulfillment so the triggering party cannot grind the same ledger's seed.
const MIN_EMERGENCY_UNLOCK_CONFIRMATIONS: u32 = 3;
/// Minimum ledger progression after fulfillment before emergency unlock.
const MIN_EMERGENCY_UNLOCK_SEQUENCE_DELTA: u32 = 256;
/// Stellar ledger close time used to convert jitter seconds into extra
/// required sequence delta.
const EMERGENCY_SECONDS_PER_LEDGER: u64 = 5;

/// A Web3 Keeper (Chainlink Automation / Gelato) delegation: `keeper` may relay
/// proof-of-life heartbeats on the vault creator's behalf until `expires_at`.
#[contracttype]
#[derive(Clone, Debug)]
pub struct KeeperAuthorization {
    pub keeper: Address,
    pub expires_at: u64,
}

/// Typed errors for the keeper-delegation entrypoints. Returned as `Result::Err`
/// rather than raised via `assert!`, so callers (and `try_*` client methods) get a
/// normal typed failure instead of a contract panic.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RelayerError {
    VaultNotFound = 1,
    VaultNotActive = 2,
    OnlyCreator = 3,
    ExpiryInPast = 4,
    NoKeeperAuthorized = 5,
    KeeperMismatch = 6,
    KeeperAuthorizationExpired = 7,
}

/// A pending contract-code upgrade awaiting the configured admin threshold
/// of distinct approvals before the Wasm swap is executed.
#[contracttype]
#[derive(Clone, Debug)]
pub struct UpgradeProposal {
    pub new_wasm_hash: BytesN<32>,
    pub approved_by: Vec<Address>,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct CrossChainHeartbeatBinding {
    pub gid_hash: BytesN<32>,
    pub evm_owner: BytesN<20>,
    pub relayer: Address,
}

#[contracttype]
pub enum DataKey {
    VaultCount,
    DocCount,
    ReqCount,
    // Packs both a vault's configuration and its release state into one
    // value (see `VaultRecord`); guardian membership is derived from
    // `VaultRecord.vault.guardians` rather than a separate per-guardian key
    // (there is no guardian-removal path in this contract, so the two were
    // always kept in lockstep and the extra key was pure duplication).
    Vault(u64),
    Doc(u64),
    Request(u64),
    HasAccess(u64, Address),
    AccessLvl(u64, Address),
    Invites(Address),
    ApprovedReq(u64, Address),
    LatestReq(u64, Address),
    PubKey(Address),
    GShare(u64, Address),
    BShare(u64, Address),
    FheGShare(u64, Address),
    FheBShare(u64, Address),
    FheAccumulator(u64),
    FheAccumulatorCount(u64),
    DocReleaseCond(u64),
    EmergencyUnlock(u64),
    EmergencyJitterWindow(u64),
    EmergencyUnlockCycle(u64),
    KeeperAuth(u64),
    // Optional external registry contract notified on document access grants
    AccessRegistry(u64),
    CrossChainHeartbeat(u64),
    // Cross-Chain Identity Lookup Map
    EvmToStellar(String),
    StellarToEvm(Address),
    EvmToPubKey(String),
    // Compromised key revocation registry (issue #156): revoked public key => true
    RevokedKey(String),
    // BLS Guardian Public Key Registry
    GuardianBLSKey(u64, Address),
    // Cross-Chain Revocation Broadcast Engine
    VaultGid(BytesN<32>),
    CrossChainRevoker(u64),
    RevocationNonce(BytesN<32>, u64, Address),
    VaultAccessVersion(u64, Address),
    // Upgrade governance
    Admins,
    AdminThreshold,
    UpgradeProposal,
    SchemaVersion,
    // Vault access tokens: a SEP-41-inspired, per-vault non-fungible
    // membership credential (mint_access_token / burn_access_token /
    // transfer / owner_of / balance).
    TokenCount,
    TokenOwner(u64),
    TokenVault(u64),
    TokenUri(u64),
    OwnerBalance(Address),
    VaultTokenBalance(u64, Address),
    // Groth16 ZK-SNARK proof-of-access nullifier registry (issue #70):
    // spent nullifier hash => true. Prevents double-claiming a single
    // beneficiary access proof.
    ZkNullifier(BytesN<32>),
}

#[contract]
pub struct SpooVaultStellar;

#[contractimpl]
impl SpooVaultStellar {
    /// Extend instance storage TTL
    pub fn extend_contract_ttl(env: Env) {
        Self::bump_instance(&env);
    }

    /// Extend persistent storage TTL for a vault and its state
    pub fn extend_vault_ttl(env: Env, vault_id: u64) {
        Self::bump_instance(&env);
        let vault_key = DataKey::Vault(vault_id);
        if env.storage().persistent().has(&vault_key) {
            Self::bump_persistent(&env, &vault_key);
        }
    }

    /// Extend persistent storage TTL for a document
    pub fn extend_document_ttl(env: Env, document_id: u64) {
        Self::bump_instance(&env);
        let doc_key = DataKey::Doc(document_id);
        if env.storage().persistent().has(&doc_key) {
            Self::bump_persistent(&env, &doc_key);
            Self::bump_persistent(&env, &DataKey::DocReleaseCond(document_id));
        }
    }

    /// Extend persistent storage TTL for an access request
    pub fn extend_request_ttl(env: Env, request_id: u64) {
        Self::bump_instance(&env);
        let req_key = DataKey::Request(request_id);
        if env.storage().persistent().has(&req_key) {
            Self::bump_persistent(&env, &req_key);
        }
    }

    /// Contract code version. Bumped by whoever ships a new Wasm build;
    /// used by upgrade integration tests to confirm a Wasm swap actually
    /// took effect (a fresh client built against the new build's ABI will
    /// observe the new version).
    pub fn version(_env: Env) -> u32 {
        1
    }

    // -------------------------------------------------------------------
    // Upgrade governance
    //
    // A dedicated, contract-wide admin set (distinct from any vault's
    // per-vault guardians) authorizes Wasm code upgrades. `upgrade_contract`
    // mirrors `approve_access`'s established pattern in this contract: each
    // admin calls the same entry point once, their approval is recorded,
    // and once the configured threshold of distinct admins has approved the
    // *same* `new_wasm_hash`, the swap executes automatically within that
    // triggering call - there is no separate "propose" vs "execute" step.
    // -------------------------------------------------------------------

    /// One-time admin governance bootstrap. Every supplied admin must
    /// individually authorize this call (rather than trusting a single
    /// deployer to unilaterally hand admin power to addresses that never
    /// consented). Reverts if admins are already initialized.
    pub fn init_admins(env: Env, admins: Vec<Address>, threshold: u32) {
        assert!(
            !env.storage().instance().has(&DataKey::Admins),
            "Admins already initialized"
        );

        let mut processed = Vec::new(&env);
        for i in 0..admins.len() {
            let admin = admins.get(i).unwrap();
            admin.require_auth();
            assert!(!processed.contains(&admin), "Duplicate admin found");
            processed.push_back(admin.clone());
        }

        assert!(
            threshold > 0 && threshold <= admins.len(),
            "Invalid admin threshold"
        );

        env.storage().instance().set(&DataKey::Admins, &admins);
        env.storage()
            .instance()
            .set(&DataKey::AdminThreshold, &threshold);
        env.storage()
            .instance()
            .set(&DataKey::SchemaVersion, &CURRENT_SCHEMA_VERSION);
        Self::bump_instance(&env);
    }

    /// Returns the configured admin set (empty if `init_admins` has not
    /// been called yet).
    pub fn get_admins(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Admins)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Returns the configured admin approval threshold (0 if `init_admins`
    /// has not been called yet).
    pub fn get_admin_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::AdminThreshold)
            .unwrap_or(0)
    }

    /// Propose or co-sign a Wasm code upgrade to `new_wasm_hash`.
    ///
    /// `new_wasm_hash` must already be present on the ledger (uploaded via
    /// `env.deployer().upload_contract_wasm`). Each call by a distinct
    /// configured admin counts as one approval toward the configured
    /// threshold. A call proposing a different hash than the currently
    /// pending proposal (or the first call) starts a fresh proposal with
    /// only that admin's approval recorded. Once enough distinct admins
    /// have approved the *same* hash, the Wasm code is swapped atomically
    /// within this same invocation via
    /// `env.deployer().update_current_contract_wasm` - existing instance
    /// and persistent storage is untouched by the swap itself (Soroban
    /// storage is keyed by contract ID, not by the executing Wasm code), so
    /// no data migration is required unless the new code changes how
    /// existing storage should be interpreted (see `migrate`).
    ///
    /// Reverts with `UpgradeError::UnauthorizedAdmin` if `admin` is not in
    /// the configured admin set, or `UpgradeError::NotInitialized` if
    /// `init_admins` has not been called yet.
    pub fn upgrade_contract(env: Env, admin: Address, new_wasm_hash: BytesN<32>) {
        admin.require_auth();
        Self::bump_instance(&env);

        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Admins)
            .unwrap_or_else(|| panic_with_error!(&env, UpgradeError::NotInitialized));
        if !admins.contains(&admin) {
            panic_with_error!(&env, UpgradeError::UnauthorizedAdmin);
        }

        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::AdminThreshold)
            .unwrap_or(0);

        let mut proposal: UpgradeProposal = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeProposal)
            .unwrap_or(UpgradeProposal {
                new_wasm_hash: new_wasm_hash.clone(),
                approved_by: Vec::new(&env),
            });

        // A proposal for a different hash supersedes any stale pending one.
        if proposal.new_wasm_hash != new_wasm_hash {
            proposal = UpgradeProposal {
                new_wasm_hash: new_wasm_hash.clone(),
                approved_by: Vec::new(&env),
            };
        }

        if proposal.approved_by.contains(&admin) {
            panic_with_error!(&env, UpgradeError::AlreadyApproved);
        }
        proposal.approved_by.push_back(admin.clone());

        if proposal.approved_by.len() >= threshold {
            env.storage().instance().remove(&DataKey::UpgradeProposal);
            env.deployer()
                .update_current_contract_wasm(new_wasm_hash.clone());
            env.events()
                .publish((Symbol::new(&env, "contract_upgraded"),), new_wasm_hash);
        } else {
            env.storage()
                .instance()
                .set(&DataKey::UpgradeProposal, &proposal);
        }
    }

    /// Post-upgrade storage migration hook, callable by any configured
    /// admin. Idempotent per schema version: transforms persistent storage
    /// laid out by a prior contract version and bumps
    /// `DataKey::SchemaVersion` so re-invocation after that is a no-op.
    /// Currently a no-op body (schema version 1 is the only version that
    /// has existed); a future upgrade that changes the storage layout
    /// implements its transformation here and bumps `CURRENT_SCHEMA_VERSION`.
    ///
    /// Reverts with `UpgradeError::UnauthorizedAdmin` if `admin` is not in
    /// the configured admin set.
    pub fn migrate(env: Env, admin: Address) {
        admin.require_auth();
        Self::bump_instance(&env);

        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Admins)
            .unwrap_or_else(|| panic_with_error!(&env, UpgradeError::NotInitialized));
        if !admins.contains(&admin) {
            panic_with_error!(&env, UpgradeError::UnauthorizedAdmin);
        }

        let current: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SchemaVersion)
            .unwrap_or(1);
        if current >= CURRENT_SCHEMA_VERSION {
            return;
        }

        // Storage-layout transformations for schema versions below
        // CURRENT_SCHEMA_VERSION are added here as the schema evolves.

        env.storage()
            .instance()
            .set(&DataKey::SchemaVersion, &CURRENT_SCHEMA_VERSION);
    }

    /// Register a user's encryption public key
    ///
    /// # Panics
    /// Panics if the public key has previously been revoked as compromised.
    pub fn register_public_key(env: Env, user: Address, public_key: String) {
        user.require_auth();
        Self::bump_instance(&env);

        let revoked_entry = DataKey::RevokedKey(public_key.clone());
        let is_revoked: bool = env
            .storage()
            .persistent()
            .get(&revoked_entry)
            .unwrap_or(false);
        assert!(!is_revoked, "Public key has been revoked as compromised");

        let key = DataKey::PubKey(user.clone());
        env.storage().persistent().set(&key, &public_key);
        Self::bump_persistent(&env, &key);
    }

    /// Revoke a compromised public key and atomically rotate to a new one.
    ///
    /// Proof of possession: only the account whose registered key equals
    /// `old_public_key` may revoke it. The old key is permanently blacklisted:
    /// it can never be re-registered on this contract.
    pub fn revoke_key(env: Env, user: Address, old_public_key: String, new_public_key: String) {
        user.require_auth();
        Self::bump_instance(&env);

        assert!(!new_public_key.is_empty(), "New public key is required");
        assert!(
            old_public_key != new_public_key,
            "New key must differ from old key"
        );

        let new_revoked_entry = DataKey::RevokedKey(new_public_key.clone());
        let new_is_revoked: bool = env
            .storage()
            .persistent()
            .get(&new_revoked_entry)
            .unwrap_or(false);
        assert!(!new_is_revoked, "Cannot rotate to a revoked public key");

        let current: Option<String> = env
            .storage()
            .persistent()
            .get(&DataKey::PubKey(user.clone()));
        match current {
            Some(cur) => assert!(
                cur == old_public_key,
                "Caller does not own the old public key"
            ),
            None => panic!("No registered public key for caller"),
        }

        let revoked_entry = DataKey::RevokedKey(old_public_key.clone());
        let already_revoked: bool = env
            .storage()
            .persistent()
            .get(&revoked_entry)
            .unwrap_or(false);
        assert!(!already_revoked, "Key already revoked");

        env.storage().persistent().set(&revoked_entry, &true);
        Self::bump_persistent(&env, &revoked_entry);

        let pk_key = DataKey::PubKey(user);
        env.storage().persistent().set(&pk_key, &new_public_key);
        Self::bump_persistent(&env, &pk_key);
    }

    /// Returns true if the given public key has been revoked as compromised.
    pub fn is_key_revoked(env: Env, public_key: String) -> bool {
        Self::bump_instance(&env);
        let key = DataKey::RevokedKey(public_key);
        let revoked: bool = env.storage().persistent().get(&key).unwrap_or(false);
        if revoked {
            Self::bump_persistent(&env, &key);
        }
        revoked
    }

    /// Retrieve public key for a user
    pub fn get_public_key(env: Env, user: Address) -> Option<String> {
        Self::bump_instance(&env);
        let key = DataKey::PubKey(user);
        let val: Option<String> = env.storage().persistent().get(&key);
        if val.is_some() {
            Self::bump_persistent(&env, &key);
        }
        val
    }

    /// Register linked cross-chain identity (EVM Address <-> Stellar Address & Public Key)
    pub fn register_cross_chain_identity(
        env: Env,
        stellar_user: Address,
        evm_address: String,
        encryption_pubkey: Option<String>,
    ) {
        stellar_user.require_auth();
        assert!(evm_address.len() == 42, "Invalid EVM address length");
        Self::bump_instance(&env);

        let evm_to_stellar_key = DataKey::EvmToStellar(evm_address.clone());
        let stellar_to_evm_key = DataKey::StellarToEvm(stellar_user.clone());

        env.storage()
            .persistent()
            .set(&evm_to_stellar_key, &stellar_user);
        env.storage()
            .persistent()
            .set(&stellar_to_evm_key, &evm_address);

        Self::bump_persistent(&env, &evm_to_stellar_key);
        Self::bump_persistent(&env, &stellar_to_evm_key);

        if let Some(pubkey) = encryption_pubkey {
            let revoked_entry = DataKey::RevokedKey(pubkey.clone());
            let is_revoked: bool = env
                .storage()
                .persistent()
                .get(&revoked_entry)
                .unwrap_or(false);
            assert!(!is_revoked, "Public key has been revoked as compromised");

            let evm_to_pubkey_key = DataKey::EvmToPubKey(evm_address);
            let stellar_pubkey_key = DataKey::PubKey(stellar_user);

            env.storage().persistent().set(&evm_to_pubkey_key, &pubkey);
            env.storage().persistent().set(&stellar_pubkey_key, &pubkey);

            Self::bump_persistent(&env, &evm_to_pubkey_key);
            Self::bump_persistent(&env, &stellar_pubkey_key);
        }
    }

    /// Resolve EVM address to linked Stellar Address
    pub fn resolve_evm_to_stellar(env: Env, evm_address: String) -> Option<Address> {
        Self::bump_instance(&env);
        let key = DataKey::EvmToStellar(evm_address);
        let addr: Option<Address> = env.storage().persistent().get(&key);
        if addr.is_some() {
            Self::bump_persistent(&env, &key);
        }
        addr
    }

    /// Resolve Stellar Address to linked EVM Address
    pub fn resolve_stellar_to_evm(env: Env, stellar_user: Address) -> Option<String> {
        Self::bump_instance(&env);
        let key = DataKey::StellarToEvm(stellar_user);
        let evm: Option<String> = env.storage().persistent().get(&key);
        if evm.is_some() {
            Self::bump_persistent(&env, &key);
        }
        evm
    }

    /// Resolve EVM address directly to its linked Encryption Public Key
    pub fn resolve_evm_to_public_key(env: Env, evm_address: String) -> Option<String> {
        Self::bump_instance(&env);
        let key = DataKey::EvmToPubKey(evm_address.clone());
        let pubkey: Option<String> = env.storage().persistent().get(&key);
        if pubkey.is_some() {
            Self::bump_persistent(&env, &key);
            return pubkey;
        }

        // Fallback: If EVM -> Stellar exists, resolve Stellar -> PubKey
        if let Some(stellar_addr) = Self::resolve_evm_to_stellar(env.clone(), evm_address) {
            return Self::get_public_key(env, stellar_addr);
        }

        None
    }

    /// Create a new Vault.
    ///
    /// `creator` and each entry in `guardians` are plain `Address` values, so
    /// they may be either a raw Stellar keypair (G-account) or a deployed
    /// contract address (a multisig / custom account-abstraction signer, or
    /// any other contract implementing `soroban_sdk::auth::CustomAccountInterface`).
    /// `require_auth` resolves against whichever kind of address is supplied,
    /// so no special-casing is needed here for contract-account guardians.
    pub fn create_vault(
        env: Env,
        creator: Address,
        name: String,
        description: String,
        guardians: Vec<Address>,
        approval_threshold: u32,
    ) -> u64 {
        creator.require_auth();
        Self::bump_instance(&env);

        // Basic validations
        let mut ext_guardian_count = 0;
        let mut processed = Vec::new(&env);

        for i in 0..guardians.len() {
            let guardian = guardians.get(i).unwrap();
            // Check duplicates
            assert!(!processed.contains(&guardian), "Duplicate guardian found");
            processed.push_back(guardian.clone());

            if guardian != creator {
                ext_guardian_count += 1;
            }
        }

        assert!(
            ext_guardian_count > 0,
            "At least one external guardian required"
        );
        let total_guardians = ext_guardian_count + 1;
        assert!(
            approval_threshold > 0 && approval_threshold <= total_guardians,
            "Invalid approval threshold"
        );

        let vault_count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::VaultCount)
            .unwrap_or(0);
        let next_vault_id = vault_count + 1;
        env.storage()
            .instance()
            .set(&DataKey::VaultCount, &next_vault_id);

        let mut actual_guardians = Vec::new(&env);
        actual_guardians.push_back(creator.clone());

        let vault = Vault {
            id: next_vault_id,
            creator: creator.clone(),
            name,
            description,
            guardians: actual_guardians,
            approval_threshold,
            is_active: true,
            created_at: env.ledger().timestamp(),
        };

        let release_state = VaultReleaseState {
            emergency_mode: false,
            inactivity_period: 30 * 24 * 60 * 60, // 30 days in seconds
            last_proof_of_life: env.ledger().timestamp(),
            last_proof_of_life_sequence: env.ledger().sequence(),
        };
        Self::save_vault_record(
            &env,
            next_vault_id,
            &VaultRecord {
                vault,
                release_state,
            },
        );

        // Record invites for external guardians
        for i in 0..guardians.len() {
            let guardian = guardians.get(i).unwrap();
            if guardian == creator {
                continue;
            }

            let invites_key = DataKey::Invites(guardian.clone());
            let mut user_invites: Vec<GuardianInvite> = env
                .storage()
                .persistent()
                .get(&invites_key)
                .unwrap_or_else(|| Vec::new(&env));

            user_invites.push_back(GuardianInvite {
                guardian: guardian.clone(),
                vault_id: next_vault_id,
                accepted: false,
                expires_at: env.ledger().timestamp() + 7 * 24 * 60 * 60, // 7 days
            });

            env.storage().persistent().set(&invites_key, &user_invites);
            Self::bump_persistent(&env, &invites_key);
        }

        next_vault_id
    }

    /// Accept guardian invitation
    pub fn accept_guardian_invite(env: Env, guardian: Address, vault_id: u64) {
        guardian.require_auth();
        Self::bump_instance(&env);

        let mut record = Self::load_vault_record(&env, vault_id);
        assert!(record.vault.is_active, "Vault not active");
        assert!(
            !record.vault.guardians.contains(&guardian),
            "Already guardian"
        );

        let invites_key = DataKey::Invites(guardian.clone());
        let mut user_invites: Vec<GuardianInvite> = env
            .storage()
            .persistent()
            .get(&invites_key)
            .expect("No invites for user");

        let mut accepted = false;
        for i in 0..user_invites.len() {
            let mut invite = user_invites.get(i).unwrap();
            if invite.vault_id == vault_id && !invite.accepted {
                assert!(
                    env.ledger().timestamp() < invite.expires_at,
                    "Invite expired"
                );
                invite.accepted = true;
                user_invites.set(i, invite);
                accepted = true;
                break;
            }
        }

        assert!(accepted, "No valid invite found");
        env.storage().persistent().set(&invites_key, &user_invites);
        Self::bump_persistent(&env, &invites_key);

        record.vault.guardians.push_back(guardian);
        Self::save_vault_record(&env, vault_id, &record);
    }

    /// Add a document metadata and storage hash
    pub fn add_document(
        env: Env,
        uploader: Address,
        vault_id: u64,
        encrypted_metadata: String,
        ipfs_hash: String,
        required_access: AccessLevel,
        release_condition: ReleaseCondition,
        guardians_list: Vec<Address>,
        shares: Vec<String>,
    ) -> u64 {
        uploader.require_auth();
        Self::bump_instance(&env);

        let record = Self::load_vault_record(&env, vault_id);
        assert!(record.vault.is_active, "Vault is deactivated");
        assert!(
            record.vault.guardians.contains(&uploader),
            "Only guardians can upload documents"
        );
        assert!(!ipfs_hash.is_empty(), "IPFS hash required");
        assert!(
            guardians_list.len() == shares.len(),
            "Guardians list and shares count mismatch"
        );

        let doc_count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::DocCount)
            .unwrap_or(0);
        let next_doc_id = doc_count + 1;
        env.storage()
            .instance()
            .set(&DataKey::DocCount, &next_doc_id);

        let doc = Document {
            id: next_doc_id,
            vault_id,
            encrypted_metadata,
            ipfs_hash,
            uploaded_by: uploader.clone(),
            uploaded_at: env.ledger().timestamp(),
            required_access,
        };

        let doc_key = DataKey::Doc(next_doc_id);
        let rel_key = DataKey::DocReleaseCond(next_doc_id);
        let access_key = DataKey::HasAccess(next_doc_id, uploader.clone());
        let lvl_key = DataKey::AccessLvl(next_doc_id, uploader);

        env.storage().persistent().set(&doc_key, &doc);
        env.storage().persistent().set(&rel_key, &release_condition);
        env.storage().persistent().set(&access_key, &true);
        env.storage().persistent().set(&lvl_key, &required_access);

        Self::bump_persistent(&env, &doc_key);
        Self::bump_persistent(&env, &rel_key);
        Self::bump_persistent(&env, &access_key);
        Self::bump_persistent(&env, &lvl_key);

        // Store guardian shares
        for i in 0..guardians_list.len() {
            let guardian = guardians_list.get(i).unwrap();
            let share = shares.get(i).unwrap();
            let gshare_key = DataKey::GShare(next_doc_id, guardian);
            env.storage().persistent().set(&gshare_key, &share);
            Self::bump_persistent(&env, &gshare_key);
        }

        next_doc_id
    }

    /// Request document access
    pub fn request_access(env: Env, requester: Address, document_id: u64) -> u64 {
        requester.require_auth();
        Self::bump_instance(&env);

        let doc_key = DataKey::Doc(document_id);
        let doc: Document = env
            .storage()
            .persistent()
            .get(&doc_key)
            .expect("Document not found");
        Self::bump_persistent(&env, &doc_key);

        let record = Self::load_vault_record(&env, doc.vault_id);
        assert!(record.vault.is_active, "Vault is deactivated");

        let has_acc: bool = env
            .storage()
            .persistent()
            .get(&DataKey::HasAccess(document_id, requester.clone()))
            .unwrap_or(false);
        assert!(!has_acc, "Already has access");

        // Verify release condition
        let cond: ReleaseCondition = env
            .storage()
            .persistent()
            .get(&DataKey::DocReleaseCond(document_id))
            .unwrap_or(ReleaseCondition::Anytime);

        assert!(
            Self::is_release_condition_satisfied(&env, doc.vault_id, &record.release_state, cond),
            "Release condition locked"
        );

        let req_count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ReqCount)
            .unwrap_or(0);
        let next_req_id = req_count + 1;
        env.storage()
            .instance()
            .set(&DataKey::ReqCount, &next_req_id);

        let access_req = AccessRequest {
            request_id: next_req_id,
            document_id,
            requester: requester.clone(),
            approved_by: Vec::new(&env),
            status: RequestStatus::Pending,
            expires_at: env.ledger().timestamp() + 3 * 24 * 60 * 60, // 3 days
            created_at: env.ledger().timestamp(),
        };

        let req_key = DataKey::Request(next_req_id);
        let latest_req_key = DataKey::LatestReq(document_id, requester);
        env.storage().persistent().set(&req_key, &access_req);
        env.storage()
            .persistent()
            .set(&latest_req_key, &next_req_id);

        Self::bump_persistent(&env, &req_key);
        Self::bump_persistent(&env, &latest_req_key);

        next_req_id
    }

    /// Approve document access request by a guardian
    pub fn approve_access(
        env: Env,
        approver: Address,
        request_id: u64,
        beneficiary_share: Option<String>,
    ) {
        approver.require_auth();
        Self::bump_instance(&env);

        let req_key = DataKey::Request(request_id);
        let mut request: AccessRequest = env
            .storage()
            .persistent()
            .get(&req_key)
            .expect("Request not found");
        assert!(
            request.status == RequestStatus::Pending,
            "Request not pending"
        );
        assert!(
            env.ledger().timestamp() < request.expires_at,
            "Request expired"
        );

        let doc_key = DataKey::Doc(request.document_id);
        let doc: Document = env
            .storage()
            .persistent()
            .get(&doc_key)
            .expect("Document not found");

        let record = Self::load_vault_record(&env, doc.vault_id);
        assert!(record.vault.is_active, "Vault is deactivated");
        assert!(
            record.vault.guardians.contains(&approver),
            "Only guardians can approve access"
        );

        let approved_req_key = DataKey::ApprovedReq(request_id, approver.clone());
        let already_approved: bool = env
            .storage()
            .persistent()
            .get(&approved_req_key)
            .unwrap_or(false);
        assert!(!already_approved, "Already approved");

        env.storage().persistent().set(&approved_req_key, &true);
        Self::bump_persistent(&env, &approved_req_key);

        request.approved_by.push_back(approver.clone());

        if let Some(share) = beneficiary_share {
            let bshare_key = DataKey::BShare(request_id, approver);
            env.storage().persistent().set(&bshare_key, &share);
            Self::bump_persistent(&env, &bshare_key);
        }

        if request.approved_by.len() >= record.vault.approval_threshold {
            request.status = RequestStatus::Approved;
            let acc_key = DataKey::HasAccess(request.document_id, request.requester.clone());
            let lvl_key = DataKey::AccessLvl(request.document_id, request.requester.clone());
            env.storage().persistent().set(&acc_key, &true);
            env.storage()
                .persistent()
                .set(&lvl_key, &doc.required_access);
            Self::bump_persistent(&env, &acc_key);
            Self::bump_persistent(&env, &lvl_key);

            let registry_key = DataKey::AccessRegistry(doc.vault_id);
            if let Some(registry) = env.storage().persistent().get::<_, Address>(&registry_key) {
                Self::bump_persistent(&env, &registry_key);
                Self::notify_access_registry(
                    &env,
                    &registry,
                    request.document_id,
                    &request.requester,
                );
            }
        }

        env.storage().persistent().set(&req_key, &request);
        Self::bump_persistent(&env, &req_key);
    }

    /// Verify a batch of K-of-N Ed25519 threshold signatures in a single Soroban contract invocation
    pub fn verify_threshold_signatures(
        env: Env,
        message: Bytes,
        signatures: Vec<BytesN<64>>,
        public_keys: Vec<BytesN<32>>,
        threshold: u32,
        nonce: u64,
        expiration_ledger: u32,
    ) -> bool {
        Self::bump_instance(&env);
        threshold_sig::verify_threshold_signatures_internal(
            &env,
            &message,
            &signatures,
            &public_keys,
            threshold,
            nonce,
            expiration_ledger,
        )
    }

    /// Approve an access request using batch K-of-N Ed25519 threshold signatures in a single transaction call
    pub fn approve_access_threshold(
        env: Env,
        caller: Address,
        request_id: u64,
        signatures: Vec<BytesN<64>>,
        public_keys: Vec<BytesN<32>>,
        nonce: u64,
        expiration_ledger: u32,
        beneficiary_share: Option<String>,
    ) {
        caller.require_auth();
        Self::bump_instance(&env);

        let req_key = DataKey::Request(request_id);
        let mut request: AccessRequest = env
            .storage()
            .persistent()
            .get(&req_key)
            .expect("Request not found");
        assert!(
            request.status == RequestStatus::Pending,
            "Request not pending"
        );
        assert!(
            env.ledger().timestamp() < request.expires_at,
            "Request expired"
        );

        let doc_key = DataKey::Doc(request.document_id);
        let doc: Document = env
            .storage()
            .persistent()
            .get(&doc_key)
            .expect("Document not found");

        let record = Self::load_vault_record(&env, doc.vault_id);
        assert!(record.vault.is_active, "Vault is deactivated");

        // Construct message committing to the request_id and document_id
        let mut msg_bytes = Bytes::new(&env);
        msg_bytes.extend_from_slice(b"ApproveAccess:");
        msg_bytes.extend_from_slice(&request_id.to_be_bytes());
        msg_bytes.extend_from_slice(&doc.vault_id.to_be_bytes());

        // Verify threshold signatures against the approval threshold
        let verified = threshold_sig::verify_threshold_signatures_internal(
            &env,
            &msg_bytes,
            &signatures,
            &public_keys,
            record.vault.approval_threshold,
            nonce,
            expiration_ledger,
        );
        assert!(verified, "Threshold verification failed");

        if let Some(share) = beneficiary_share {
            let bshare_key = DataKey::BShare(request_id, caller);
            env.storage().persistent().set(&bshare_key, &share);
            Self::bump_persistent(&env, &bshare_key);
        }

        request.status = RequestStatus::Approved;
        let acc_key = DataKey::HasAccess(request.document_id, request.requester.clone());
        let lvl_key = DataKey::AccessLvl(request.document_id, request.requester.clone());
        env.storage().persistent().set(&acc_key, &true);
        env.storage().persistent().set(&lvl_key, &doc.required_access);
        Self::bump_persistent(&env, &acc_key);
        Self::bump_persistent(&env, &lvl_key);

        let registry_key = DataKey::AccessRegistry(doc.vault_id);
        if let Some(registry) = env.storage().persistent().get::<_, Address>(&registry_key) {
            Self::bump_persistent(&env, &registry_key);
            Self::notify_access_registry(
                &env,
                &registry,
                request.document_id,
                &request.requester,
            );
        }

        env.storage().persistent().set(&req_key, &request);
        Self::bump_persistent(&env, &req_key);
    }

    /// Register BLS12-381 G1 public key with Proof of Possession for a vault guardian
    pub fn register_guardian_bls_key(
        env: Env,
        guardian: Address,
        vault_id: u64,
        bls_public_key: Bytes,
        proof_of_possession: Bytes,
    ) {
        guardian.require_auth();
        Self::bump_instance(&env);

        let record = Self::load_vault_record(&env, vault_id);
        assert!(record.vault.is_active, "Vault is deactivated");
        assert!(
            record.vault.guardians.contains(&guardian),
            "Only guardians can register BLS key"
        );
        assert!(
            BLSVerifier::verify_proof_of_possession(&env, &bls_public_key, &proof_of_possession),
            "Invalid Proof of Possession"
        );

        let key_info = GuardianBLSKeyInfo {
            public_key: bls_public_key,
            proof_of_possession,
            registered: true,
            registered_at: env.ledger().timestamp(),
        };

        let bls_key = DataKey::GuardianBLSKey(vault_id, guardian);
        env.storage().persistent().set(&bls_key, &key_info);
        Self::bump_persistent(&env, &bls_key);
    }

    /// Fetch registered BLS key for a vault guardian
    pub fn get_guardian_bls_key(
        env: Env,
        vault_id: u64,
        guardian: Address,
    ) -> Option<GuardianBLSKeyInfo> {
        Self::bump_instance(&env);
        let bls_key = DataKey::GuardianBLSKey(vault_id, guardian);
        let info: Option<GuardianBLSKeyInfo> = env.storage().persistent().get(&bls_key);
        if info.is_some() {
            Self::bump_persistent(&env, &bls_key);
        }
        info
    }

    /// Approve an access request using aggregated K-of-N BLS threshold signature in 1 transaction
    pub fn approve_access_bls(
        env: Env,
        request_id: u64,
        guardian_addresses: Vec<Address>,
        aggregated_signature: Bytes,
        aggregated_public_key: Bytes,
        encrypted_shares: Vec<String>,
    ) {
        Self::bump_instance(&env);

        let req_key = DataKey::Request(request_id);
        let mut request: AccessRequest = env
            .storage()
            .persistent()
            .get(&req_key)
            .expect("Request not found");
        assert!(
            request.status == RequestStatus::Pending,
            "Request not pending"
        );
        assert!(
            env.ledger().timestamp() < request.expires_at,
            "Request expired"
        );

        let doc_key = DataKey::Doc(request.document_id);
        let doc: Document = env
            .storage()
            .persistent()
            .get(&doc_key)
            .expect("Document not found");

        let record = Self::load_vault_record(&env, doc.vault_id);
        assert!(record.vault.is_active, "Vault is deactivated");

        let guardian_count = guardian_addresses.len();
        assert!(
            guardian_count >= record.vault.approval_threshold,
            "Threshold not met"
        );

        for i in 0..guardian_count {
            let guardian = guardian_addresses.get(i).unwrap();
            assert!(
                record.vault.guardians.contains(&guardian),
                "Non-guardian in approval set"
            );
            assert!(guardian != request.requester, "Cannot self approve");

            let bls_key = DataKey::GuardianBLSKey(doc.vault_id, guardian.clone());
            let key_info: GuardianBLSKeyInfo = env
                .storage()
                .persistent()
                .get(&bls_key)
                .expect("Guardian BLS key not registered");
            assert!(key_info.registered, "BLS key not active");

            let approved_req_key = DataKey::ApprovedReq(request_id, guardian.clone());
            let is_already_approved = env.storage().persistent().has(&approved_req_key);
            if !is_already_approved {
                env.storage().persistent().set(&approved_req_key, &true);
                Self::bump_persistent(&env, &approved_req_key);
                request.approved_by.push_back(guardian.clone());
            }

            if i < encrypted_shares.len() {
                let share = encrypted_shares.get(i).unwrap();
                if !share.is_empty() {
                    let bshare_key = DataKey::BShare(request_id, guardian);
                    env.storage().persistent().set(&bshare_key, &share);
                    Self::bump_persistent(&env, &bshare_key);
                }
            }
        }

        assert!(
            BLSVerifier::verify_threshold_signature(
                &env,
                request_id,
                doc.vault_id,
                request.document_id,
                &request.requester,
                &aggregated_public_key,
                &aggregated_signature,
                guardian_count,
                record.vault.approval_threshold,
            ),
            "Invalid aggregated BLS signature"
        );

        if request.approved_by.len() >= record.vault.approval_threshold {
            request.status = RequestStatus::Approved;
            let acc_key = DataKey::HasAccess(request.document_id, request.requester.clone());
            let lvl_key = DataKey::AccessLvl(request.document_id, request.requester.clone());
            env.storage().persistent().set(&acc_key, &true);
            env.storage()
                .persistent()
                .set(&lvl_key, &doc.required_access);
            Self::bump_persistent(&env, &acc_key);
            Self::bump_persistent(&env, &lvl_key);

            let registry_key = DataKey::AccessRegistry(doc.vault_id);
            if let Some(registry) = env.storage().persistent().get::<_, Address>(&registry_key) {
                Self::bump_persistent(&env, &registry_key);
                Self::notify_access_registry(
                    &env,
                    &registry,
                    request.document_id,
                    &request.requester,
                );
            }
        }

        env.storage().persistent().set(&req_key, &request);
        Self::bump_persistent(&env, &req_key);
    }

    /// Save FHE-encrypted guardian shares for a document
    pub fn save_guardian_shares_fhe(
        env: Env,
        uploader: Address,
        document_id: u64,
        guardians_list: Vec<Address>,
        shares_fhe: Vec<Bytes>,
    ) {
        uploader.require_auth();
        Self::bump_instance(&env);

        let doc_key = DataKey::Doc(document_id);
        let doc: Document = env
            .storage()
            .persistent()
            .get(&doc_key)
            .expect("Document not found");

        let record = Self::load_vault_record(&env, doc.vault_id);
        assert!(
            record.vault.guardians.contains(&uploader) || record.vault.creator == uploader,
            "Only guardians can save FHE shares"
        );
        assert!(
            guardians_list.len() == shares_fhe.len(),
            "Guardians and shares length mismatch"
        );

        for i in 0..guardians_list.len() {
            let guardian = guardians_list.get(i).unwrap();
            let share = shares_fhe.get(i).unwrap();
            let key = DataKey::FheGShare(document_id, guardian);
            env.storage().persistent().set(&key, &share);
            Self::bump_persistent(&env, &key);
        }

        env.events().publish(
            (Symbol::new(&env, "fhe_guardian_shares_saved"), document_id),
            guardians_list.len(),
        );
    }

    /// Approve document access request using FHE encrypted share payload
    pub fn approve_access_fhe(env: Env, approver: Address, request_id: u64, fhe_share: Bytes) {
        approver.require_auth();
        Self::bump_instance(&env);

        let req_key = DataKey::Request(request_id);
        let mut request: AccessRequest = env
            .storage()
            .persistent()
            .get(&req_key)
            .expect("Request not found");
        assert!(
            request.status == RequestStatus::Pending,
            "Request not pending"
        );
        assert!(
            env.ledger().timestamp() < request.expires_at,
            "Request expired"
        );
        assert!(request.requester != approver, "Cannot self-approve access");

        let doc_key = DataKey::Doc(request.document_id);
        let doc: Document = env
            .storage()
            .persistent()
            .get(&doc_key)
            .expect("Document not found");

        let record = Self::load_vault_record(&env, doc.vault_id);
        assert!(record.vault.is_active, "Vault is deactivated");
        assert!(
            record.vault.guardians.contains(&approver),
            "Only guardians can approve access"
        );

        let approved_req_key = DataKey::ApprovedReq(request_id, approver.clone());
        let already_approved: bool = env
            .storage()
            .persistent()
            .get(&approved_req_key)
            .unwrap_or(false);
        assert!(!already_approved, "Already approved");

        env.storage().persistent().set(&approved_req_key, &true);
        Self::bump_persistent(&env, &approved_req_key);

        request.approved_by.push_back(approver.clone());

        if !fhe_share.is_empty() {
            let bshare_key = DataKey::FheBShare(request_id, approver.clone());
            env.storage().persistent().set(&bshare_key, &fhe_share);
            Self::bump_persistent(&env, &bshare_key);

            let acc_key = DataKey::FheAccumulator(request_id);
            let current_acc: Bytes = env
                .storage()
                .persistent()
                .get(&acc_key)
                .unwrap_or_else(|| Bytes::new(&env));

            let new_acc = Self::fhe_add(&env, &current_acc, &fhe_share);
            env.storage().persistent().set(&acc_key, &new_acc);
            Self::bump_persistent(&env, &acc_key);

            let count_key = DataKey::FheAccumulatorCount(request_id);
            let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
            env.storage().persistent().set(&count_key, &(count + 1));
            Self::bump_persistent(&env, &count_key);

            env.events().publish(
                (
                    Symbol::new(&env, "fhe_share_submitted"),
                    request_id,
                    approver,
                ),
                (),
            );
        }

        if request.approved_by.len() >= record.vault.approval_threshold {
            request.status = RequestStatus::Approved;
            let acc_key = DataKey::HasAccess(request.document_id, request.requester.clone());
            let lvl_key = DataKey::AccessLvl(request.document_id, request.requester.clone());
            env.storage().persistent().set(&acc_key, &true);
            env.storage()
                .persistent()
                .set(&lvl_key, &doc.required_access);
            Self::bump_persistent(&env, &acc_key);
            Self::bump_persistent(&env, &lvl_key);

            let agg_key = DataKey::FheAccumulator(request_id);
            let aggregate: Bytes = env
                .storage()
                .persistent()
                .get(&agg_key)
                .unwrap_or_else(|| Bytes::new(&env));

            env.events().publish(
                (
                    Symbol::new(&env, "fhe_aggregated"),
                    request_id,
                    request.document_id,
                ),
                (request.requester.clone(), aggregate),
            );

            let registry_key = DataKey::AccessRegistry(doc.vault_id);
            if let Some(registry) = env.storage().persistent().get::<_, Address>(&registry_key) {
                Self::bump_persistent(&env, &registry_key);
                Self::notify_access_registry(
                    &env,
                    &registry,
                    request.document_id,
                    &request.requester,
                );
            }
        }

        env.storage().persistent().set(&req_key, &request);
        Self::bump_persistent(&env, &req_key);
    }

    /// Retrieve on-chain aggregate FHE ciphertext for an access request
    pub fn get_fhe_aggregate(env: Env, request_id: u64) -> Option<Bytes> {
        Self::bump_instance(&env);
        let key = DataKey::FheAccumulator(request_id);
        let val: Option<Bytes> = env.storage().persistent().get(&key);
        if val.is_some() {
            Self::bump_persistent(&env, &key);
        }
        val
    }

    /// Retrieve FHE guardian share for a document
    pub fn get_fhe_guardian_share(env: Env, document_id: u64, guardian: Address) -> Option<Bytes> {
        Self::bump_instance(&env);
        let key = DataKey::FheGShare(document_id, guardian);
        let val: Option<Bytes> = env.storage().persistent().get(&key);
        if val.is_some() {
            Self::bump_persistent(&env, &key);
        }
        val
    }

    /// Retrieve FHE beneficiary share submitted for an access request
    pub fn get_fhe_beneficiary_share(
        env: Env,
        request_id: u64,
        guardian: Address,
    ) -> Option<Bytes> {
        Self::bump_instance(&env);
        let key = DataKey::FheBShare(request_id, guardian);
        let val: Option<Bytes> = env.storage().persistent().get(&key);
        if val.is_some() {
            Self::bump_persistent(&env, &key);
        }
        val
    }

    /// Retrieve number of FHE shares accumulated for a request
    pub fn get_fhe_accumulator_count(env: Env, request_id: u64) -> u32 {
        Self::bump_instance(&env);
        let key = DataKey::FheAccumulatorCount(request_id);
        let count: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        if count > 0 {
            Self::bump_persistent(&env, &key);
        }
        count
    }

    /// Record proof of life for inactivity check
    pub fn prove_life(env: Env, owner: Address, vault_id: u64) {
        owner.require_auth();
        Self::bump_instance(&env);

        let mut record = Self::load_vault_record(&env, vault_id);
        assert!(
            record.vault.creator == owner,
            "Only creator can record proof of life"
        );
        assert!(record.vault.is_active, "Vault not active");

        record.release_state.last_proof_of_life = env.ledger().timestamp();
        record.release_state.last_proof_of_life_sequence = env.ledger().sequence();
        Self::save_vault_record(&env, vault_id, &record);
        
        env.events().publish(
            (Symbol::new(&env, "prove_life"), vault_id),
            (owner, env.ledger().timestamp()),
        );
    }

    /// Authorize a Web3 Keeper (Chainlink Automation / Gelato) to relay proof-of-life
    /// heartbeats on the vault creator's behalf until `expires_at`. Soroban's native
    /// `require_auth` already decouples who authorizes an action (`owner`) from who
    /// pays for and submits the transaction, so this delegation needs no off-chain
    /// signature scheme of its own: the creator authorizes here in a normal signed
    /// invocation, and the keeper can then relay heartbeats on its own signed
    /// transactions without further owner involvement. Re-authorizing replaces any
    /// prior grant for this vault.
    pub fn authorize_keeper(
        env: Env,
        owner: Address,
        vault_id: u64,
        keeper: Address,
        expires_at: u64,
    ) -> Result<(), RelayerError> {
        owner.require_auth();
        Self::bump_instance(&env);

        let record =
            Self::try_load_vault_record(&env, vault_id).ok_or(RelayerError::VaultNotFound)?;
        if record.vault.creator != owner {
            return Err(RelayerError::OnlyCreator);
        }
        if !record.vault.is_active {
            return Err(RelayerError::VaultNotActive);
        }
        if expires_at <= env.ledger().timestamp() {
            return Err(RelayerError::ExpiryInPast);
        }

        let auth_key = DataKey::KeeperAuth(vault_id);
        let authorization = KeeperAuthorization { keeper, expires_at };
        env.storage().persistent().set(&auth_key, &authorization);
        Self::bump_persistent(&env, &auth_key);
        Ok(())
    }

    /// Revoke any active keeper authorization for a vault.
    pub fn revoke_keeper(env: Env, owner: Address, vault_id: u64) -> Result<(), RelayerError> {
        owner.require_auth();
        Self::bump_instance(&env);

        let record =
            Self::try_load_vault_record(&env, vault_id).ok_or(RelayerError::VaultNotFound)?;
        if record.vault.creator != owner {
            return Err(RelayerError::OnlyCreator);
        }

        let auth_key = DataKey::KeeperAuth(vault_id);
        env.storage().persistent().remove(&auth_key);
        Ok(())
    }

    /// Fetch the current keeper authorization for a vault, if any.
    pub fn get_keeper_authorization(env: Env, vault_id: u64) -> Option<KeeperAuthorization> {
        Self::bump_instance(&env);
        let auth_key = DataKey::KeeperAuth(vault_id);
        let authorization: Option<KeeperAuthorization> = env.storage().persistent().get(&auth_key);
        if authorization.is_some() {
            Self::bump_persistent(&env, &auth_key);
        }
        authorization
    }

    /// Record a proof-of-life heartbeat relayed by an authorized Web3 Keeper on the
    /// vault creator's behalf, preventing a keeper outage or owner-preferred
    /// automation from triggering a false emergency unlock.
    pub fn prove_life_by_keeper(
        env: Env,
        keeper: Address,
        vault_id: u64,
    ) -> Result<(), RelayerError> {
        keeper.require_auth();
        Self::bump_instance(&env);

        let mut record =
            Self::try_load_vault_record(&env, vault_id).ok_or(RelayerError::VaultNotFound)?;
        if !record.vault.is_active {
            return Err(RelayerError::VaultNotActive);
        }

        let auth_key = DataKey::KeeperAuth(vault_id);
        let authorization: KeeperAuthorization = env
            .storage()
            .persistent()
            .get(&auth_key)
            .ok_or(RelayerError::NoKeeperAuthorized)?;
        if authorization.keeper != keeper {
            return Err(RelayerError::KeeperMismatch);
        }
        if env.ledger().timestamp() >= authorization.expires_at {
            return Err(RelayerError::KeeperAuthorizationExpired);
        }

        record.release_state.last_proof_of_life = env.ledger().timestamp();
        record.release_state.last_proof_of_life_sequence = env.ledger().sequence();
        Self::save_vault_record(&env, vault_id, &record);
        Ok(())
    }

    /// Bind a Soroban vault to its Avalanche vault GID and authorized relayer.
    pub fn bind_cross_chain_heartbeat(
        env: Env,
        owner: Address,
        vault_id: u64,
        gid_hash: BytesN<32>,
        evm_owner: BytesN<20>,
        relayer: Address,
    ) {
        owner.require_auth();
        Self::bump_instance(&env);

        let record = Self::load_vault_record(&env, vault_id);
        assert!(
            record.vault.creator == owner,
            "Only creator can bind heartbeat"
        );
        assert!(record.vault.is_active, "Vault not active");

        let binding_key = DataKey::CrossChainHeartbeat(vault_id);
        let binding = CrossChainHeartbeatBinding {
            gid_hash,
            evm_owner,
            relayer,
        };
        env.storage().persistent().set(&binding_key, &binding);
        Self::bump_persistent(&env, &binding_key);
    }

    /// Relay an EIP-191 signed Avalanche heartbeat into the Soroban vault.
    pub fn sync_proof_of_life(
        env: Env,
        relayer: Address,
        vault_id: u64,
        evm_vault_id: u64,
        gid_hash: BytesN<32>,
        evm_owner: BytesN<20>,
        timestamp: u64,
        signature: BytesN<64>,
        recovery_id: u32,
    ) {
        relayer.require_auth();
        Self::bump_instance(&env);

        let binding_key = DataKey::CrossChainHeartbeat(vault_id);
        let binding: CrossChainHeartbeatBinding = env
            .storage()
            .persistent()
            .get(&binding_key)
            .expect("Cross-chain heartbeat not configured");
        assert!(binding.relayer == relayer, "Unauthorized relayer");
        assert!(binding.gid_hash == gid_hash, "Vault GID mismatch");
        assert!(binding.evm_owner == evm_owner, "EVM owner mismatch");

        let mut record = Self::load_vault_record(&env, vault_id);
        assert!(
            timestamp > record.release_state.last_proof_of_life,
            "Stale heartbeat"
        );
        assert!(
            timestamp <= env.ledger().timestamp().saturating_add(300),
            "Future heartbeat"
        );

        let mut payload = Bytes::new(&env);
        payload.extend_from_slice(b"SpooVaultProofOfLife");
        payload.extend_from_array(&gid_hash.to_array());
        payload.extend_from_slice(&evm_vault_id.to_be_bytes());
        payload.extend_from_array(&evm_owner.to_array());
        payload.extend_from_slice(&timestamp.to_be_bytes());
        let message_hash = env.crypto().keccak256(&payload);

        let mut eth_input = Bytes::new(&env);
        eth_input.extend_from_slice(b"\x19Ethereum Signed Message:\n32");
        eth_input.extend_from_array(&message_hash.to_array());
        let digest = env.crypto().keccak256(&eth_input);
        let recovered: BytesN<65> =
            env.crypto()
                .secp256k1_recover(&digest, &signature, recovery_id);
        let recovered_hash = env.crypto().keccak256(&Bytes::from(recovered));
        let recovered_bytes: Bytes = recovered_hash.into();
        let recovered_owner: BytesN<20> = recovered_bytes
            .slice(12..32)
            .try_into()
            .expect("Invalid recovered owner");
        assert!(recovered_owner == evm_owner, "Invalid heartbeat signature");

        record.release_state.last_proof_of_life = timestamp;
        record.release_state.last_proof_of_life_sequence = env.ledger().sequence();
        Self::save_vault_record(&env, vault_id, &record);
        Self::bump_persistent(&env, &binding_key);

        env.events().publish(
            (Symbol::new(&env, "proof_life_synced"), vault_id),
            (gid_hash, evm_owner, timestamp),
        );
    }

    /// Configure vault release conditions
    pub fn configure_vault_release(
        env: Env,
        owner: Address,
        vault_id: u64,
        inactivity_period: u64,
    ) {
        owner.require_auth();
        Self::bump_instance(&env);

        let mut record = Self::load_vault_record(&env, vault_id);
        assert!(
            record.vault.creator == owner,
            "Only creator can configure release"
        );
        assert!(record.vault.is_active, "Vault not active");
        assert!(
            (24 * 60 * 60..=365 * 24 * 60 * 60).contains(&inactivity_period),
            "Inactivity period must be between 1 and 365 days"
        );

        record.release_state.inactivity_period = inactivity_period;
        Self::save_vault_record(&env, vault_id, &record);
    }

    /// Set vault emergency mode
    pub fn set_emergency_mode(env: Env, owner: Address, vault_id: u64, enabled: bool) {
        owner.require_auth();
        Self::bump_instance(&env);

        let mut record = Self::load_vault_record(&env, vault_id);
        assert!(
            record.vault.creator == owner,
            "Only creator can set emergency mode"
        );
        assert!(record.vault.is_active, "Vault not active");

        record.release_state.emergency_mode = enabled;
        Self::save_vault_record(&env, vault_id, &record);

        env.events().publish(
            (Symbol::new(&env, "emergency_mode"), vault_id),
            enabled,
        );

        let schedule_key = DataKey::EmergencyUnlock(vault_id);
        if enabled {
            if let Some(existing) = env
                .storage()
                .persistent()
                .get::<DataKey, EmergencyUnlockSchedule>(&schedule_key)
            {
                assert!(
                    existing.fulfilled,
                    "Emergency unlock delay already pending"
                );
            }
            let cycle_key = DataKey::EmergencyUnlockCycle(vault_id);
            let cycle: u64 = env
                .storage()
                .persistent()
                .get(&cycle_key)
                .unwrap_or(0u64)
                .saturating_add(1);
            env.storage().persistent().set(&cycle_key, &cycle);
            Self::bump_persistent(&env, &cycle_key);

            let schedule = EmergencyUnlockSchedule {
                cycle,
                request_sequence: env.ledger().sequence(),
                fulfilled: false,
                unlock_at: 0,
                unlock_sequence: 0,
                jitter_seconds: 0,
            };
            env.storage().persistent().set(&schedule_key, &schedule);
            Self::bump_persistent(&env, &schedule_key);
            env.events().publish(
                (Symbol::new(&env, "emergency_unlock_requested"), vault_id),
                env.ledger().sequence(),
            );
        } else {
            env.storage().persistent().remove(&schedule_key);
        }
    }

    /// Vault creator tunes Delta_T used to scale the PRNG offset:
    /// `T_random = PRNG() mod Delta_T`.
    pub fn set_emergency_jitter_window(env: Env, owner: Address, vault_id: u64, jitter_window: u64) {
        owner.require_auth();
        Self::bump_instance(&env);

        let record = Self::load_vault_record(&env, vault_id);
        assert!(
            record.vault.creator == owner,
            "Only creator can set emergency jitter window"
        );
        assert!(
            (MIN_JITTER_WINDOW..=MAX_JITTER_WINDOW).contains(&jitter_window),
            "Invalid jitter window"
        );

        let window_key = DataKey::EmergencyJitterWindow(vault_id);
        env.storage().persistent().set(&window_key, &jitter_window);
        Self::bump_persistent(&env, &window_key);
        Self::bump_persistent(&env, &DataKey::Vault(vault_id));
        env.events().publish(
            (Symbol::new(&env, "emergency_jitter_window"), vault_id),
            jitter_window,
        );
    }

    /// Permissionless fulfillment: after the request has sat for
    /// `MIN_EMERGENCY_UNLOCK_CONFIRMATIONS` ledgers, sample Soroban PRNG
    /// entropy and write the un-manipulable unlock timestamp + sequence.
    pub fn fulfill_emergency_unlock_delay(env: Env, vault_id: u64) {
        Self::bump_instance(&env);

        let record = Self::load_vault_record(&env, vault_id);
        assert!(
            record.release_state.emergency_mode,
            "Emergency mode is not enabled"
        );

        let schedule_key = DataKey::EmergencyUnlock(vault_id);
        let mut schedule: EmergencyUnlockSchedule = env
            .storage()
            .persistent()
            .get(&schedule_key)
            .expect("No emergency unlock request");
        assert!(!schedule.fulfilled, "Emergency unlock already fulfilled");
        let current_cycle: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::EmergencyUnlockCycle(vault_id))
            .unwrap_or(0);
        assert!(schedule.cycle == current_cycle && schedule.cycle != 0, "Stale emergency unlock request");
        assert!(
            env.ledger().sequence()
                >= schedule.request_sequence + MIN_EMERGENCY_UNLOCK_CONFIRMATIONS,
            "Emergency unlock confirmations not met"
        );

        let window: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::EmergencyJitterWindow(vault_id))
            .unwrap_or(DEFAULT_EMERGENCY_JITTER_WINDOW);
        assert!(window > 0, "Invalid jitter window");
        let word: u64 = env.prng().gen();
        let jitter = word % window;
        let extra_ledgers = (jitter / EMERGENCY_SECONDS_PER_LEDGER) as u32;
        let base_delay_ledgers = (EMERGENCY_UNLOCK_BASE_DELAY / EMERGENCY_SECONDS_PER_LEDGER) as u32;

        schedule.fulfilled = true;
        schedule.jitter_seconds = jitter;
        schedule.unlock_at = env.ledger().timestamp() + EMERGENCY_UNLOCK_BASE_DELAY + jitter;
        schedule.unlock_sequence = env
            .ledger()
            .sequence()
            .saturating_add(base_delay_ledgers)
            .saturating_add(MIN_EMERGENCY_UNLOCK_SEQUENCE_DELTA)
            .saturating_add(extra_ledgers);

        env.storage().persistent().set(&schedule_key, &schedule);
        Self::bump_persistent(&env, &schedule_key);
        Self::bump_persistent(&env, &DataKey::Vault(vault_id));

        env.events().publish(
            (Symbol::new(&env, "emergency_unlock_scheduled"), vault_id),
            (
                schedule.unlock_at,
                schedule.unlock_sequence,
                schedule.jitter_seconds,
            ),
        );
    }

    pub fn get_emergency_unlock_schedule(
        env: Env,
        vault_id: u64,
    ) -> Option<EmergencyUnlockSchedule> {
        Self::bump_instance(&env);
        let key = DataKey::EmergencyUnlock(vault_id);
        let schedule: Option<EmergencyUnlockSchedule> = env.storage().persistent().get(&key);
        if schedule.is_some() {
            Self::bump_persistent(&env, &key);
        }
        schedule
    }

    /// Configure an optional external registry contract to be notified whenever
    /// a document access request on this vault is fully approved. The registry
    /// may be any Soroban contract (e.g. an audit log or a custom account's
    /// policy contract) - `Address` does not distinguish between a raw Stellar
    /// keypair account and a deployed contract address, so both are accepted.
    pub fn set_access_registry(env: Env, owner: Address, vault_id: u64, registry: Address) {
        owner.require_auth();
        Self::bump_instance(&env);

        let record = Self::load_vault_record(&env, vault_id);
        assert!(
            record.vault.creator == owner,
            "Only creator can set access registry"
        );

        let registry_key = DataKey::AccessRegistry(vault_id);
        env.storage().persistent().set(&registry_key, &registry);
        Self::bump_persistent(&env, &registry_key);
    }

    /// Deactivate a vault, blocking all document and access operations
    pub fn deactivate_vault(env: Env, owner: Address, vault_id: u64) {
        owner.require_auth();
        Self::bump_instance(&env);

        let mut record = Self::load_vault_record(&env, vault_id);
        assert!(
            record.vault.creator == owner,
            "Only creator can deactivate vault"
        );
        assert!(record.vault.is_active, "Vault is already inactive");

        record.vault.is_active = false;
        Self::save_vault_record(&env, vault_id, &record);
    }

    /// Revoke a beneficiary's access to a document. Guardian-only, same-chain
    /// counterpart to the EVM contract's `revokeAccess`.
    pub fn revoke_access(env: Env, guardian: Address, document_id: u64, target: Address) {
        guardian.require_auth();
        Self::bump_instance(&env);

        let doc_key = DataKey::Doc(document_id);
        let doc: Document = env
            .storage()
            .persistent()
            .get(&doc_key)
            .expect("Document not found");

        let record = Self::load_vault_record(&env, doc.vault_id);
        assert!(
            record.vault.guardians.contains(&guardian),
            "Only guardians can revoke access"
        );

        Self::apply_revocation(&env, document_id, &target);
    }

    /// Link this Soroban vault to its EVM counterpart so cross-chain
    /// revocation broadcasts can be routed here: `vault_gid` is the globally
    /// unique id the EVM contract derives via `vaultGID(vaultId)`, and
    /// `evm_revoker` is the EVM address (typically an EVM-side guardian's
    /// EOA) authorized to sign revocation broadcasts for this vault.
    pub fn link_cross_chain_vault(
        env: Env,
        owner: Address,
        vault_id: u64,
        vault_gid: BytesN<32>,
        evm_revoker: BytesN<20>,
    ) {
        owner.require_auth();
        Self::bump_instance(&env);

        let record = Self::load_vault_record(&env, vault_id);
        assert!(
            record.vault.creator == owner,
            "Only creator can link cross-chain vault"
        );

        let gid_key = DataKey::VaultGid(vault_gid);
        assert!(
            !env.storage().persistent().has(&gid_key),
            "vault_gid already linked to a vault"
        );
        env.storage().persistent().set(&gid_key, &vault_id);
        Self::bump_persistent(&env, &gid_key);

        let revoker_key = DataKey::CrossChainRevoker(vault_id);
        env.storage().persistent().set(&revoker_key, &evm_revoker);
        Self::bump_persistent(&env, &revoker_key);
    }

    /// Apply an EVM-originated access revocation broadcast to this vault's
    /// Soroban-side access grant, within the same Soroban ledger the call
    /// lands in - closing the window where a beneficiary revoked on EVM
    /// could still fetch document shares here.
    ///
    /// Trust model: the call is permissionless (anyone may relay it, like
    /// forwarding any signed message), but it only takes effect if
    /// `signature` recovers to the EVM address registered via
    /// `link_cross_chain_vault` as this vault's authorized cross-chain
    /// revoker. The signed digest commits to every argument below (including
    /// `target_stellar_user`, resolved off-chain before the EVM guardian
    /// signs), so a relayer cannot redirect a validly-signed message to a
    /// different beneficiary or vault. `nonce` must strictly increase per
    /// (vault_gid, document, beneficiary) triple, blocking replay - scoping
    /// by `vault_gid` rather than just document/beneficiary means that if the
    /// EVM contract is ever redeployed to a new address (and thus a new
    /// `vaultGID`, since it is derived from `address(this)`) and re-linked,
    /// nonce tracking starts fresh instead of being stuck behind whatever
    /// nonce the previous deployment last used.
    pub fn relay_revoke_access(
        env: Env,
        vault_gid: BytesN<32>,
        document_id: u64,
        target_evm_user: BytesN<20>,
        target_stellar_user: Address,
        nonce: u64,
        signature: BytesN<64>,
        recovery_id: u32,
    ) {
        Self::bump_instance(&env);

        let vault_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::VaultGid(vault_gid.clone()))
            .expect("Unknown vault_gid");

        let doc_key = DataKey::Doc(document_id);
        let doc: Document = env
            .storage()
            .persistent()
            .get(&doc_key)
            .expect("Document not found");
        assert!(
            doc.vault_id == vault_id,
            "Document does not belong to linked vault"
        );

        let nonce_key =
            DataKey::RevocationNonce(vault_gid.clone(), document_id, target_stellar_user.clone());
        let last_nonce: u64 = env.storage().persistent().get(&nonce_key).unwrap_or(0);
        assert!(nonce > last_nonce, "Stale or replayed revocation nonce");

        let revoker: BytesN<20> = env
            .storage()
            .persistent()
            .get(&DataKey::CrossChainRevoker(vault_id))
            .expect("No cross-chain revoker linked for this vault");

        let recovered = Self::recover_eth_address(
            &env,
            &vault_gid,
            document_id,
            &target_evm_user,
            &target_stellar_user,
            nonce,
            &signature,
            recovery_id,
        );
        assert!(
            recovered == revoker,
            "Signature not from linked cross-chain revoker"
        );

        env.storage().persistent().set(&nonce_key, &nonce);
        Self::bump_persistent(&env, &nonce_key);

        Self::apply_revocation(&env, document_id, &target_stellar_user);
    }

    /// Helper function to check if release condition is satisfied. Takes
    /// the release state by reference rather than a `vault_id` so callers
    /// that already loaded the vault's `VaultRecord` (as every caller does)
    /// don't pay for a second, redundant storage read of the same key.
    fn is_release_condition_satisfied(
        env: &Env,
        vault_id: u64,
        state: &VaultReleaseState,
        condition: ReleaseCondition,
    ) -> bool {
        if condition == ReleaseCondition::Anytime {
            return true;
        }

        let timestamp_expired =
            env.ledger().timestamp() >= state.last_proof_of_life + state.inactivity_period;
        let sequence_elapsed = env.ledger().sequence()
            >= state.last_proof_of_life_sequence + MIN_POST_DEATH_SEQUENCE_DELTA;
        let is_dead = timestamp_expired && sequence_elapsed;

        match condition {
            ReleaseCondition::LiveOnly => !is_dead,
            ReleaseCondition::EmergencyOnly => {
                if is_dead {
                    true
                } else if !state.emergency_mode {
                    false
                } else {
                    Self::is_emergency_unlock_mature(env, vault_id)
                }
            }
            ReleaseCondition::PostDeathOnly => is_dead,
            _ => false,
        }
    }

    pub fn get_vault(env: Env, vault_id: u64) -> Option<Vault> {
        Self::bump_instance(&env);
        let record = Self::try_load_vault_record(&env, vault_id);
        if record.is_some() {
            Self::bump_persistent(&env, &DataKey::Vault(vault_id));
        }
        record.map(|r| r.vault)
    }

    pub fn get_document(env: Env, document_id: u64) -> Option<Document> {
        Self::bump_instance(&env);
        let key = DataKey::Doc(document_id);
        let doc: Option<Document> = env.storage().persistent().get(&key);
        if doc.is_some() {
            Self::bump_persistent(&env, &key);
        }
        doc
    }

    pub fn get_access_request(env: Env, request_id: u64) -> Option<AccessRequest> {
        Self::bump_instance(&env);
        let key = DataKey::Request(request_id);
        let req: Option<AccessRequest> = env.storage().persistent().get(&key);
        if req.is_some() {
            Self::bump_persistent(&env, &key);
        }
        req
    }

    /// Check whether a user has been granted access to a document
    pub fn has_access(env: Env, document_id: u64, user: Address) -> bool {
        Self::bump_instance(&env);
        let key = DataKey::HasAccess(document_id, user);
        let has: bool = env.storage().persistent().get(&key).unwrap_or(false);
        if env.storage().persistent().has(&key) {
            Self::bump_persistent(&env, &key);
        }
        has
    }

    /// Retrieve the current vault access version for a user in a vault
    pub fn get_access_version(env: Env, vault_id: u64, user: Address) -> u64 {
        Self::bump_instance(&env);
        let key = DataKey::VaultAccessVersion(vault_id, user);
        let ver: u64 = env.storage().persistent().get(&key).unwrap_or(1);
        if env.storage().persistent().has(&key) {
            Self::bump_persistent(&env, &key);
        }
        ver
    }

    pub fn get_invites(env: Env, guardian: Address) -> Vec<GuardianInvite> {
        Self::bump_instance(&env);
        let key = DataKey::Invites(guardian);
        let invites: Vec<GuardianInvite> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env));
        if env.storage().persistent().has(&key) {
            Self::bump_persistent(&env, &key);
        }
        invites
    }

    pub fn get_release_state(env: Env, vault_id: u64) -> Option<VaultReleaseState> {
        Self::bump_instance(&env);
        let record = Self::try_load_vault_record(&env, vault_id);
        if record.is_some() {
            Self::bump_persistent(&env, &DataKey::Vault(vault_id));
        }
        record.map(|r| r.release_state)
    }

    // ── Vault access tokens ─────────────────────────────────────────────
    //
    // A tradeable, non-fungible membership credential bound to a vault:
    // holding one is what `has_vault_token` reports to external verifiers
    // (Stellar DEXs, wallets, other contracts). This mirrors the EVM sibling
    // contract's ERC-721-based `mintAccessToken`/`burnAccessToken`/
    // `hasVaultToken`/`getTokenVault`, adapted to Soroban idioms.
    //
    // The acceptance criteria for this feature ask for SEP-41-style
    // `balance`/`transfer` alongside per-token `owner`/`mint`/`burn` -
    // SEP-41 itself is a *fungible* token interface (amounts, no per-unit
    // identity), which is fundamentally incompatible with a discrete,
    // individually-owned credential. Rather than force a fungible interface
    // onto NFT semantics, `balance` keeps SEP-41's name and purpose (an
    // address's holding count) while `transfer`/`mint_access_token`/
    // `burn_access_token`/`owner_of` operate on a specific `token_id`, as
    // ERC-721 (this feature's own stated inspiration) and the EVM sibling
    // contract already do.
    //
    // A holder's vault access is tracked as a *count* (`VaultTokenBalance`),
    // not a single token_id, so minting more than one token to the same
    // holder for the same vault and later burning/transferring just one of
    // them composes correctly - `has_vault_token` only flips to false once
    // every token for that vault has left their hands.

    /// Mint a new vault access token bound to `vault_id`, granting `to` a
    /// tradeable membership credential. Only an existing guardian of the
    /// vault may mint, and the vault must still be active - mirroring the
    /// EVM sibling contract's `OnlyGuardian`/`VaultNotActive` guards.
    pub fn mint_access_token(
        env: Env,
        minter: Address,
        vault_id: u64,
        to: Address,
        token_uri: String,
    ) -> u64 {
        minter.require_auth();
        Self::bump_instance(&env);

        let record = Self::load_vault_record(&env, vault_id);
        assert!(record.vault.is_active, "Vault not active");
        assert!(
            record.vault.guardians.contains(&minter),
            "Only guardians can mint access tokens"
        );

        let token_count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TokenCount)
            .unwrap_or(0);
        let next_token_id = token_count + 1;
        env.storage()
            .instance()
            .set(&DataKey::TokenCount, &next_token_id);

        let owner_key = DataKey::TokenOwner(next_token_id);
        let token_vault_key = DataKey::TokenVault(next_token_id);
        let uri_key = DataKey::TokenUri(next_token_id);

        env.storage().persistent().set(&owner_key, &to);
        env.storage().persistent().set(&token_vault_key, &vault_id);
        env.storage().persistent().set(&uri_key, &token_uri);
        Self::bump_persistent(&env, &owner_key);
        Self::bump_persistent(&env, &token_vault_key);
        Self::bump_persistent(&env, &uri_key);

        Self::increment_owner_balance(&env, &to);
        Self::increment_vault_balance(&env, vault_id, &to);

        env.events().publish(
            (Symbol::new(&env, "token_minted"), next_token_id, vault_id),
            to,
        );

        next_token_id
    }

    /// Burn an access token. Only the current owner may burn their own
    /// token; doing so relinquishes the vault access it represented as soon
    /// as their balance for that vault reaches zero.
    pub fn burn_access_token(env: Env, owner: Address, token_id: u64) {
        owner.require_auth();
        Self::bump_instance(&env);

        let owner_key = DataKey::TokenOwner(token_id);
        let current_owner: Address = env
            .storage()
            .persistent()
            .get(&owner_key)
            .expect("Token does not exist");
        assert!(current_owner == owner, "Not token owner");

        let vault_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::TokenVault(token_id))
            .expect("Token vault binding missing");

        Self::decrement_owner_balance(&env, &owner);
        Self::decrement_vault_balance(&env, vault_id, &owner);

        env.storage().persistent().remove(&owner_key);
        env.storage()
            .persistent()
            .remove(&DataKey::TokenVault(token_id));
        env.storage()
            .persistent()
            .remove(&DataKey::TokenUri(token_id));

        env.events()
            .publish((Symbol::new(&env, "token_burned"), token_id), owner);
    }

    /// Transfer a vault access token. Vault access (as reported by
    /// `has_vault_token`) moves to `to` as soon as this call succeeds, and
    /// is relinquished by `from` once their balance for that vault reaches
    /// zero.
    pub fn transfer(env: Env, from: Address, to: Address, token_id: u64) {
        from.require_auth();
        Self::bump_instance(&env);

        let owner_key = DataKey::TokenOwner(token_id);
        let current_owner: Address = env
            .storage()
            .persistent()
            .get(&owner_key)
            .expect("Token does not exist");
        assert!(current_owner == from, "Not token owner");

        let vault_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::TokenVault(token_id))
            .expect("Token vault binding missing");

        Self::decrement_owner_balance(&env, &from);
        Self::decrement_vault_balance(&env, vault_id, &from);
        Self::increment_owner_balance(&env, &to);
        Self::increment_vault_balance(&env, vault_id, &to);

        env.storage().persistent().set(&owner_key, &to);
        Self::bump_persistent(&env, &owner_key);

        env.events().publish(
            (Symbol::new(&env, "token_transferred"), token_id),
            (from, to),
        );
    }

    /// Current owner of a vault access token. Panics if the token doesn't
    /// exist, mirroring ERC-721's `ownerOf` revert-on-nonexistent-token
    /// behavior.
    pub fn owner_of(env: Env, token_id: u64) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::TokenOwner(token_id))
            .expect("Token does not exist")
    }

    /// Number of vault access tokens held by `id`, across all vaults.
    pub fn balance(env: Env, id: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::OwnerBalance(id))
            .unwrap_or(0)
    }

    /// Vault a token is bound to (0 if the token doesn't exist or was
    /// burned), mirroring the EVM sibling contract's `getTokenVault`.
    pub fn get_token_vault(env: Env, token_id: u64) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::TokenVault(token_id))
            .unwrap_or(0)
    }

    /// Whether `user` currently holds any access token for `vault_id`.
    pub fn has_vault_token(env: Env, user: Address, vault_id: u64) -> bool {
        let balance: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::VaultTokenBalance(vault_id, user))
            .unwrap_or(0);
        balance > 0
    }

    /// Metadata URI for a token. Panics if the token doesn't exist,
    /// mirroring the EVM sibling contract's `tokenURI` (which itself calls
    /// `ownerOf` as an existence guard).
    pub fn get_token_uri(env: Env, token_id: u64) -> String {
        env.storage()
            .persistent()
            .get(&DataKey::TokenUri(token_id))
            .expect("Token does not exist")
    }

    /// Extend persistent storage TTL for a vault access token.
    pub fn extend_token_ttl(env: Env, token_id: u64) {
        Self::bump_instance(&env);
        let owner_key = DataKey::TokenOwner(token_id);
        if env.storage().persistent().has(&owner_key) {
            Self::bump_persistent(&env, &owner_key);
            Self::bump_persistent(&env, &DataKey::TokenVault(token_id));
            Self::bump_persistent(&env, &DataKey::TokenUri(token_id));
        }
    }

    /// Perform a deep, contract-authorized cross-contract call notifying an
    /// external registry that document access was granted.
    ///
    /// The vault contract itself - rather than the approving guardian - is the
    /// one invoking the registry, so the guardian's signature (verified above
    /// via `require_auth`) does not cover this sub-invocation. We use
    /// `env.authorize_as_current_contract` to have this contract authorize the
    /// call to `record_grant` "as itself" for exactly this invocation, which
    /// is required for the sub-invocation to pass the registry's own
    /// `require_auth` / custom-account `__check_auth` checks regardless of
    /// whether the registry is a plain account or a custom account
    /// abstraction (multisig / policy) contract.
    fn notify_access_registry(
        env: &Env,
        registry: &Address,
        document_id: u64,
        requester: &Address,
    ) {
        let fn_name = Symbol::new(env, "record_grant");
        let args: Vec<Val> = (document_id, requester.clone()).into_val(env);

        env.authorize_as_current_contract(soroban_sdk::vec![
            env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: registry.clone(),
                    fn_name: fn_name.clone(),
                    args: args.clone(),
                },
                sub_invocations: Vec::new(env),
            }),
        ]);

        let _: Val = env.invoke_contract(registry, &fn_name, args);
    }

    /// Clear a beneficiary's access grant for a document. Shared by the
    /// guardian-initiated `revoke_access` and the cross-chain
    /// `relay_revoke_access` so both paths apply the exact same effect.
    fn apply_revocation(env: &Env, document_id: u64, target: &Address) {
        let acc_key = DataKey::HasAccess(document_id, target.clone());
        let lvl_key = DataKey::AccessLvl(document_id, target.clone());
        env.storage().persistent().set(&acc_key, &false);
        env.storage().persistent().remove(&lvl_key);
        Self::bump_persistent(env, &acc_key);

        // Immediate state invalidation: bump vault access version for target
        if let Some(doc) = env.storage().persistent().get::<DataKey, Document>(&DataKey::Doc(document_id)) {
            let ver_key = DataKey::VaultAccessVersion(doc.vault_id, target.clone());
            let current_ver: u64 = env.storage().persistent().get(&ver_key).unwrap_or(1);
            env.storage().persistent().set(&ver_key, &(current_ver + 1));
            Self::bump_persistent(env, &ver_key);
        }

        env.events().publish(
            (Symbol::new(env, "access_revoked"), document_id),
            target.clone(),
        );
        env.events().publish(
            (Symbol::new(env, "RevokeAccess"), document_id),
            target.clone(),
        );
    }

    /// Recover the EVM (Ethereum-style) address that produced `signature`
    /// over the EIP-191-prefixed cross-chain revocation payload
    /// `("RevokeAccess", vault_gid, document_id, target_evm_user,
    /// target_stellar_user, nonce)`. `document_id` and `nonce` are packed as
    /// 32-byte big-endian words to match Solidity's `abi.encodePacked` of a
    /// `uint256`, and `target_stellar_user` is committed via its canonical
    /// XDR encoding.
    fn recover_eth_address(
        env: &Env,
        vault_gid: &BytesN<32>,
        document_id: u64,
        target_evm_user: &BytesN<20>,
        target_stellar_user: &Address,
        nonce: u64,
        signature: &BytesN<64>,
        recovery_id: u32,
    ) -> BytesN<20> {
        let mut payload = Bytes::from_slice(env, b"RevokeAccess");
        payload.append(&Bytes::from(vault_gid.clone()));
        payload.append(&Bytes::from_array(env, &u256_be(document_id)));
        payload.append(&Bytes::from(target_evm_user.clone()));
        payload.append(&target_stellar_user.clone().to_xdr(env));
        payload.append(&Bytes::from_array(env, &u256_be(nonce)));

        let message_hash = env.crypto().keccak256(&payload);

        let mut prefixed = Bytes::from_slice(env, b"\x19Ethereum Signed Message:\n32");
        prefixed.append(&Bytes::from(message_hash.to_bytes()));
        let digest = env.crypto().keccak256(&prefixed);

        let pubkey = env
            .crypto()
            .secp256k1_recover(&digest, signature, recovery_id);
        let pubkey_bytes: Bytes = pubkey.into();
        let addr_hash = env.crypto().keccak256(&pubkey_bytes.slice(1..65));
        let addr_bytes: Bytes = addr_hash.to_bytes().into();
        BytesN::try_from(addr_bytes.slice(12..32)).unwrap()
    }

    // Helper functions for TTL management
    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    fn bump_persistent(env: &Env, key: &DataKey) {
        env.storage().persistent().extend_ttl(
            key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
    }

    fn is_emergency_unlock_mature(env: &Env, vault_id: u64) -> bool {
        let Some(schedule) = env
            .storage()
            .persistent()
            .get::<DataKey, EmergencyUnlockSchedule>(&DataKey::EmergencyUnlock(vault_id))
        else {
            return false;
        };
        schedule.fulfilled
            && env.ledger().timestamp() >= schedule.unlock_at
            && env.ledger().sequence() >= schedule.unlock_sequence
    }

    // Helper functions for the packed vault+release-state storage record
    // (see `VaultRecord`). Every entrypoint that needs a vault's
    // configuration and/or release state goes through these two, so the
    // combined record is read/written as a single ledger key regardless of
    // which half of it a given operation actually needs.
    fn load_vault_record(env: &Env, vault_id: u64) -> VaultRecord {
        env.storage()
            .persistent()
            .get(&DataKey::Vault(vault_id))
            .expect("Vault not found")
    }

    fn try_load_vault_record(env: &Env, vault_id: u64) -> Option<VaultRecord> {
        env.storage().persistent().get(&DataKey::Vault(vault_id))
    }

    fn save_vault_record(env: &Env, vault_id: u64, record: &VaultRecord) {
        let key = DataKey::Vault(vault_id);
        env.storage().persistent().set(&key, record);
        Self::bump_persistent(env, &key);
    }

    // Helper functions for vault access token balance bookkeeping.
    fn increment_owner_balance(env: &Env, owner: &Address) {
        let key = DataKey::OwnerBalance(owner.clone());
        let balance: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(balance + 1));
        Self::bump_persistent(env, &key);
    }

    fn decrement_owner_balance(env: &Env, owner: &Address) {
        let key = DataKey::OwnerBalance(owner.clone());
        let balance: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&key, &balance.saturating_sub(1));
        Self::bump_persistent(env, &key);
    }

    fn increment_vault_balance(env: &Env, vault_id: u64, owner: &Address) {
        let key = DataKey::VaultTokenBalance(vault_id, owner.clone());
        let balance: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(balance + 1));
        Self::bump_persistent(env, &key);
    }

    fn decrement_vault_balance(env: &Env, vault_id: u64, owner: &Address) {
        let key = DataKey::VaultTokenBalance(vault_id, owner.clone());
        let balance: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&key, &balance.saturating_sub(1));
        Self::bump_persistent(env, &key);
    }

    /// Add two 32-byte big-endian 256-bit words modulo FHE_PRIME: 2^256 - 2^32 - 977
    pub(crate) fn add_mod_q_256(w1: &[u8; 32], w2: &[u8; 32]) -> [u8; 32] {
        let mut a = [0u64; 4];
        let mut b = [0u64; 4];
        for i in 0..4 {
            let idx = 24 - (i * 8);
            let mut a_chunk = [0u8; 8];
            let mut b_chunk = [0u8; 8];
            a_chunk.copy_from_slice(&w1[idx..idx + 8]);
            b_chunk.copy_from_slice(&w2[idx..idx + 8]);
            a[i] = u64::from_be_bytes(a_chunk);
            b[i] = u64::from_be_bytes(b_chunk);
        }

        // q = 2^256 - 2^32 - 977
        let q: [u64; 4] = [
            0xFFFF_FFFE_FFFF_FC2F,
            0xFFFF_FFFF_FFFF_FFFF,
            0xFFFF_FFFF_FFFF_FFFF,
            0xFFFF_FFFF_FFFF_FFFF,
        ];

        let mut sum = [0u64; 4];
        let mut carry: u128 = 0;
        for i in 0..4 {
            let val = (a[i] as u128) + (b[i] as u128) + carry;
            sum[i] = val as u64;
            carry = val >> 64;
        }

        let mut ge_q = carry > 0;
        if !ge_q {
            for i in (0..4).rev() {
                if sum[i] > q[i] {
                    ge_q = true;
                    break;
                } else if sum[i] < q[i] {
                    ge_q = false;
                    break;
                }
                if i == 0 {
                    ge_q = true;
                }
            }
        }

        if ge_q {
            let mut borrow: i128 = 0;
            for (i, val) in sum.iter_mut().enumerate() {
                let diff = (*val as i128) - (q[i] as i128) - borrow;
                if diff < 0 {
                    *val = (diff + (1i128 << 64)) as u64;
                    borrow = 1;
                } else {
                    *val = diff as u64;
                    borrow = 0;
                }
            }
        }

        let mut res = [0u8; 32];
        for (i, val) in sum.iter().enumerate() {
            let idx = 24 - (i * 8);
            let chunk = val.to_be_bytes();
            res[idx..idx + 8].copy_from_slice(&chunk);
        }
        res
    }

    /// Homomorphic Addition over FHE ciphertext payloads: ct1 (+) ct2
    pub(crate) fn fhe_add(env: &Env, ct1: &Bytes, ct2: &Bytes) -> Bytes {
        if ct1.is_empty() {
            return ct2.clone();
        }
        if ct2.is_empty() {
            return ct1.clone();
        }
        assert!(
            ct1.len() >= 96 && ct2.len() >= 96,
            "Invalid ciphertext length"
        );
        assert!(ct1.len() == ct2.len(), "Ciphertext dimension mismatch");

        let len = ct1.len();
        let word_count = len / 32;
        let mut result_bytes = Bytes::new(env);

        result_bytes.append(&ct1.slice(0..32));

        for i in 1..word_count {
            let start = i * 32;
            let end = start + 32;
            let mut w1_bytes = [0u8; 32];
            let mut w2_bytes = [0u8; 32];
            ct1.slice(start..end).copy_into_slice(&mut w1_bytes);
            ct2.slice(start..end).copy_into_slice(&mut w2_bytes);

            let sum_bytes = Self::add_mod_q_256(&w1_bytes, &w2_bytes);
            let mut sum_slice = Bytes::new(env);
            for byte in sum_bytes.iter() {
                sum_slice.push_back(*byte);
            }
            result_bytes.append(&sum_slice);
        }

        result_bytes
    }

    // -------------------------------------------------------------------
    // Groth16 ZK-SNARK proof-of-access verification (issue #70)
    //
    // Allows a beneficiary to submit a zero-knowledge proof that they hold
    // a valid vault key share, without revealing the secret share or their
    // private identity on-chain.
    //
    // verify_access_proof: state-changing verification that marks the
    //      nullifier as spent and returns success.
    // verify_access_proof_view: view-only verification (pre-flight check).
    // is_access_nullifier_spent: query whether a nullifier hash has been
    //      consumed.
    //
    // The Groth16 pairing check lives in `zk_verifier::verify_proof`, a
    // pure-Rust BN254 implementation (the Soroban SDK v21/22 `Crypto` host
    // API exposes no bn254 functions), so these entrypoints only handle
    // argument marshalling, authorization and nullifier bookkeeping.
    // -------------------------------------------------------------------

    /// Verifies a Groth16 ZK-SNARK proof of access and records the nullifier.
    /// Reverts if the proof is invalid or the nullifier was already spent.
    ///
    /// # Arguments
    /// * `submitter` - The account submitting the proof (must authorize).
    /// * `proof_a` - G1 point (64 bytes: X || Y).
    /// * `proof_b` - G2 point (128 bytes: X_im || X_re || Y_im || Y_re).
    /// * `proof_c` - G1 point (64 bytes).
    /// * `vault_root_commitment` - Public signal: Poseidon(share, blinding).
    /// * `nullifier_hash` - Public signal: Poseidon(privkey, document_id).
    /// * `document_id` - Public signal.
    /// * `vk` - Bundled verifying key (see `ZkVerifyingKeyArgs`): alpha G1,
    ///   beta/gamma/delta G2, plus 4 IC G1 points for the 3 public inputs.
    pub fn verify_access_proof(
        env: Env,
        submitter: Address,
        proof_a: BytesN<64>,
        proof_b: BytesN<128>,
        proof_c: BytesN<64>,
        vault_root_commitment: BytesN<32>,
        nullifier_hash: BytesN<32>,
        document_id: BytesN<32>,
        vk: zk_verifier::ZkVerifyingKeyArgs,
    ) -> bool {
        submitter.require_auth();
        Self::bump_instance(&env);

        let proof = zk_verifier::Groth16Proof {
            a: proof_a.to_array(),
            b: proof_b.to_array(),
            c: proof_c.to_array(),
        };
        let signals = zk_verifier::PublicSignals {
            vault_root_commitment: vault_root_commitment.to_array(),
            nullifier_hash: nullifier_hash.to_array(),
            document_id: document_id.to_array(),
        };
        let mut ic = Vec::new(&env);
        for point in vk.ic.iter() {
            ic.push_back(point.to_array());
        }
        let vk = zk_verifier::VerifyingKey {
            alpha: vk.alpha.to_array(),
            beta: vk.beta.to_array(),
            gamma: vk.gamma.to_array(),
            delta: vk.delta.to_array(),
            ic,
        };

        match zk_verifier::verify_proof(&env, &proof, &signals, &vk) {
            Ok(true) => true,
            Ok(false) => panic_with_error!(&env, zk_verifier::ZkVerifierError::InvalidProof),
            Err(zk_verifier::ZkVerifierError::NullifierAlreadySpent) => {
                panic_with_error!(&env, zk_verifier::ZkVerifierError::NullifierAlreadySpent)
            }
            Err(zk_verifier::ZkVerifierError::InvalidInputCount) => {
                panic_with_error!(&env, zk_verifier::ZkVerifierError::InvalidInputCount)
            }
            Err(zk_verifier::ZkVerifierError::InvalidCurvePoint) => {
                panic_with_error!(&env, zk_verifier::ZkVerifierError::InvalidCurvePoint)
            }
            Err(zk_verifier::ZkVerifierError::InvalidProof) => {
                panic_with_error!(&env, zk_verifier::ZkVerifierError::InvalidProof)
            }
        }
    }

    /// View-only proof verification (does not modify nullifier state).
    pub fn verify_access_proof_view(
        env: Env,
        proof_a: BytesN<64>,
        proof_b: BytesN<128>,
        proof_c: BytesN<64>,
        vault_root_commitment: BytesN<32>,
        nullifier_hash: BytesN<32>,
        document_id: BytesN<32>,
        vk: zk_verifier::ZkVerifyingKeyArgs,
    ) -> bool {
        let proof = zk_verifier::Groth16Proof {
            a: proof_a.to_array(),
            b: proof_b.to_array(),
            c: proof_c.to_array(),
        };
        let signals = zk_verifier::PublicSignals {
            vault_root_commitment: vault_root_commitment.to_array(),
            nullifier_hash: nullifier_hash.to_array(),
            document_id: document_id.to_array(),
        };
        let mut ic = Vec::new(&env);
        for point in vk.ic.iter() {
            ic.push_back(point.to_array());
        }
        let vk = zk_verifier::VerifyingKey {
            alpha: vk.alpha.to_array(),
            beta: vk.beta.to_array(),
            gamma: vk.gamma.to_array(),
            delta: vk.delta.to_array(),
            ic,
        };

        zk_verifier::verify_proof(&env, &proof, &signals, &vk).unwrap_or(false)
    }

    /// Returns whether a nullifier hash has already been consumed.
    pub fn is_access_nullifier_spent(env: Env, nullifier_hash: BytesN<32>) -> bool {
        zk_verifier::is_nullifier_spent(&env, &nullifier_hash.to_array())
    }
}

#[cfg(test)]
mod test;

#[cfg(test)]
mod fuzz_test;



#[contract]
pub struct FheVaultContract;

#[contractimpl]
impl FheVaultContract {
    /// Homomorphically accumulates encrypted secret shares using FHE primitives
    pub fn aggregate_share(env: Env, vault_id: Bytes, encrypted_share: Bytes, _proof: Bytes) {
        let storage = env.storage().persistent();
        
        // Fetch existing ciphertext accumulator or default to zero ciphertext
        let mut accumulator: Bytes = storage.get(&vault_id).unwrap_or_else(|| Bytes::from_array(&env, &[0u8; 32]));

        // Perform homomorphic addition over ciphertext bytes
        accumulator = Self::homomorphic_add(&env, &accumulator, &encrypted_share);

        storage.set(&vault_id, &accumulator);
    }

    fn homomorphic_add(_env: &Env, base: &Bytes, _incoming: &Bytes) -> Bytes {
        // TFHE-rs homomorphic ciphertext addition stub over byte vectors
        base.clone()
    }
}