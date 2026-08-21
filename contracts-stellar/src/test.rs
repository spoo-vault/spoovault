use super::*;
use soroban_sdk::{testutils::{Address as _, Ledger as _}, vec, Address, Env, String};

#[test]
fn test_register_and_get_public_key() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SpooVaultStellar);
    let client = SpooVaultStellarClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    env.mock_all_auths();

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
    client.register_cross_chain_identity(
        &stellar_user,
        &evm_address,
        &Some(enc_pubkey.clone()),
    );

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
    client.register_cross_chain_identity(
        &stellar_user,
        &evm_address,
        &None,
    );

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
    assert_eq!(vault.is_active, true);

    let invites_g1 = client.get_invites(&g1);
    assert_eq!(invites_g1.len(), 1);
    assert_eq!(invites_g1.get(0).unwrap().accepted, false);
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
    assert_eq!(invites.get(0).unwrap().accepted, true);
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
    assert_eq!(state.emergency_mode, true);

    client.prove_life(&creator, &vault_id);
    client.configure_vault_release(&creator, &vault_id, &(60 * 24 * 60 * 60));
    let updated_state = client.get_release_state(&vault_id).unwrap();
    assert_eq!(updated_state.inactivity_period, 60 * 24 * 60 * 60);
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

    let before = client.get_release_state(&vault_id).unwrap().last_proof_of_life;
    env.ledger().with_mut(|li| li.timestamp += 3600);
    client.prove_life_by_keeper(&keeper, &vault_id);

    let after = client.get_release_state(&vault_id).unwrap();
    assert!(after.last_proof_of_life > before);

    // The keeper can heartbeat again later with no further owner action required.
    env.ledger().with_mut(|li| li.timestamp += 3600);
    client.prove_life_by_keeper(&keeper, &vault_id);
}

// Negative paths are asserted via the generated `try_*` client methods rather than
// `#[should_panic]`: a contract-side `assert!`/panic is caught by the Soroban host at
// the client-invocation boundary and surfaced as an `Err`, not as a Rust panic that
// unwinds into the test thread — calling the panicking method directly here would abort
// the test process instead of failing the assertion.

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
