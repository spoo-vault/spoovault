//! Emergency unlock / Soroban PRNG tests compiled as an integration crate
//! so they do not depend on `upgrade_fixture` Wasm (`contractimport!` in
//! `src/test.rs`).
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    vec, Address, Env, String,
};
use spoovault_stellar::{AccessLevel, ReleaseCondition, SpooVaultStellar, SpooVaultStellarClient};

fn client(env: &Env) -> SpooVaultStellarClient<'_> {
    let contract_id = env.register_contract(None, SpooVaultStellar);
    SpooVaultStellarClient::new(env, &contract_id)
}

fn setup_emergency_doc(env: &Env, client: &SpooVaultStellarClient) -> (Address, Address, u64, u64) {
    let creator = Address::generate(env);
    let g1 = Address::generate(env);
    let requester = Address::generate(env);
    env.mock_all_auths();

    let vault_id = client.create_vault(
        &creator,
        &String::from_str(env, "PRNG Vault"),
        &String::from_str(env, "Emergency jitter"),
        &vec![env, g1.clone()],
        &1,
    );
    let doc_id = client.add_document(
        &creator,
        &vault_id,
        &String::from_str(env, "meta"),
        &String::from_str(env, "QmEmergencyDoc"),
        &AccessLevel::Read,
        &ReleaseCondition::EmergencyOnly,
        &vec![env, creator.clone()],
        &vec![env, String::from_str(env, "share")],
    );
    (creator, requester, vault_id, doc_id)
}

#[test]
#[should_panic(expected = "Release condition locked")]
fn pending_prng_keeps_emergency_only_locked() {
    let env = Env::default();
    let client = client(&env);
    let (creator, requester, vault_id, doc_id) = setup_emergency_doc(&env, &client);
    client.set_emergency_mode(&creator, &vault_id, &true);
    client.request_access(&requester, &doc_id);
}

#[test]
fn fulfillment_after_three_ledgers_stores_prng_bounds_and_unlocks() {
    let env = Env::default();
    let client = client(&env);
    let (creator, requester, vault_id, doc_id) = setup_emergency_doc(&env, &client);
    client.set_emergency_jitter_window(&creator, &vault_id, &(5 * 60));
    client.set_emergency_mode(&creator, &vault_id, &true);

    let pending = client
        .get_emergency_unlock_schedule(&vault_id)
        .expect("pending request");
    assert!(!pending.fulfilled);
    assert_eq!(pending.cycle, 1);

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
fn timestamp_alone_stays_locked() {
    let env = Env::default();
    let client = client(&env);
    let (creator, requester, vault_id, doc_id) = setup_emergency_doc(&env, &client);
    client.set_emergency_mode(&creator, &vault_id, &true);
    env.ledger().with_mut(|li| {
        li.sequence_number += 4;
        li.timestamp += 20;
    });
    client.fulfill_emergency_unlock_delay(&vault_id);
    let schedule = client.get_emergency_unlock_schedule(&vault_id).unwrap();
    env.ledger().with_mut(|li| {
        li.timestamp = schedule.unlock_at + 1;
    });
    client.request_access(&requester, &doc_id);
}

#[test]
#[should_panic(expected = "Release condition locked")]
fn ledger_alone_stays_locked() {
    let env = Env::default();
    let client = client(&env);
    let (creator, requester, vault_id, doc_id) = setup_emergency_doc(&env, &client);
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
#[should_panic(expected = "Emergency unlock confirmations not met")]
fn fulfillment_before_three_ledgers_is_rejected() {
    let env = Env::default();
    let client = client(&env);
    let (creator, _, vault_id, _) = setup_emergency_doc(&env, &client);
    client.set_emergency_mode(&creator, &vault_id, &true);
    client.fulfill_emergency_unlock_delay(&vault_id);
}

#[test]
#[should_panic(expected = "Emergency unlock delay already pending")]
fn second_enable_while_pending_is_rejected() {
    let env = Env::default();
    let client = client(&env);
    let (creator, _, vault_id, _) = setup_emergency_doc(&env, &client);
    client.set_emergency_mode(&creator, &vault_id, &true);
    client.set_emergency_mode(&creator, &vault_id, &true);
}

#[test]
#[should_panic(expected = "Emergency unlock already fulfilled")]
fn duplicate_fulfillment_is_rejected() {
    let env = Env::default();
    let client = client(&env);
    let (creator, _, vault_id, _) = setup_emergency_doc(&env, &client);
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
fn fulfillment_after_disable_is_rejected() {
    let env = Env::default();
    let client = client(&env);
    let (creator, _, vault_id, _) = setup_emergency_doc(&env, &client);
    client.set_emergency_mode(&creator, &vault_id, &true);
    env.ledger().with_mut(|li| {
        li.sequence_number += 4;
        li.timestamp += 20;
    });
    client.set_emergency_mode(&creator, &vault_id, &false);
    client.fulfill_emergency_unlock_delay(&vault_id);
}

#[test]
fn new_cycle_does_not_reuse_old_bounds() {
    let env = Env::default();
    let client = client(&env);
    let (creator, _, vault_id, _) = setup_emergency_doc(&env, &client);
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
fn permissionless_fulfillment_does_not_require_owner_auth() {
    let env = Env::default();
    let client = client(&env);
    let (creator, _, vault_id, _) = setup_emergency_doc(&env, &client);
    client.set_emergency_mode(&creator, &vault_id, &true);
    env.ledger().with_mut(|li| {
        li.sequence_number += 4;
        li.timestamp += 20;
    });
    // No extra auth: anyone may call after confirmations.
    client.fulfill_emergency_unlock_delay(&vault_id);
    assert!(
        client
            .get_emergency_unlock_schedule(&vault_id)
            .unwrap()
            .fulfilled
    );
}
