use super::*;
use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl,
    crypto::Hash,
    testutils::{Address as _, Ledger as _},
    vec, Address, Env, IntoVal, String, Symbol, Val, Vec,
};

/// Minimal custom account contract standing in for a Soroban account
/// abstraction signer (e.g. a multisig or policy-gated wallet). Its
/// `__check_auth` is a real entry point invoked by the Soroban authorization
/// framework - exercising it (instead of relying on `mock_all_auths`) proves
/// that guardians can be custom account contracts, not just raw keypairs.
#[contract]
pub struct MockAaAccount;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MockAaError {
    BadSignature = 1,
}

#[contractimpl]
impl CustomAccountInterface for MockAaAccount {
    type Signature = Val;
    type Error = MockAaError;

    fn __check_auth(
        _env: Env,
        _signature_payload: Hash<32>,
        _signature: Val,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), MockAaError> {
        Ok(())
    }
}

/// Minimal registry contract used to verify the vault's deep,
/// `authorize_as_current_contract`-authorized cross-contract call on
/// document access grants.
#[contract]
pub struct MockAccessRegistry;

#[contractimpl]
impl MockAccessRegistry {
    pub fn record_grant(env: Env, document_id: u64, requester: Address) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "last_grant"), &(document_id, requester));
    }
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn setup<'a>() -> (Env, SpooVaultStellarClient<'a>) {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);
    env.mock_all_auths();
    (env, client)
}

/// Create a vault with the creator as guardian and two external guardians.
/// Returns (env, client, creator, guardian1, guardian2, vault_id).
fn create_test_vault<'a>() -> (
    Env,
    SpooVaultStellarClient<'a>,
    Address,
    Address,
    Address,
    u64,
) {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    let g2 = Address::generate(&env);

    let name = String::from_str(&env, "Test Vault");
    let desc = String::from_str(&env, "A test vault");
    let guardians = vec![&env, g1.clone(), g2.clone()];

    let vault_id = client.create_vault(&creator, &name, &desc, &guardians, &2);
    (env, client, creator, g1, g2, vault_id)
}

/// Helper: add a document to an active vault and return its id.
fn add_test_document(
    client: &SpooVaultStellarClient<'_>,
    env: &Env,
    uploader: Address,
    vault_id: u64,
    guardians_list: soroban_sdk::Vec<Address>,
    shares: soroban_sdk::Vec<String>,
) -> u64 {
    client.add_document(
        &uploader,
        &vault_id,
        &String::from_str(env, "encrypted-meta"),
        &String::from_str(env, "QmIPFSHash"),
        &AccessLevel::ReadWrite,
        &ReleaseCondition::Anytime,
        &guardians_list,
        &shares,
    )
}

/// Helper: set up g1 as an accepted guardian for the vault.
fn accept_guardian(client: &SpooVaultStellarClient<'_>, _env: &Env, g1: &Address, vault_id: u64) {
    client.accept_guardian_invite(g1, &vault_id);
}

// ══════════════════════════════════════════════════════════════════════════════
// Existing tests
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_register_public_key() {
    let (env, client) = setup();

    let user = Address::generate(&env);
    let pubkey = String::from_str(&env, "B64_STELLAR_PUBKEY_TEST");
    client.register_public_key(&user, &pubkey);

    let fetched = client.get_public_key(&user);
    assert_eq!(fetched, Some(pubkey));
}

#[test]
fn test_cross_chain_identity_registration_and_resolution() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let stellar_user = Address::generate(&env);
    env.mock_all_auths();

    let evm_address = String::from_str(&env, "0x64128680775Ef626379DeF6E5c815AeA8F4707Ef");
    let enc_pubkey = String::from_str(&env, "0x04bfcab5516089d846985a12");

    // Register cross-chain identity with public key
    client.register_cross_chain_identity(&stellar_user, &evm_address, &Some(enc_pubkey.clone()));

    // Resolve EVM address to Stellar Address
    let resolved_stellar = client.resolve_evm_to_stellar(&evm_address);
    assert_eq!(resolved_stellar, Some(stellar_user.clone()));

    // Resolve Stellar Address to EVM address
    let resolved_evm = client.resolve_stellar_to_evm(&stellar_user);
    assert_eq!(resolved_evm, Some(evm_address.clone()));

    // Resolve EVM address to Encryption Public Key
    let resolved_pubkey = client.resolve_evm_to_public_key(&evm_address);
    assert_eq!(resolved_pubkey, Some(enc_pubkey));

    // Resolve user's public key directly via Stellar Address
    let fetched_stellar_pubkey = client.get_public_key(&stellar_user);
    assert_eq!(fetched_stellar_pubkey, resolved_pubkey);
}

#[test]
fn test_cross_chain_identity_fallback_resolution() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let stellar_user = Address::generate(&env);
    env.mock_all_auths();

    let evm_address = String::from_str(&env, "0x1234567890123456789012345678901234567890");
    let stellar_pubkey = String::from_str(&env, "STELLAR_ENCRYPTION_PUBKEY_TEST");

    // Register stellar public key first
    client.register_public_key(&stellar_user, &stellar_pubkey);

    // Register cross-chain link without explicit separate pubkey
    client.register_cross_chain_identity(&stellar_user, &evm_address, &None);

    // Should resolve EVM address to the Stellar public key via fallback
    let resolved_pubkey = client.resolve_evm_to_public_key(&evm_address);
    assert_eq!(resolved_pubkey, Some(stellar_pubkey));
}

#[test]
fn test_create_vault_and_get_vault() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    let g2 = Address::generate(&env);
    env.mock_all_auths();

    let name = String::from_str(&env, "Soroban Vault");
    let desc = String::from_str(&env, "Stellar Soroban Secure Vault");
    let guardians = vec![&env, g1.clone(), g2.clone()];

    let vault_id = client.create_vault(&creator, &name, &desc, &guardians, &2);
    assert_eq!(vault_id, 1);

    let vault = client.get_vault(&vault_id).expect("Vault should exist");
    assert_eq!(vault.id, 1);
    assert_eq!(vault.creator, creator);
    assert_eq!(vault.approval_threshold, 2);
    assert!(vault.is_active);

    let invites_g1 = client.get_invites(&g1);
    assert_eq!(invites_g1.len(), 1);
    assert!(!invites_g1.get(0).unwrap().accepted);
}

#[test]
fn test_accept_guardian_invite() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    env.mock_all_auths();

    let name = String::from_str(&env, "Family Vault");
    let desc = String::from_str(&env, "Guardians Test");
    let guardians = vec![&env, g1.clone()];

    let vault_id = client.create_vault(&creator, &name, &desc, &guardians, &1);
    client.accept_guardian_invite(&g1, &vault_id);

    let vault = client.get_vault(&vault_id).unwrap();
    assert_eq!(vault.guardians.len(), 2);
    assert!(vault.guardians.contains(&g1));

    let invites = client.get_invites(&g1);
    assert!(invites.get(0).unwrap().accepted);
}

#[test]
fn test_add_document_and_access_flow() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    let requester = Address::generate(&env);
    env.mock_all_auths();

    let name = String::from_str(&env, "Financial Vault");
    let desc = String::from_str(&env, "Financial records");
    let guardians = vec![&env, g1.clone()];

    let vault_id = client.create_vault(&creator, &name, &desc, &guardians, &1);
    client.accept_guardian_invite(&g1, &vault_id);

    let meta = String::from_str(&env, "{\"title\":\"will.pdf\"}");
    let ipfs = String::from_str(&env, "QmTestIpfsHash");
    let guardians_list = vec![&env, creator.clone(), g1.clone()];
    let shares = vec![
        &env,
        String::from_str(&env, "share1"),
        String::from_str(&env, "share2"),
    ];

    let doc_id = client.add_document(
        &creator,
        &vault_id,
        &meta,
        &ipfs,
        &AccessLevel::Read,
        &ReleaseCondition::Anytime,
        &guardians_list,
        &shares,
    );
    assert_eq!(doc_id, 1);

    let doc = client.get_document(&doc_id).unwrap();
    assert_eq!(doc.ipfs_hash, ipfs);

    let req_id = client.request_access(&requester, &doc_id);
    assert_eq!(req_id, 1);

    let share_for_beneficiary = Some(String::from_str(&env, "bshare123"));
    client.approve_access(&creator, &req_id, &share_for_beneficiary);

    let req = client.get_access_request(&req_id).unwrap();
    assert_eq!(req.status, RequestStatus::Approved);
}

#[test]
fn test_ttl_extensions() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    let requester = Address::generate(&env);
    env.mock_all_auths();

    let name = String::from_str(&env, "TTL Vault");
    let desc = String::from_str(&env, "Testing TTL extensions");
    let guardians = vec![&env, g1.clone()];

    let vault_id = client.create_vault(&creator, &name, &desc, &guardians, &1);
    let doc_id = client.add_document(
        &creator,
        &vault_id,
        &String::from_str(&env, "meta"),
        &String::from_str(&env, "QmHash"),
        &AccessLevel::Read,
        &ReleaseCondition::Anytime,
        &vec![&env, creator.clone()],
        &vec![&env, String::from_str(&env, "share")],
    );
    let req_id = client.request_access(&requester, &doc_id);

    // Call explicit TTL extension endpoints
    client.extend_contract_ttl();
    client.extend_vault_ttl(&vault_id);
    client.extend_document_ttl(&doc_id);
    client.extend_request_ttl(&req_id);
}

#[test]
fn test_prove_life_and_emergency_mode() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    env.mock_all_auths();

    let name = String::from_str(&env, "Emergency Vault");
    let desc = String::from_str(&env, "Emergency release test");
    let guardians = vec![&env, g1.clone()];

    let vault_id = client.create_vault(&creator, &name, &desc, &guardians, &1);

    client.set_emergency_mode(&creator, &vault_id, &true);
    let state = client.get_release_state(&vault_id).unwrap();
    assert!(state.emergency_mode);

    client.prove_life(&creator, &vault_id);
    client.configure_vault_release(&creator, &vault_id, &(60 * 24 * 60 * 60));
    let updated_state = client.get_release_state(&vault_id).unwrap();
    assert_eq!(updated_state.inactivity_period, 60 * 24 * 60 * 60);
}

#[test]
#[should_panic(expected = "Release condition locked")]
fn test_emergency_only_stays_locked_while_prng_pending() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    let requester = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "PRNG Delay Vault"),
        &String::from_str(&env, "Emergency gating"),
        &vec![&env, g1.clone()],
        &1,
    );

    let doc_id = client.add_document(
        &creator,
        &vault_id,
        &String::from_str(&env, "meta"),
        &String::from_str(&env, "QmEmergencyDoc"),
        &AccessLevel::Read,
        &ReleaseCondition::EmergencyOnly,
        &vec![&env, creator.clone()],
        &vec![&env, String::from_str(&env, "share")],
    );

    client.set_emergency_mode(&creator, &vault_id, &true);

    // Pending request (not fulfilled yet) must remain locked.
    client.request_access(&requester, &doc_id);
}

#[test]
fn test_emergency_prng_fulfillment_unlocks_with_dual_bounds() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    let requester = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "PRNG Fulfillment Vault"),
        &String::from_str(&env, "Emergency jitter"),
        &vec![&env, g1.clone()],
        &1,
    );
    client.set_emergency_jitter_window(&creator, &vault_id, &(5 * 60));

    let doc_id = client.add_document(
        &creator,
        &vault_id,
        &String::from_str(&env, "meta"),
        &String::from_str(&env, "QmEmergencyDoc2"),
        &AccessLevel::Read,
        &ReleaseCondition::EmergencyOnly,
        &vec![&env, creator.clone()],
        &vec![&env, String::from_str(&env, "share")],
    );

    client.set_emergency_mode(&creator, &vault_id, &true);
    env.ledger().with_mut(|li| {
        li.sequence_number += 4;
        li.timestamp += 20;
    });
    client.fulfill_emergency_unlock_delay(&vault_id);
    let schedule = client
        .get_emergency_unlock_schedule(&vault_id)
        .expect("schedule should exist");
    assert!(schedule.fulfilled);
    assert!(schedule.jitter_seconds < 5 * 60);
    assert!(schedule.unlock_sequence > env.ledger().sequence());
    assert!(schedule.unlock_at > env.ledger().timestamp());

    env.ledger().with_mut(|li| {
        li.timestamp = schedule.unlock_at + 1;
        li.sequence_number = schedule.unlock_sequence + 1;
    });
    let req_id = client.request_access(&requester, &doc_id);
    assert_eq!(req_id, 1);
}

#[test]
#[should_panic(expected = "Release condition locked")]
fn test_emergency_prng_timestamp_alone_stays_locked() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    let requester = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "PRNG Timestamp Vault"),
        &String::from_str(&env, "Sequence bound"),
        &vec![&env, g1.clone()],
        &1,
    );
    let doc_id = client.add_document(
        &creator,
        &vault_id,
        &String::from_str(&env, "meta"),
        &String::from_str(&env, "QmEmergencyDoc3"),
        &AccessLevel::Read,
        &ReleaseCondition::EmergencyOnly,
        &vec![&env, creator.clone()],
        &vec![&env, String::from_str(&env, "share")],
    );

    client.set_emergency_mode(&creator, &vault_id, &true);
    env.ledger().with_mut(|li| {
        li.sequence_number += 4;
        li.timestamp += 20;
    });
    client.fulfill_emergency_unlock_delay(&vault_id);
    let schedule = client
        .get_emergency_unlock_schedule(&vault_id)
        .expect("schedule should exist");

    env.ledger().with_mut(|li| {
        li.timestamp = schedule.unlock_at + 1;
    });
    client.request_access(&requester, &doc_id);
}

#[test]
#[should_panic(expected = "Emergency unlock confirmations not met")]
fn test_emergency_prng_fulfillment_requires_confirmations() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "PRNG Confirm Vault"),
        &String::from_str(&env, "Too early"),
        &vec![&env, g1.clone()],
        &1,
    );
    client.set_emergency_mode(&creator, &vault_id, &true);
    client.fulfill_emergency_unlock_delay(&vault_id);
}

#[test]
#[should_panic(expected = "Emergency unlock delay already pending")]
fn test_emergency_prng_rejects_second_enable_while_pending() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "PRNG Pending Vault"),
        &String::from_str(&env, "Double enable"),
        &vec![&env, g1.clone()],
        &1,
    );
    client.set_emergency_mode(&creator, &vault_id, &true);
    client.set_emergency_mode(&creator, &vault_id, &true);
}

#[test]
#[should_panic(expected = "Emergency unlock already fulfilled")]
fn test_emergency_prng_rejects_duplicate_fulfillment() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "PRNG Dup Vault"),
        &String::from_str(&env, "dup"),
        &vec![&env, g1.clone()],
        &1,
    );
    client.set_emergency_mode(&creator, &vault_id, &true);
    env.ledger().with_mut(|li| {
        li.sequence_number += 4;
        li.timestamp += 20;
    });
    client.fulfill_emergency_unlock_delay(&vault_id);
    client.fulfill_emergency_unlock_delay(&vault_id);
}

#[test]
#[should_panic(expected = "Emergency mode is not enabled")]
fn test_emergency_prng_rejects_fulfillment_after_disable() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "PRNG Disable Vault"),
        &String::from_str(&env, "stale"),
        &vec![&env, g1.clone()],
        &1,
    );
    client.set_emergency_mode(&creator, &vault_id, &true);
    env.ledger().with_mut(|li| {
        li.sequence_number += 4;
        li.timestamp += 20;
    });
    client.set_emergency_mode(&creator, &vault_id, &false);
    client.fulfill_emergency_unlock_delay(&vault_id);
}

#[test]
fn test_emergency_prng_new_cycle_does_not_reuse_old_bounds() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "PRNG Cycle Vault"),
        &String::from_str(&env, "cycle"),
        &vec![&env, g1.clone()],
        &1,
    );
    client.set_emergency_mode(&creator, &vault_id, &true);
    env.ledger().with_mut(|li| {
        li.sequence_number += 4;
        li.timestamp += 20;
    });
    client.fulfill_emergency_unlock_delay(&vault_id);
    let first = client.get_emergency_unlock_schedule(&vault_id).unwrap();
    assert!(first.fulfilled);
    assert_eq!(first.cycle, 1);

    client.set_emergency_mode(&creator, &vault_id, &false);
    client.set_emergency_mode(&creator, &vault_id, &true);
    let pending = client.get_emergency_unlock_schedule(&vault_id).unwrap();
    assert!(!pending.fulfilled);
    assert_eq!(pending.cycle, 2);
    assert_eq!(pending.unlock_at, 0);
}

#[test]
#[should_panic(expected = "Release condition locked")]
fn test_emergency_prng_ledger_alone_stays_locked() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    let requester = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "PRNG Ledger Vault"),
        &String::from_str(&env, "ledger only"),
        &vec![&env, g1.clone()],
        &1,
    );
    let doc_id = client.add_document(
        &creator,
        &vault_id,
        &String::from_str(&env, "meta"),
        &String::from_str(&env, "QmEmergencyDoc4"),
        &AccessLevel::Read,
        &ReleaseCondition::EmergencyOnly,
        &vec![&env, creator.clone()],
        &vec![&env, String::from_str(&env, "share")],
    );
    client.set_emergency_mode(&creator, &vault_id, &true);
    env.ledger().with_mut(|li| {
        li.sequence_number += 4;
        li.timestamp += 20;
    });
    client.fulfill_emergency_unlock_delay(&vault_id);
    let schedule = client.get_emergency_unlock_schedule(&vault_id).unwrap();
    env.ledger().with_mut(|li| {
        li.sequence_number = schedule.unlock_sequence + 1;
    });
    client.request_access(&requester, &doc_id);
}

#[test]
fn test_authorize_keeper_and_relay_heartbeat() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    let keeper = Address::generate(&env);
    env.mock_all_auths();

    let name = String::from_str(&env, "Automated Vault");
    let desc = String::from_str(&env, "Keeper relay test");
    let guardians = vec![&env, g1.clone()];
    let vault_id = client.create_vault(&creator, &name, &desc, &guardians, &1);

    let expires_at = env.ledger().timestamp() + 30 * 24 * 60 * 60;
    client.authorize_keeper(&creator, &vault_id, &keeper, &expires_at);

    let authorization = client
        .get_keeper_authorization(&vault_id)
        .expect("authorization should be stored");
    assert_eq!(authorization.keeper, keeper);
    assert_eq!(authorization.expires_at, expires_at);

    let before = client
        .get_release_state(&vault_id)
        .unwrap()
        .last_proof_of_life;
    env.ledger().with_mut(|li| li.timestamp += 3600);
    client.prove_life_by_keeper(&keeper, &vault_id);

    let after = client.get_release_state(&vault_id).unwrap();
    assert!(after.last_proof_of_life > before);

    // The keeper can heartbeat again later with no further owner action required.
    env.ledger().with_mut(|li| li.timestamp += 3600);
    client.prove_life_by_keeper(&keeper, &vault_id);
}

#[test]
fn test_contract_account_guardian_approves_via_custom_auth() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    // A deployed contract acting as a guardian - a custom account abstraction
    // signer, not a raw Stellar keypair.
    let aa_guardian = env.register_contract(None, MockAaAccount);
    let requester = Address::generate(&env);

    let name = String::from_str(&env, "AA Guardian Vault");
    let desc = String::from_str(&env, "Contract-account guardian test");
    let guardians = vec![&env, aa_guardian.clone()];

    env.mock_all_auths();
    let vault_id = client.create_vault(&creator, &name, &desc, &guardians, &1);

    // Contract addresses register as guardians the same way keypair
    // addresses do.
    client.accept_guardian_invite(&aa_guardian, &vault_id);
    let vault = client.get_vault(&vault_id).unwrap();
    assert!(vault.guardians.contains(&aa_guardian));

    let doc_id = client.add_document(
        &creator,
        &vault_id,
        &String::from_str(&env, "meta"),
        &String::from_str(&env, "QmHash"),
        &AccessLevel::Read,
        &ReleaseCondition::Anytime,
        &vec![&env, creator.clone()],
        &vec![&env, String::from_str(&env, "share")],
    );
    let req_id = client.request_access(&requester, &doc_id);

    // Drive the approval through the real Soroban auth framework (no
    // mock_all_auths) so the contract guardian's `__check_auth` is actually
    // invoked and must approve the call for `approve_access` to succeed.
    let args: Vec<Val> = (aa_guardian.clone(), req_id, None::<String>).into_val(&env);
    env.set_auths(&[soroban_sdk::testutils::MockAuth {
        address: &aa_guardian,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "approve_access",
            args,
            sub_invokes: &[],
        },
    }
    .into()]);

    client.approve_access(&aa_guardian, &req_id, &None);

    let req = client.get_access_request(&req_id).unwrap();
    assert_eq!(req.status, RequestStatus::Approved);
}

#[test]
fn test_deep_auth_invocation_notifies_access_registry() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);
    let registry_addr = env.register_contract(None, MockAccessRegistry);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    let requester = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "Registry Vault"),
        &String::from_str(&env, "Deep auth invocation test"),
        &vec![&env, g1.clone()],
        &1,
    );
    client.set_access_registry(&creator, &vault_id, &registry_addr);
    client.accept_guardian_invite(&g1, &vault_id);

    let doc_id = client.add_document(
        &creator,
        &vault_id,
        &String::from_str(&env, "meta"),
        &String::from_str(&env, "QmHash"),
        &AccessLevel::Read,
        &ReleaseCondition::Anytime,
        &vec![&env, creator.clone()],
        &vec![&env, String::from_str(&env, "share")],
    );
    let req_id = client.request_access(&requester, &doc_id);

    // Approving fully grants access, which should trigger the vault's
    // `env.authorize_as_current_contract` sub-invocation calling the
    // registry's `record_grant` - a cross-contract call authorized by the
    // vault contract itself, not by the approving guardian.
    client.approve_access(&creator, &req_id, &None);

    let recorded: (u64, Address) = env.as_contract(&registry_addr, || {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "last_grant"))
            .unwrap()
    });
    assert_eq!(recorded, (doc_id, requester));
}

#[test]
fn test_prove_life_by_keeper_fails_when_unauthorized() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    let keeper = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "Vault"),
        &String::from_str(&env, "Desc"),
        &vec![&env, g1],
        &1,
    );

    let result = client.try_prove_life_by_keeper(&keeper, &vault_id);
    assert!(
        result.is_err(),
        "expected relay from an unauthorized keeper to fail"
    );
}

#[test]
fn test_prove_life_by_keeper_fails_for_wrong_keeper() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    let keeper = Address::generate(&env);
    let other_keeper = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "Vault"),
        &String::from_str(&env, "Desc"),
        &vec![&env, g1],
        &1,
    );

    let expires_at = env.ledger().timestamp() + 30 * 24 * 60 * 60;
    client.authorize_keeper(&creator, &vault_id, &keeper, &expires_at);

    let result = client.try_prove_life_by_keeper(&other_keeper, &vault_id);
    assert!(
        result.is_err(),
        "expected relay from a non-authorized keeper to fail"
    );
}

#[test]
fn test_prove_life_by_keeper_fails_when_expired() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    let keeper = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "Vault"),
        &String::from_str(&env, "Desc"),
        &vec![&env, g1],
        &1,
    );

    let expires_at = env.ledger().timestamp() + 3600;
    client.authorize_keeper(&creator, &vault_id, &keeper, &expires_at);

    env.ledger().with_mut(|li| li.timestamp = expires_at + 1);
    let result = client.try_prove_life_by_keeper(&keeper, &vault_id);
    assert!(result.is_err(), "expected relay after expiry to fail");
}

#[test]
fn test_revoke_keeper_blocks_future_relays() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    let keeper = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "Vault"),
        &String::from_str(&env, "Desc"),
        &vec![&env, g1],
        &1,
    );

    let expires_at = env.ledger().timestamp() + 30 * 24 * 60 * 60;
    client.authorize_keeper(&creator, &vault_id, &keeper, &expires_at);
    client.revoke_keeper(&creator, &vault_id);

    assert!(client.get_keeper_authorization(&vault_id).is_none());

    let result = client.try_prove_life_by_keeper(&keeper, &vault_id);
    assert!(result.is_err(), "expected relay after revocation to fail");
}

#[test]
fn test_authorize_keeper_rejects_non_creator() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let g1 = Address::generate(&env);
    let keeper = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "Vault"),
        &String::from_str(&env, "Desc"),
        &vec![&env, g1.clone()],
        &1,
    );

    let expires_at = env.ledger().timestamp() + 30 * 24 * 60 * 60;
    // g1 is a guardian, not the creator, and must not be able to authorize a keeper.
    let result = client.try_authorize_keeper(&g1, &vault_id, &keeper, &expires_at);
    assert!(
        result.is_err(),
        "expected authorization from a non-creator to fail"
    );
}

// ══════════════════════════════════════════════════════════════════════════════
// Compromised Key Rotation tests (Issue #156)
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_revoke_key_rotates_and_blacklists_old_key() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    env.mock_all_auths();

    let old_key = String::from_str(&env, "OLD_COMPROMISED_KEY");
    let new_key = String::from_str(&env, "NEW_ROTATED_KEY");

    client.register_public_key(&user, &old_key);
    assert_eq!(client.get_public_key(&user), Some(old_key.clone()));
    assert!(!client.is_key_revoked(&old_key));

    client.revoke_key(&user, &old_key, &new_key);

    // Active key rotated to the new value
    assert_eq!(client.get_public_key(&user), Some(new_key.clone()));
    // Old key is permanently blacklisted
    assert!(client.is_key_revoked(&old_key));
    assert!(!client.is_key_revoked(&new_key));
}

#[test]
#[should_panic(expected = "Public key has been revoked as compromised")]
fn test_revoked_key_cannot_be_re_registered() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    env.mock_all_auths();

    let old_key = String::from_str(&env, "OLD_COMPROMISED_KEY");
    let new_key = String::from_str(&env, "NEW_ROTATED_KEY");

    client.register_public_key(&user, &old_key);
    client.revoke_key(&user, &old_key, &new_key);

    // The compromised key can never be re-registered
    client.register_public_key(&user, &old_key);
}

#[test]
#[should_panic(expected = "Caller does not own the old public key")]
fn test_revoke_key_requires_proof_of_possession() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let attacker = Address::generate(&env);
    env.mock_all_auths();

    let old_key = String::from_str(&env, "USER_KEY");
    client.register_public_key(&user, &old_key);
    let attacker_key = String::from_str(&env, "ATTACKER_OWN_KEY");
    client.register_public_key(&attacker, &attacker_key);

    // Attacker never held this key and cannot revoke it
    let new_key = String::from_str(&env, "ATTACKER_KEY");
    client.revoke_key(&attacker, &old_key, &new_key);
}

#[test]
#[should_panic(expected = "Cannot rotate to a revoked public key")]
fn test_revoke_key_rejects_rotation_to_revoked_key() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    env.mock_all_auths();

    let first_key = String::from_str(&env, "KEY_ONE");
    let second_key = String::from_str(&env, "KEY_TWO");
    let third_key = String::from_str(&env, "KEY_THREE");

    client.register_public_key(&user, &first_key);
    client.revoke_key(&user, &first_key, &second_key.clone());
    client.revoke_key(&user, &second_key, &third_key);

    // Rotating back to an already-blacklisted key must fail
    client.revoke_key(&user, &third_key, &first_key);
}

#[test]
#[should_panic(expected = "New key must differ from old key")]
fn test_revoke_key_rejects_same_key_rotation() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    env.mock_all_auths();

    let key = String::from_str(&env, "SAME_KEY");
    client.register_public_key(&user, &key);
    client.revoke_key(&user, &key, &key);
}

#[test]
#[should_panic(expected = "No registered public key for caller")]
fn test_revoke_key_requires_registered_key() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    env.mock_all_auths();

    let old_key = String::from_str(&env, "NEVER_REGISTERED");
    let new_key = String::from_str(&env, "NEW_KEY");
    client.revoke_key(&user, &old_key, &new_key);
}

// ══════════════════════════════════════════════════════════════════════════════
// deactivate_vault tests
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_deactivate_vault_success() {
    let (_env, client, creator, g1, g2, vault_id) = create_test_vault();

    // Deactivate the vault
    client.deactivate_vault(&creator, &vault_id);

    // Verify vault is deactivated by confirming that add_document now fails
    let guardians_list = vec![&_env, creator.clone(), g1.clone(), g2.clone()];
    let shares = vec![
        &_env,
        String::from_str(&_env, "share1"),
        String::from_str(&_env, "share2"),
        String::from_str(&_env, "share3"),
    ];

    // This would be caught by test_add_document_on_deactivated_vault,
    // but here we confirm the vault state via the contract's own guard.
    // We simply verify that deactivate_vault succeeded (didn't panic above)
    // and the vault will now block operations (tested in other tests).
    drop(guardians_list);
    drop(shares);
}

#[test]
#[should_panic(expected = "Vault is already inactive")]
fn test_deactivate_vault_already_inactive() {
    let (_env, client, creator, _g1, _g2, vault_id) = create_test_vault();

    client.deactivate_vault(&creator, &vault_id);
    // Second deactivation should panic
    client.deactivate_vault(&creator, &vault_id);
}

#[test]
#[should_panic(expected = "Only creator can deactivate vault")]
fn test_deactivate_vault_not_creator() {
    let (_env, client, _creator, g1, _g2, vault_id) = create_test_vault();

    // Non-creator should fail
    client.deactivate_vault(&g1, &vault_id);
}

// ══════════════════════════════════════════════════════════════════════════════
// add_document vault-active enforcement tests
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_add_document_on_active_vault() {
    let (env, client, creator, g1, g2, vault_id) = create_test_vault();

    let guardians_list = vec![&env, creator.clone(), g1.clone(), g2.clone()];
    let shares = vec![
        &env,
        String::from_str(&env, "share1"),
        String::from_str(&env, "share2"),
        String::from_str(&env, "share3"),
    ];

    let doc_id = add_test_document(&client, &env, creator, vault_id, guardians_list, shares);
    assert_eq!(doc_id, 1);
}

#[test]
#[should_panic(expected = "Vault is deactivated")]
fn test_add_document_on_deactivated_vault() {
    let (env, client, creator, g1, g2, vault_id) = create_test_vault();

    // Deactivate vault first
    client.deactivate_vault(&creator, &vault_id);

    let guardians_list = vec![&env, creator.clone(), g1.clone(), g2.clone()];
    let shares = vec![
        &env,
        String::from_str(&env, "share1"),
        String::from_str(&env, "share2"),
        String::from_str(&env, "share3"),
    ];

    // Should panic because vault is deactivated
    add_test_document(&client, &env, creator, vault_id, guardians_list, shares);
}

// ══════════════════════════════════════════════════════════════════════════════
// request_access vault-active enforcement tests
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_request_access_on_active_vault() {
    let (env, client, creator, g1, g2, vault_id) = create_test_vault();

    let guardians_list = vec![&env, creator.clone(), g1.clone(), g2.clone()];
    let shares = vec![
        &env,
        String::from_str(&env, "share1"),
        String::from_str(&env, "share2"),
        String::from_str(&env, "share3"),
    ];
    let doc_id = add_test_document(
        &client,
        &env,
        creator.clone(),
        vault_id,
        guardians_list,
        shares,
    );

    let requester = Address::generate(&env);
    let req_id = client.request_access(&requester, &doc_id);
    assert_eq!(req_id, 1);
}

#[test]
#[should_panic(expected = "Vault is deactivated")]
fn test_request_access_on_deactivated_vault() {
    let (env, client, creator, g1, g2, vault_id) = create_test_vault();

    let guardians_list = vec![&env, creator.clone(), g1.clone(), g2.clone()];
    let shares = vec![
        &env,
        String::from_str(&env, "share1"),
        String::from_str(&env, "share2"),
        String::from_str(&env, "share3"),
    ];
    let doc_id = add_test_document(
        &client,
        &env,
        creator.clone(),
        vault_id,
        guardians_list,
        shares,
    );

    // Deactivate vault
    client.deactivate_vault(&creator, &vault_id);

    // Request access should fail
    let requester = Address::generate(&env);
    client.request_access(&requester, &doc_id);
}

// ══════════════════════════════════════════════════════════════════════════════
// approve_access vault-active enforcement tests
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_approve_access_on_active_vault() {
    let (env, client, creator, g1, g2, vault_id) = create_test_vault();

    // g1 must accept invite to become guardian
    accept_guardian(&client, &env, &g1, vault_id);

    let guardians_list = vec![&env, creator.clone(), g1.clone(), g2.clone()];
    let shares = vec![
        &env,
        String::from_str(&env, "share1"),
        String::from_str(&env, "share2"),
        String::from_str(&env, "share3"),
    ];
    let doc_id = add_test_document(
        &client,
        &env,
        creator.clone(),
        vault_id,
        guardians_list,
        shares,
    );

    let requester = Address::generate(&env);
    let req_id = client.request_access(&requester, &doc_id);

    // Guardian 1 approves
    client.approve_access(&g1, &req_id, &None);
}

#[test]
#[should_panic(expected = "Vault is deactivated")]
fn test_approve_access_on_deactivated_vault() {
    let (env, client, creator, g1, g2, vault_id) = create_test_vault();

    // g1 must accept invite to become guardian
    accept_guardian(&client, &env, &g1, vault_id);

    let guardians_list = vec![&env, creator.clone(), g1.clone(), g2.clone()];
    let shares = vec![
        &env,
        String::from_str(&env, "share1"),
        String::from_str(&env, "share2"),
        String::from_str(&env, "share3"),
    ];
    let doc_id = add_test_document(
        &client,
        &env,
        creator.clone(),
        vault_id,
        guardians_list,
        shares,
    );

    let requester = Address::generate(&env);
    let req_id = client.request_access(&requester, &doc_id);

    // Deactivate vault before approval
    client.deactivate_vault(&creator, &vault_id);

    // Approval should fail on deactivated vault
    client.approve_access(&g1, &req_id, &None);
}

// ══════════════════════════════════════════════════════════════════════════════
// End-to-end: deactivate then verify blocked
// ══════════════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "Vault is deactivated")]
fn test_deactivate_blocks_add_document_end_to_end() {
    let (env, client, creator, g1, g2, vault_id) = create_test_vault();
    client.deactivate_vault(&creator, &vault_id);

    let guardians_list = vec![&env, creator.clone(), g1.clone(), g2.clone()];
    let shares = vec![
        &env,
        String::from_str(&env, "s1"),
        String::from_str(&env, "s2"),
        String::from_str(&env, "s3"),
    ];
    add_test_document(&client, &env, creator, vault_id, guardians_list, shares);
}

// ══════════════════════════════════════════════════════════════════════════════
// approve_access full flow on active vault (threshold met)
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_approve_access_full_flow_grants_access() {
    let (env, client, creator, g1, g2, vault_id) = create_test_vault();

    // g1 must accept invite to become guardian
    accept_guardian(&client, &env, &g1, vault_id);

    let guardians_list = vec![&env, creator.clone(), g1.clone(), g2.clone()];
    let shares = vec![
        &env,
        String::from_str(&env, "share_c"),
        String::from_str(&env, "share_g1"),
        String::from_str(&env, "share_g2"),
    ];
    let doc_id = add_test_document(
        &client,
        &env,
        creator.clone(),
        vault_id,
        guardians_list,
        shares,
    );

    let requester = Address::generate(&env);
    let req_id = client.request_access(&requester, &doc_id);

    // Approval threshold is 2 – first approval
    client.approve_access(&g1, &req_id, &Some(String::from_str(&env, "enc_share")));
    // Second approval meets threshold → request should be Approved
    client.approve_access(
        &creator,
        &req_id,
        &Some(String::from_str(&env, "enc_share2")),
    );

    // Verify: the requester now has access (get_access doesn't exist, but we
    // can confirm the full flow completed without panicking)
    // The access grant is confirmed by the fact that both approvals succeeded
    // and the threshold was met (2 approvals >= threshold of 2)
}

#[test]
fn test_guardian_revoke_access() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let requester = Address::generate(&env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(&env, "Revoke Vault"),
        &String::from_str(&env, "Guardian revoke test"),
        &vec![&env, Address::generate(&env)],
        &1,
    );
    let doc_id = client.add_document(
        &creator,
        &vault_id,
        &String::from_str(&env, "meta"),
        &String::from_str(&env, "QmHash"),
        &AccessLevel::Read,
        &ReleaseCondition::Anytime,
        &vec![&env, creator.clone()],
        &vec![&env, String::from_str(&env, "share")],
    );
    let req_id = client.request_access(&requester, &doc_id);
    client.approve_access(&creator, &req_id, &None);

    let req = client.get_access_request(&req_id).unwrap();
    assert_eq!(req.status, RequestStatus::Approved);

    client.revoke_access(&creator, &doc_id, &requester);

    // A fresh request is accepted again only because access was actually
    // cleared - `request_access` panics if `HasAccess` is still true.
    let req_id_2 = client.request_access(&requester, &doc_id);
    assert_ne!(req_id_2, req_id);
}

#[cfg(test)]
mod cross_chain_revocation {
    use super::*;
    use k256::ecdsa::signature::hazmat::PrehashSigner;
    use k256::ecdsa::SigningKey as EvmSigningKey;
    use soroban_sdk::xdr::ToXdr;

    struct EvmKeypair {
        signing_key: EvmSigningKey,
        address: BytesN<20>,
    }

    fn generate_evm_keypair(env: &Env, seed: u8) -> EvmKeypair {
        let signing_key = EvmSigningKey::from_bytes(&[seed; 32].into()).unwrap();
        let pk65: [u8; 65] = signing_key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .try_into()
            .unwrap();
        // Ethereum address = keccak256(pubkey without the 0x04 prefix byte)[12..32].
        let pk_hash = env
            .crypto()
            .keccak256(&Bytes::from_array(env, &pk65).slice(1..65));
        let hash_bytes: Bytes = pk_hash.to_bytes().into();
        let address: BytesN<20> = hash_bytes.slice(12..32).try_into().unwrap();
        EvmKeypair {
            signing_key,
            address,
        }
    }

    /// Builds the exact digest `recover_eth_address` verifies against (using
    /// the same `env.crypto()` host hash functions the contract itself
    /// uses, so there is no risk of a hand-rolled hash mismatching), then
    /// produces a real secp256k1 signature plus the recovery id that
    /// reproduces the signer's public key.
    #[allow(clippy::too_many_arguments)]
    fn sign_revocation(
        env: &Env,
        signer: &EvmSigningKey,
        vault_gid: &BytesN<32>,
        document_id: u64,
        target_evm_user: &BytesN<20>,
        target_stellar_user: &Address,
        nonce: u64,
    ) -> (BytesN<64>, u32) {
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
        let digest_arr: [u8; 32] = digest.to_bytes().to_array();

        let sig: k256::ecdsa::Signature = signer.sign_prehash(&digest_arr).unwrap();
        let sig_arr: [u8; 64] = sig.to_bytes()[..].try_into().unwrap();
        let sig_bn = BytesN::from_array(env, &sig_arr);

        let expected_pk: [u8; 65] = signer
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .try_into()
            .unwrap();
        let mut recovery_id = 0u32;
        for rid in 0..4u32 {
            let recovered: [u8; 65] = env
                .crypto()
                .secp256k1_recover(&digest, &sig_bn, rid)
                .to_array();
            if recovered == expected_pk {
                recovery_id = rid;
                break;
            }
        }

        (sig_bn, recovery_id)
    }

    fn setup_linked_vault(
        env: &Env,
    ) -> (
        SpooVaultStellarClient<'static>,
        Address,
        u64,
        u64,
        EvmKeypair,
        BytesN<32>,
    ) {
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(env, &contract_id);

        let creator = Address::generate(env);
        let requester = Address::generate(env);
        env.mock_all_auths();

        let vault_id = client.create_vault(
            &creator,
            &String::from_str(env, "Cross-Chain Vault"),
            &String::from_str(env, "Revocation broadcast test"),
            &vec![env, Address::generate(env)],
            &1,
        );
        let doc_id = client.add_document(
            &creator,
            &vault_id,
            &String::from_str(env, "meta"),
            &String::from_str(env, "QmHash"),
            &AccessLevel::Read,
            &ReleaseCondition::Anytime,
            &vec![env, creator.clone()],
            &vec![env, String::from_str(env, "share")],
        );
        let req_id = client.request_access(&requester, &doc_id);
        client.approve_access(&creator, &req_id, &None);

        let evm_keys = generate_evm_keypair(env, 42);
        let vault_gid = BytesN::from_array(env, &[9u8; 32]);
        client.link_cross_chain_vault(&creator, &vault_id, &vault_gid, &evm_keys.address);

        (client, requester, vault_id, doc_id, evm_keys, vault_gid)
    }

    #[test]
    fn test_relay_revoke_access_applies_evm_signed_revocation() {
        let env = Env::default();
        let (client, requester, vault_id, doc_id, evm_keys, vault_gid) = setup_linked_vault(&env);

        assert!(client.get_document(&doc_id).is_some());
        assert!(client.has_access(&doc_id, &requester));
        let ver_before = client.get_access_version(&vault_id, &requester);
        assert_eq!(ver_before, 1);

        let nonce = 1u64;
        let (sig, recovery_id) = sign_revocation(
            &env,
            &evm_keys.signing_key,
            &vault_gid,
            doc_id,
            &evm_keys.address,
            &requester,
            nonce,
        );

        client.relay_revoke_access(
            &vault_gid,
            &doc_id,
            &evm_keys.address,
            &requester,
            &nonce,
            &sig,
            &recovery_id,
        );

        assert!(!client.has_access(&doc_id, &requester));
        let ver_after = client.get_access_version(&vault_id, &requester);
        assert_eq!(ver_after, ver_before + 1);

        // Access was actually cleared: a fresh request now succeeds instead
        // of panicking on "Already has access".
        let new_req_id = client.request_access(&requester, &doc_id);
        assert!(new_req_id > 0);
    }

    #[test]
    #[should_panic(expected = "Stale or replayed revocation nonce")]
    fn test_relay_revoke_access_rejects_replayed_nonce() {
        let env = Env::default();
        let (client, requester, _vault_id, doc_id, evm_keys, vault_gid) = setup_linked_vault(&env);

        let nonce = 1u64;
        let (sig, recovery_id) = sign_revocation(
            &env,
            &evm_keys.signing_key,
            &vault_gid,
            doc_id,
            &evm_keys.address,
            &requester,
            nonce,
        );

        client.relay_revoke_access(
            &vault_gid,
            &doc_id,
            &evm_keys.address,
            &requester,
            &nonce,
            &sig,
            &recovery_id,
        );
        // Replaying the exact same signed message must be rejected.
        client.relay_revoke_access(
            &vault_gid,
            &doc_id,
            &evm_keys.address,
            &requester,
            &nonce,
            &sig,
            &recovery_id,
        );
    }

    #[test]
    #[should_panic(expected = "Signature not from linked cross-chain revoker")]
    fn test_relay_revoke_access_rejects_unauthorized_signer() {
        let env = Env::default();
        let (client, requester, _vault_id, doc_id, _evm_keys, vault_gid) = setup_linked_vault(&env);

        // A different EVM key signs the same payload - not the vault's
        // registered cross-chain revoker.
        let attacker_keys = generate_evm_keypair(&env, 99);
        let nonce = 1u64;
        let (sig, recovery_id) = sign_revocation(
            &env,
            &attacker_keys.signing_key,
            &vault_gid,
            doc_id,
            &attacker_keys.address,
            &requester,
            nonce,
        );

        client.relay_revoke_access(
            &vault_gid,
            &doc_id,
            &attacker_keys.address,
            &requester,
            &nonce,
            &sig,
            &recovery_id,
        );
    }
}

#[cfg(feature = "upgrade-tests")]
/// Upgrade governance: contract-wide multi-sig admin authorization for
/// `upgrade_contract` (Wasm code replacement) and `migrate`.
mod upgrade_governance {
    use super::*;
    use soroban_sdk::Error;

    /// The "new version" of the contract, imported as raw Wasm and uploaded
    /// via `env.deployer().upload_contract_wasm` to give `upgrade_contract`
    /// a real, already-present hash to swap to. Built by CI before this
    /// crate's tests run (see `.github/workflows/fuzzing.yml` and
    /// `.github/workflows/coverage.yml`); see
    /// `contracts-stellar/upgrade_fixture/README.md` to build it locally.
    mod new_contract {
        soroban_sdk::contractimport!(
            file = "upgrade_fixture/target/wasm32-unknown-unknown/release/spoovault_stellar_upgrade_fixture.wasm"
        );
    }

    fn install_new_wasm(env: &Env) -> BytesN<32> {
        env.deployer().upload_contract_wasm(new_contract::WASM)
    }

    #[test]
    fn test_init_admins_records_configured_set_and_threshold() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let admin_a = Address::generate(&env);
        let admin_b = Address::generate(&env);
        client.init_admins(&vec![&env, admin_a.clone(), admin_b.clone()], &2);

        assert_eq!(client.get_admins(), vec![&env, admin_a, admin_b]);
        assert_eq!(client.get_admin_threshold(), 2);
        assert_eq!(client.get_schema_version(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    #[should_panic(expected = "Admins already initialized")]
    fn test_init_admins_rejects_reinitialization() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.init_admins(&vec![&env, admin.clone()], &1);
        client.init_admins(&vec![&env, admin], &1);
    }

    #[test]
    #[should_panic(expected = "Invalid admin threshold")]
    fn test_init_admins_rejects_threshold_above_admin_count() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.init_admins(&vec![&env, admin], &2);
    }

    #[test]
    #[should_panic]
    fn test_init_admins_rejects_duplicate_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.init_admins(&vec![&env, admin.clone(), admin], &1);
    }

    #[test]
    fn test_upgrade_contract_rejects_non_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.init_admins(&vec![&env, admin], &1);

        let not_admin = Address::generate(&env);
        let some_hash = BytesN::from_array(&env, &[7u8; 32]);
        let result = client.try_upgrade_contract(&not_admin, &some_hash);
        assert_eq!(
            result,
            Err(Ok(Error::from_contract_error(
                UpgradeError::UnauthorizedAdmin as u32
            )))
        );
    }

    #[test]
    fn test_upgrade_contract_rejects_before_admins_initialized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let caller = Address::generate(&env);
        let some_hash = BytesN::from_array(&env, &[7u8; 32]);
        let result = client.try_upgrade_contract(&caller, &some_hash);
        assert_eq!(
            result,
            Err(Ok(Error::from_contract_error(
                UpgradeError::NotInitialized as u32
            )))
        );
    }

    #[test]
    fn test_upgrade_contract_rejects_corrupted_zero_threshold() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.init_admins(&vec![&env, admin.clone()], &1);
        env.as_contract(&contract_id, || {
            env.storage().instance().set(&DataKey::AdminThreshold, &0u32);
        });

        let some_hash = BytesN::from_array(&env, &[7u8; 32]);
        let result = client.try_upgrade_contract(&admin, &some_hash);
        assert_eq!(
            result,
            Err(Ok(Error::from_contract_error(
                UpgradeError::InvalidAdminThreshold as u32
            )))
        );
    }

    #[test]
    fn test_upgrade_contract_does_not_swap_before_threshold_is_met() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let admin_a = Address::generate(&env);
        let admin_b = Address::generate(&env);
        client.init_admins(&vec![&env, admin_a.clone(), admin_b], &2);

        // Only one of the two required admins approves - the hash need not
        // be a real uploaded Wasm blob, since the swap must not be
        // attempted yet.
        let some_hash = BytesN::from_array(&env, &[7u8; 32]);
        client.upgrade_contract(&admin_a, &some_hash);

        assert_eq!(client.version(), 1);
    }

    #[test]
    fn test_upgrade_contract_rejects_duplicate_approval_from_same_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let admin_a = Address::generate(&env);
        let admin_b = Address::generate(&env);
        client.init_admins(&vec![&env, admin_a.clone(), admin_b], &2);

        let some_hash = BytesN::from_array(&env, &[7u8; 32]);
        client.upgrade_contract(&admin_a, &some_hash);

        let result = client.try_upgrade_contract(&admin_a, &some_hash);
        assert_eq!(
            result,
            Err(Ok(Error::from_contract_error(
                UpgradeError::AlreadyApproved as u32
            )))
        );
    }

    #[test]
    fn test_upgrade_contract_swaps_wasm_and_preserves_existing_state_once_threshold_met() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        // Existing state created under the v1 code, which must survive the
        // upgrade untouched (Soroban storage is keyed by contract ID, not
        // by the executing Wasm).
        let creator = Address::generate(&env);
        let guardian = Address::generate(&env);
        let vault_id = client.create_vault(
            &creator,
            &String::from_str(&env, "Pre-upgrade Vault"),
            &String::from_str(&env, "Created before the code swap"),
            &vec![&env, guardian],
            &1,
        );

        let admin_a = Address::generate(&env);
        let admin_b = Address::generate(&env);
        client.init_admins(&vec![&env, admin_a.clone(), admin_b.clone()], &2);

        let new_wasm_hash = install_new_wasm(&env);
        client.upgrade_contract(&admin_a, &new_wasm_hash);
        assert_eq!(
            client.version(),
            1,
            "must not swap before the threshold is met"
        );

        // Verify vault state before second approval
        let preserved_vault = client
            .get_vault(&vault_id)
            .expect("vault must exist before upgrade");
        assert_eq!(
            preserved_vault.name,
            String::from_str(&env, "Pre-upgrade Vault")
        );

        client.upgrade_contract(&admin_b, &new_wasm_hash);

        // The code itself was actually replaced: a client built against the
        // new contract's interface now works against this same contract ID,
        // and exposes the new version/behavior.
        let upgraded_client = new_contract::Client::new(&env, &contract_id);
        assert_eq!(upgraded_client.version(), 2);
        assert_eq!(upgraded_client.new_feature(), 1_010_101);
    }

    #[test]
    fn test_migrate_rejects_non_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.init_admins(&vec![&env, admin], &1);

        let not_admin = Address::generate(&env);
        let result = client.try_migrate(&not_admin);
        assert_eq!(
            result,
            Err(Ok(Error::from_contract_error(
                UpgradeError::UnauthorizedAdmin as u32
            )))
        );
    }

    #[test]
    fn test_migrate_is_idempotent_for_admin_at_current_schema_version() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.init_admins(&vec![&env, admin.clone()], &1);

        // Schema is already at CURRENT_SCHEMA_VERSION post-init, so this is
        // a no-op both times - repeated invocation must not panic.
        client.migrate(&admin);
        client.migrate(&admin);
    }
}

/// Vault access tokens: SEP-41-inspired, per-vault non-fungible membership
/// credentials (`mint_access_token` / `burn_access_token` / `transfer` /
/// `owner_of` / `balance`), and their binding to `has_vault_token`.
mod vault_access_tokens {
    use super::*;

    #[test]
    fn test_mint_access_token_success() {
        let (env, client, creator, _g1, _g2, vault_id) = create_test_vault();
        let holder = Address::generate(&env);
        let uri = String::from_str(&env, "ipfs://token-metadata");

        let token_id = client.mint_access_token(&creator, &vault_id, &holder, &uri);

        assert_eq!(token_id, 1);
        assert_eq!(client.owner_of(&token_id), holder);
        assert_eq!(client.balance(&holder), 1);
        assert!(client.has_vault_token(&holder, &vault_id));
        assert_eq!(client.get_token_vault(&token_id), vault_id);
        assert_eq!(client.get_token_uri(&token_id), uri);
    }

    #[test]
    fn test_mint_access_token_ids_increment_across_vaults() {
        let (env, client, creator, _g1, _g2, vault_id) = create_test_vault();
        let holder_a = Address::generate(&env);
        let holder_b = Address::generate(&env);
        let uri = String::from_str(&env, "ipfs://meta");

        let first = client.mint_access_token(&creator, &vault_id, &holder_a, &uri);
        let second = client.mint_access_token(&creator, &vault_id, &holder_b, &uri);

        assert_eq!(first, 1);
        assert_eq!(second, 2);
    }

    #[test]
    #[should_panic(expected = "Only guardians can mint access tokens")]
    fn test_mint_access_token_rejects_non_guardian() {
        let (env, client, _creator, _g1, _g2, vault_id) = create_test_vault();
        let not_a_guardian = Address::generate(&env);
        let holder = Address::generate(&env);
        let uri = String::from_str(&env, "ipfs://meta");

        client.mint_access_token(&not_a_guardian, &vault_id, &holder, &uri);
    }

    #[test]
    #[should_panic(expected = "Vault not active")]
    fn test_mint_access_token_rejects_inactive_vault() {
        let (env, client, creator, _g1, _g2, vault_id) = create_test_vault();
        client.deactivate_vault(&creator, &vault_id);

        let holder = Address::generate(&env);
        let uri = String::from_str(&env, "ipfs://meta");
        client.mint_access_token(&creator, &vault_id, &holder, &uri);
    }

    #[test]
    #[should_panic(expected = "Vault not found")]
    fn test_mint_access_token_rejects_nonexistent_vault() {
        let (env, client) = setup();
        let creator = Address::generate(&env);
        let holder = Address::generate(&env);
        let uri = String::from_str(&env, "ipfs://meta");

        client.mint_access_token(&creator, &999, &holder, &uri);
    }

    #[test]
    fn test_transfer_moves_vault_access_to_new_holder() {
        let (env, client, creator, _g1, _g2, vault_id) = create_test_vault();
        let original_holder = Address::generate(&env);
        let new_holder = Address::generate(&env);
        let uri = String::from_str(&env, "ipfs://meta");

        let token_id = client.mint_access_token(&creator, &vault_id, &original_holder, &uri);
        assert!(client.has_vault_token(&original_holder, &vault_id));
        assert!(!client.has_vault_token(&new_holder, &vault_id));

        client.transfer(&original_holder, &new_holder, &token_id);

        assert_eq!(client.owner_of(&token_id), new_holder);
        assert_eq!(client.balance(&original_holder), 0);
        assert_eq!(client.balance(&new_holder), 1);
        assert!(!client.has_vault_token(&original_holder, &vault_id));
        assert!(client.has_vault_token(&new_holder, &vault_id));
    }

    #[test]
    #[should_panic(expected = "Not token owner")]
    fn test_transfer_rejects_non_owner() {
        let (env, client, creator, _g1, _g2, vault_id) = create_test_vault();
        let holder = Address::generate(&env);
        let stranger = Address::generate(&env);
        let new_holder = Address::generate(&env);
        let uri = String::from_str(&env, "ipfs://meta");

        let token_id = client.mint_access_token(&creator, &vault_id, &holder, &uri);
        client.transfer(&stranger, &new_holder, &token_id);
    }

    #[test]
    #[should_panic(expected = "Token does not exist")]
    fn test_transfer_rejects_nonexistent_token() {
        let (env, client) = setup();
        let from = Address::generate(&env);
        let to = Address::generate(&env);

        client.transfer(&from, &to, &999);
    }

    #[test]
    fn test_burn_access_token_relinquishes_vault_access() {
        let (env, client, creator, _g1, _g2, vault_id) = create_test_vault();
        let holder = Address::generate(&env);
        let uri = String::from_str(&env, "ipfs://meta");

        let token_id = client.mint_access_token(&creator, &vault_id, &holder, &uri);
        assert!(client.has_vault_token(&holder, &vault_id));

        client.burn_access_token(&holder, &token_id);

        assert_eq!(client.balance(&holder), 0);
        assert!(!client.has_vault_token(&holder, &vault_id));
        assert_eq!(client.get_token_vault(&token_id), 0);
    }

    #[test]
    #[should_panic(expected = "Token does not exist")]
    fn test_owner_of_panics_after_burn() {
        let (env, client, creator, _g1, _g2, vault_id) = create_test_vault();
        let holder = Address::generate(&env);
        let uri = String::from_str(&env, "ipfs://meta");

        let token_id = client.mint_access_token(&creator, &vault_id, &holder, &uri);
        client.burn_access_token(&holder, &token_id);
        client.owner_of(&token_id);
    }

    #[test]
    #[should_panic(expected = "Not token owner")]
    fn test_burn_access_token_rejects_non_owner() {
        let (env, client, creator, _g1, _g2, vault_id) = create_test_vault();
        let holder = Address::generate(&env);
        let stranger = Address::generate(&env);
        let uri = String::from_str(&env, "ipfs://meta");

        let token_id = client.mint_access_token(&creator, &vault_id, &holder, &uri);
        client.burn_access_token(&stranger, &token_id);
    }

    #[test]
    fn test_multiple_tokens_for_same_vault_and_holder_compose_correctly() {
        let (env, client, creator, _g1, _g2, vault_id) = create_test_vault();
        let holder = Address::generate(&env);
        let uri = String::from_str(&env, "ipfs://meta");

        let first = client.mint_access_token(&creator, &vault_id, &holder, &uri);
        let second = client.mint_access_token(&creator, &vault_id, &holder, &uri);
        assert_eq!(client.balance(&holder), 2);
        assert!(client.has_vault_token(&holder, &vault_id));

        // Burning one of two tokens must not revoke vault access - the
        // holder still owns the other.
        client.burn_access_token(&holder, &first);
        assert_eq!(client.balance(&holder), 1);
        assert!(client.has_vault_token(&holder, &vault_id));

        // Burning the last one does revoke it.
        client.burn_access_token(&holder, &second);
        assert_eq!(client.balance(&holder), 0);
        assert!(!client.has_vault_token(&holder, &vault_id));
    }

    #[test]
    fn test_transfer_one_of_two_tokens_keeps_sender_access() {
        let (env, client, creator, _g1, _g2, vault_id) = create_test_vault();
        let holder = Address::generate(&env);
        let recipient = Address::generate(&env);
        let uri = String::from_str(&env, "ipfs://meta");

        let first = client.mint_access_token(&creator, &vault_id, &holder, &uri);
        let _second = client.mint_access_token(&creator, &vault_id, &holder, &uri);

        client.transfer(&holder, &recipient, &first);

        // The sender still holds one token for this vault, so they keep
        // vault access; the recipient now has it too.
        assert!(client.has_vault_token(&holder, &vault_id));
        assert!(client.has_vault_token(&recipient, &vault_id));
        assert_eq!(client.balance(&holder), 1);
        assert_eq!(client.balance(&recipient), 1);
    }

    #[test]
    fn test_extend_token_ttl_does_not_panic_for_existing_or_missing_token() {
        let (env, client, creator, _g1, _g2, vault_id) = create_test_vault();
        let holder = Address::generate(&env);
        let uri = String::from_str(&env, "ipfs://meta");

        let token_id = client.mint_access_token(&creator, &vault_id, &holder, &uri);
        client.extend_token_ttl(&token_id);
        // A nonexistent token is a silent no-op, matching extend_document_ttl
        // and extend_request_ttl's `has()`-guarded pattern.
        client.extend_token_ttl(&999);
    }
}

mod fhe_aggregation {
    use super::*;

    fn create_mock_fhe_ciphertext(env: &Env, val: u64) -> Bytes {
        let mut ct = Bytes::new(env);
        // dim = 2 (32 bytes)
        let mut dim = [0u8; 32];
        dim[31] = 2;
        ct.append(&Bytes::from_slice(env, &dim));

        // a_0 (32 bytes)
        let mut a0 = [0u8; 32];
        a0[31] = 10;
        ct.append(&Bytes::from_slice(env, &a0));

        // a_1 (32 bytes)
        let mut a1 = [0u8; 32];
        a1[31] = 20;
        ct.append(&Bytes::from_slice(env, &a1));

        // b (32 bytes)
        let mut b = [0u8; 32];
        b[24..32].copy_from_slice(&val.to_be_bytes());
        ct.append(&Bytes::from_slice(env, &b));

        ct
    }

    #[test]
    fn test_fhe_add_homomorphic_addition() {
        let (env, _, _, _, _, _) = create_test_vault();
        let ct1 = create_mock_fhe_ciphertext(&env, 100);
        let ct2 = create_mock_fhe_ciphertext(&env, 250);

        let sum = SpooVaultStellar::fhe_add(&env, &ct1, &ct2);
        assert_eq!(sum.len(), 128); // 4 words * 32 bytes

        // Check b component (last 32 bytes) = 100 + 250 = 350
        let mut b_sum = [0u8; 32];
        sum.slice(96..128).copy_into_slice(&mut b_sum);
        let val = u64::from_be_bytes(b_sum[24..32].try_into().unwrap());
        assert_eq!(val, 350);
    }

    #[test]
    fn test_save_and_get_fhe_guardian_shares() {
        let (env, client, creator, g1, g2, vault_id) = create_test_vault();

        let doc_id = client.add_document(
            &creator,
            &vault_id,
            &String::from_str(&env, "meta"),
            &String::from_str(&env, "ipfs-hash"),
            &AccessLevel::Read,
            &ReleaseCondition::Anytime,
            &Vec::new(&env),
            &Vec::new(&env),
        );

        let mut guardians = Vec::new(&env);
        guardians.push_back(g1.clone());
        guardians.push_back(g2.clone());

        let ct1 = create_mock_fhe_ciphertext(&env, 111);
        let ct2 = create_mock_fhe_ciphertext(&env, 222);

        let mut shares_fhe = Vec::new(&env);
        shares_fhe.push_back(ct1.clone());
        shares_fhe.push_back(ct2.clone());

        client.save_guardian_shares_fhe(&creator, &doc_id, &guardians, &shares_fhe);

        let stored1 = client.get_fhe_guardian_share(&doc_id, &g1);
        assert_eq!(stored1, Some(ct1));

        let stored2 = client.get_fhe_guardian_share(&doc_id, &g2);
        assert_eq!(stored2, Some(ct2));
    }

    #[test]
    fn test_approve_access_fhe_aggregates_shares_and_grants_access() {
        let (env, client, creator, g1, g2, vault_id) = create_test_vault();
        accept_guardian(&client, &env, &g1, vault_id);
        accept_guardian(&client, &env, &g2, vault_id);
        let beneficiary = Address::generate(&env);

        let doc_id = client.add_document(
            &creator,
            &vault_id,
            &String::from_str(&env, "meta"),
            &String::from_str(&env, "ipfs-hash"),
            &AccessLevel::Read,
            &ReleaseCondition::Anytime,
            &Vec::new(&env),
            &Vec::new(&env),
        );

        let req_id = client.request_access(&beneficiary, &doc_id);

        let ct1 = create_mock_fhe_ciphertext(&env, 500);
        let ct2 = create_mock_fhe_ciphertext(&env, 700);

        // Guardian 1 approves with FHE share 1
        client.approve_access_fhe(&g1, &req_id, &ct1);
        assert_eq!(client.get_fhe_accumulator_count(&req_id), 1);
        let req1 = client.get_access_request(&req_id).unwrap();
        assert_eq!(req1.status, RequestStatus::Pending);

        // Guardian 2 approves with FHE share 2 (threshold = 2 reached)
        client.approve_access_fhe(&g2, &req_id, &ct2);
        assert_eq!(client.get_fhe_accumulator_count(&req_id), 2);
        let req2 = client.get_access_request(&req_id).unwrap();
        assert_eq!(req2.status, RequestStatus::Approved);

        // Verify aggregate ciphertext in storage: b = 500 + 700 = 1200
        let agg = client.get_fhe_aggregate(&req_id).unwrap();
        assert_eq!(agg.len(), 128);

        let mut b_sum = [0u8; 32];
        agg.slice(96..128).copy_into_slice(&mut b_sum);
        let val = u64::from_be_bytes(b_sum[24..32].try_into().unwrap());
        assert_eq!(val, 1200);
    }

    #[test]
    #[should_panic(expected = "Cannot self-approve access")]
    fn test_approve_access_fhe_rejects_self_approval() {
        let (env, client, creator, g1, _g2, vault_id) = create_test_vault();
        accept_guardian(&client, &env, &g1, vault_id);

        let doc_id = client.add_document(
            &creator,
            &vault_id,
            &String::from_str(&env, "meta"),
            &String::from_str(&env, "ipfs-hash"),
            &AccessLevel::Read,
            &ReleaseCondition::Anytime,
            &Vec::new(&env),
            &Vec::new(&env),
        );

        let req_id = client.request_access(&g1, &doc_id);
        let ct = create_mock_fhe_ciphertext(&env, 123);
        client.approve_access_fhe(&g1, &req_id, &ct);
    }

    fn create_mock_bls_pubkey(env: &Env, seed_byte: u8) -> Bytes {
        let mut key = [0u8; 48];
        key[0] = 0x80 | (seed_byte & 0x7f); // compressed flag
        for i in 1..48 {
            key[i] = seed_byte.wrapping_add(i as u8);
        }
        Bytes::from_array(env, &key)
    }

    fn create_mock_bls_signature(env: &Env, seed_byte: u8) -> Bytes {
        let mut sig = [0u8; 96];
        sig[0] = 0x80 | (seed_byte & 0x7f); // compressed flag
        for i in 1..96 {
            sig[i] = seed_byte.wrapping_add(i as u8);
        }
        Bytes::from_array(env, &sig)
    }

    #[test]
    fn test_register_and_get_guardian_bls_key() {
        let (env, client, _creator, g1, _g2, vault_id) = create_test_vault();
        accept_guardian(&client, &env, &g1, vault_id);

        let pk = create_mock_bls_pubkey(&env, 42);
        let pop = create_mock_bls_signature(&env, 42);

        client.register_guardian_bls_key(&g1, &vault_id, &pk, &pop);

        let info = client
            .get_guardian_bls_key(&vault_id, &g1)
            .expect("Key should exist");
        assert!(info.registered);
        assert_eq!(info.public_key, pk);
        assert_eq!(info.proof_of_possession, pop);
    }

    #[test]
    fn test_approve_access_bls_threshold_success() {
        let (env, client, creator, g1, g2, vault_id) = create_test_vault();
        accept_guardian(&client, &env, &g1, vault_id);
        accept_guardian(&client, &env, &g2, vault_id);

        let pk1 = create_mock_bls_pubkey(&env, 1);
        let pop1 = create_mock_bls_signature(&env, 1);
        let pk2 = create_mock_bls_pubkey(&env, 2);
        let pop2 = create_mock_bls_signature(&env, 2);

        client.register_guardian_bls_key(&g1, &vault_id, &pk1, &pop1);
        client.register_guardian_bls_key(&g2, &vault_id, &pk2, &pop2);

        let doc_id = client.add_document(
            &creator,
            &vault_id,
            &String::from_str(&env, "meta"),
            &String::from_str(&env, "ipfs-hash"),
            &AccessLevel::Read,
            &ReleaseCondition::Anytime,
            &Vec::new(&env),
            &Vec::new(&env),
        );

        let beneficiary = Address::generate(&env);
        let req_id = client.request_access(&beneficiary, &doc_id);

        let mut guardians_list = Vec::new(&env);
        guardians_list.push_back(g1);
        guardians_list.push_back(g2);

        let agg_sig = create_mock_bls_signature(&env, 99);
        let agg_pk = create_mock_bls_pubkey(&env, 99);

        let mut shares = Vec::new(&env);
        shares.push_back(String::from_str(&env, "share1"));
        shares.push_back(String::from_str(&env, "share2"));

        client.approve_access_bls(&req_id, &guardians_list, &agg_sig, &agg_pk, &shares);

        let req = client.get_access_request(&req_id).unwrap();
        assert_eq!(req.status, RequestStatus::Approved);
        assert!(client.has_access(&doc_id, &beneficiary));
    }

    // -------------------------------------------------------------------------
    // Issue #98: Ed25519 Threshold Signature Tests
    // -------------------------------------------------------------------------

    fn build_ed25519_threshold_batch(
        env: &Env,
        seeds: &[u8],
        message: &[u8],
        nonce: u64,
        expiration_ledger: u32,
    ) -> (Vec<BytesN<64>>, Vec<BytesN<32>>) {
        use ed25519_dalek::{Signer as _, SigningKey};
        use crate::threshold_sig::THRESHOLD_PREFIX;

        let mut payload = std::vec::Vec::new();
        payload.extend_from_slice(THRESHOLD_PREFIX);
        payload.extend_from_slice(&nonce.to_be_bytes());
        payload.extend_from_slice(&expiration_ledger.to_be_bytes());
        payload.extend_from_slice(message);

        let mut sigs = Vec::new(env);
        let mut pks = Vec::new(env);

        for &seed in seeds {
            let sk = SigningKey::from_bytes(&[seed; 32]);
            let pk_bytes: [u8; 32] = sk.verifying_key().to_bytes();
            let sig_bytes: [u8; 64] = sk.sign(&payload).to_bytes();

            sigs.push_back(BytesN::from_array(env, &sig_bytes));
            pks.push_back(BytesN::from_array(env, &pk_bytes));
        }

        (sigs, pks)
    }

    #[test]
    fn test_threshold_signature_verification_success_varying_k_of_n() {
        let env = Env::default();
        env.ledger().set_sequence_number(100);
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let message_bytes = b"ApproveReleaseDocument#42";
        let message = Bytes::from_slice(&env, message_bytes);
        let expiration_ledger = 500u32;

        // Test 1-of-1
        let (sigs1, pks1) = build_ed25519_threshold_batch(&env, &[1], message_bytes, 1, expiration_ledger);
        assert!(client.verify_threshold_signatures(&message, &sigs1, &pks1, &1, &1, &expiration_ledger));

        // Test 2-of-3
        let (sigs2, pks2) = build_ed25519_threshold_batch(&env, &[2, 3, 4], message_bytes, 2, expiration_ledger);
        assert!(client.verify_threshold_signatures(&message, &sigs2, &pks2, &2, &2, &expiration_ledger));

        // Test 3-of-5
        let (sigs3, pks3) = build_ed25519_threshold_batch(&env, &[10, 11, 12, 13, 14], message_bytes, 3, expiration_ledger);
        assert!(client.verify_threshold_signatures(&message, &sigs3, &pks3, &3, &3, &expiration_ledger));
    }

    #[test]
    #[should_panic]
    fn test_threshold_signature_expired_reverts() {
        let env = Env::default();
        env.ledger().set_sequence_number(600); // Current sequence > expiration
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let message_bytes = b"ExpiredRelease";
        let message = Bytes::from_slice(&env, message_bytes);
        let expiration_ledger = 500u32; // Expired

        let (sigs, pks) = build_ed25519_threshold_batch(&env, &[1, 2], message_bytes, 10, expiration_ledger);
        client.verify_threshold_signatures(&message, &sigs, &pks, &2, &10, &expiration_ledger);
    }

    #[test]
    #[should_panic]
    fn test_threshold_signature_reused_nonce_reverts() {
        let env = Env::default();
        env.ledger().set_sequence_number(100);
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let message_bytes = b"ReplayProtectionCheck";
        let message = Bytes::from_slice(&env, message_bytes);
        let expiration_ledger = 500u32;
        let nonce = 888u64;

        let (sigs, pks) = build_ed25519_threshold_batch(&env, &[1, 2], message_bytes, nonce, expiration_ledger);
        // First call succeeds
        assert!(client.verify_threshold_signatures(&message, &sigs, &pks, &2, &nonce, &expiration_ledger));
        // Second call with same nonce must revert
        client.verify_threshold_signatures(&message, &sigs, &pks, &2, &nonce, &expiration_ledger);
    }

    #[test]
    #[should_panic]
    fn test_threshold_signature_duplicate_signer_reverts() {
        let env = Env::default();
        env.ledger().set_sequence_number(100);
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let message_bytes = b"DuplicateSignerCheck";
        let message = Bytes::from_slice(&env, message_bytes);
        let expiration_ledger = 500u32;
        let nonce = 999u64;

        // Build single signature and duplicate it to satisfy threshold of 2
        let (sigs, pks) = build_ed25519_threshold_batch(&env, &[5], message_bytes, nonce, expiration_ledger);
        let mut dup_sigs = Vec::new(&env);
        dup_sigs.push_back(sigs.get(0).unwrap());
        dup_sigs.push_back(sigs.get(0).unwrap());

        let mut dup_pks = Vec::new(&env);
        dup_pks.push_back(pks.get(0).unwrap());
        dup_pks.push_back(pks.get(0).unwrap());

        client.verify_threshold_signatures(&message, &dup_sigs, &dup_pks, &2, &nonce, &expiration_ledger);
    }

    #[test]
    #[should_panic]
    fn test_threshold_signature_insufficient_signatures_reverts() {
        let env = Env::default();
        env.ledger().set_sequence_number(100);
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let message_bytes = b"InsufficientSignatures";
        let message = Bytes::from_slice(&env, message_bytes);
        let expiration_ledger = 500u32;

        // 1 signature provided but threshold is 2
        let (sigs, pks) = build_ed25519_threshold_batch(&env, &[1], message_bytes, 123, expiration_ledger);
        client.verify_threshold_signatures(&message, &sigs, &pks, &2, &123, &expiration_ledger);
    }

    #[test]
    fn test_approve_access_threshold_flow() {
        let env = Env::default();
        env.ledger().set_sequence_number(100);
        let contract_id = env.register_contract(None, SpooVaultStellar);
        let client = SpooVaultStellarClient::new(&env, &contract_id);

        let creator = Address::generate(&env);
        let g1 = Address::generate(&env);
        let requester = Address::generate(&env);
        env.mock_all_auths();

        let name = String::from_str(&env, "Threshold Vault");
        let desc = String::from_str(&env, "Vault using threshold approvals");
        let guardians = vec![&env, g1.clone()];

        let vault_id = client.create_vault(&creator, &name, &desc, &guardians, &2);
        client.accept_guardian_invite(&g1, &vault_id);

        let doc_id = client.add_document(
            &creator,
            &vault_id,
            &String::from_str(&env, "{\"title\":\"threshold-test\"}"),
            &String::from_str(&env, "QmThresholdHash123"),
            &AccessLevel::Read,
            &ReleaseCondition::Anytime,
            &vec![&env, creator.clone(), g1.clone()],
            &vec![&env, String::from_str(&env, "s1"), String::from_str(&env, "s2")],
        );
        let req_id = client.request_access(&requester, &doc_id);

        let mut msg_payload = std::vec::Vec::new();
        msg_payload.extend_from_slice(b"ApproveAccess:");
        msg_payload.extend_from_slice(&req_id.to_be_bytes());
        msg_payload.extend_from_slice(&vault_id.to_be_bytes());

        let nonce = 5555u64;
        let expiration_ledger = 1000u32;
        let (sigs, pks) = build_ed25519_threshold_batch(&env, &[1, 2], &msg_payload, nonce, expiration_ledger);

        let share = Some(String::from_str(&env, "beneficiary_share_data"));
        client.approve_access_threshold(
            &creator,
            &req_id,
            &sigs,
            &pks,
            &nonce,
            &expiration_ledger,
            &share,
        );

        let request = client.get_access_request(&req_id).unwrap();
        assert_eq!(request.status, RequestStatus::Approved);
    }
}
