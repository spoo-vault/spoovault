#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Map, String, Symbol, Vec,
};

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
}

#[contracttype]
pub enum DataKey {
    VaultCount,
    DocCount,
    ReqCount,
    Vault(u64),
    Doc(u64),
    Request(u64),
    IsGuardian(u64, Address),
    HasAccess(u64, Address),
    AccessLvl(u64, Address),
    Invites(Address),
    ApprovedReq(u64, Address),
    LatestReq(u64, Address),
    PubKey(Address),
    GShare(u64, Address),
    BShare(u64, Address),
    DocReleaseCond(u64),
    ReleaseState(u64),
}

#[contract]
pub struct SpooVaultStellar;

#[contractimpl]
impl SpooVaultStellar {
    /// Register a user's encryption public key
    pub fn register_public_key(env: Env, user: Address, public_key: String) {
        user.require_auth();
        env.storage().persistent().set(&DataKey::PubKey(user), &public_key);
    }

    /// Retrieve public key for a user
    pub fn get_public_key(env: Env, user: Address) -> Option<String> {
        env.storage().persistent().get(&DataKey::PubKey(user))
    }

    /// Create a new Vault
    pub fn create_vault(
        env: Env,
        creator: Address,
        name: String,
        description: String,
        guardians: Vec<Address>,
        approval_threshold: u32,
    ) -> u64 {
        creator.require_auth();

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

        assert!(ext_guardian_count > 0, "At least one external guardian required");
        let total_guardians = ext_guardian_count + 1;
        assert!(
            approval_threshold > 0 && approval_threshold <= total_guardians,
            "Invalid approval threshold"
        );

        let vault_count: u64 = env.storage().instance().get(&DataKey::VaultCount).unwrap_or(0);
        let next_vault_id = vault_count + 1;
        env.storage().instance().set(&DataKey::VaultCount, &next_vault_id);

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

        env.storage().persistent().set(&DataKey::Vault(next_vault_id), &vault);
        env.storage().persistent().set(&DataKey::IsGuardian(next_vault_id, creator.clone()), &true);

        // Configure release state defaults
        let release_state = VaultReleaseState {
            emergency_mode: false,
            inactivity_period: 30 * 24 * 60 * 60, // 30 days in seconds
            last_proof_of_life: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&DataKey::ReleaseState(next_vault_id), &release_state);

        // Record invites for external guardians
        for i in 0..guardians.len() {
            let guardian = guardians.get(i).unwrap();
            if guardian == creator {
                continue;
            }

            let mut user_invites: Vec<GuardianInvite> = env
                .storage()
                .persistent()
                .get(&DataKey::Invites(guardian.clone()))
                .unwrap_or_else(|| Vec::new(&env));

            user_invites.push_back(GuardianInvite {
                guardian: guardian.clone(),
                vault_id: next_vault_id,
                accepted: false,
                expires_at: env.ledger().timestamp() + 7 * 24 * 60 * 60, // 7 days
            });

            env.storage().persistent().set(&DataKey::Invites(guardian), &user_invites);
        }

        next_vault_id
    }

    /// Accept guardian invitation
    pub fn accept_guardian_invite(env: Env, guardian: Address, vault_id: u64) {
        guardian.require_auth();

        let mut vault: Vault = env
            .storage()
            .persistent()
            .get(&DataKey::Vault(vault_id))
            .expect("Vault does not exist");
        assert!(vault.is_active, "Vault not active");

        let is_guard: bool = env
            .storage()
            .persistent()
            .get(&DataKey::IsGuardian(vault_id, guardian.clone()))
            .unwrap_or(false);
        assert!(!is_guard, "Already guardian");

        let mut user_invites: Vec<GuardianInvite> = env
            .storage()
            .persistent()
            .get(&DataKey::Invites(guardian.clone()))
            .expect("No invites for user");

        let mut accepted = false;
        for i in 0..user_invites.len() {
            let mut invite = user_invites.get(i).unwrap();
            if invite.vault_id == vault_id && !invite.accepted {
                assert!(env.ledger().timestamp() < invite.expires_at, "Invite expired");
                invite.accepted = true;
                user_invites.set(i, invite);
                accepted = true;
                break;
            }
        }

        assert!(accepted, "No valid invite found");
        env.storage().persistent().set(&DataKey::Invites(guardian.clone()), &user_invites);
        env.storage().persistent().set(&DataKey::IsGuardian(vault_id, guardian.clone()), &true);

        vault.guardians.push_back(guardian);
        env.storage().persistent().set(&DataKey::Vault(vault_id), &vault);
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

        let is_guard: bool = env
            .storage()
            .persistent()
            .get(&DataKey::IsGuardian(vault_id, uploader.clone()))
            .unwrap_or(false);
        assert!(is_guard, "Only guardians can upload documents");
        assert!(ipfs_hash.len() > 0, "IPFS hash required");
        assert!(
            guardians_list.len() == shares.len(),
            "Guardians list and shares count mismatch"
        );

        let doc_count: u64 = env.storage().instance().get(&DataKey::DocCount).unwrap_or(0);
        let next_doc_id = doc_count + 1;
        env.storage().instance().set(&DataKey::DocCount, &next_doc_id);

        let doc = Document {
            id: next_doc_id,
            vault_id,
            encrypted_metadata,
            ipfs_hash,
            uploaded_by: uploader.clone(),
            uploaded_at: env.ledger().timestamp(),
            required_access,
        };

        env.storage().persistent().set(&DataKey::Doc(next_doc_id), &doc);
        env.storage().persistent().set(&DataKey::DocReleaseCond(next_doc_id), &release_condition);

        // Grant creator uploader access automatically
        env.storage().persistent().set(&DataKey::HasAccess(next_doc_id, uploader.clone()), &true);
        env.storage().persistent().set(&DataKey::AccessLvl(next_doc_id, uploader), &required_access);

        // Store guardian shares
        for i in 0..guardians_list.len() {
            let guardian = guardians_list.get(i).unwrap();
            let share = shares.get(i).unwrap();
            env.storage().persistent().set(&DataKey::GShare(next_doc_id, guardian), &share);
        }

        next_doc_id
    }

    /// Request document access
    pub fn request_access(env: Env, requester: Address, document_id: u64) -> u64 {
        requester.require_auth();

        let doc: Document = env
            .storage()
            .persistent()
            .get(&DataKey::Doc(document_id))
            .expect("Document not found");

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
            Self::is_release_condition_satisfied(&env, doc.vault_id, cond),
            "Release condition locked"
        );

        let req_count: u64 = env.storage().instance().get(&DataKey::ReqCount).unwrap_or(0);
        let next_req_id = req_count + 1;
        env.storage().instance().set(&DataKey::ReqCount, &next_req_id);

        let access_req = AccessRequest {
            request_id: next_req_id,
            document_id,
            requester: requester.clone(),
            approved_by: Vec::new(&env),
            status: RequestStatus::Pending,
            expires_at: env.ledger().timestamp() + 3 * 24 * 60 * 60, // 3 days
            created_at: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&DataKey::Request(next_req_id), &access_req);
        env.storage().persistent().set(&DataKey::LatestReq(document_id, requester), &next_req_id);

        next_req_id
    }

    /// Approve document access request by a guardian
    pub fn approve_access(
        env: Env,
        approver: Address,
        request_id: u64,
        encrypted_share_for_beneficiary: Option<String>,
    ) {
        approver.require_auth();

        let mut request: AccessRequest = env
            .storage()
            .persistent()
            .get(&DataKey::Request(request_id))
            .expect("Request not found");
        assert!(
            request.status == RequestStatus::Pending,
            "Request not pending"
        );
        assert!(
            env.ledger().timestamp() < request.expires_at,
            "Request expired"
        );

        let doc: Document = env
            .storage()
            .persistent()
            .get(&DataKey::Doc(request.document_id))
            .expect("Document not found");

        let vault: Vault = env
            .storage()
            .persistent()
            .get(&DataKey::Vault(doc.vault_id))
            .expect("Vault not found");

        let is_guard: bool = env
            .storage()
            .persistent()
            .get(&DataKey::IsGuardian(doc.vault_id, approver.clone()))
            .unwrap_or(false);
        assert!(is_guard, "Only guardians can approve access");

        let already_approved: bool = env
            .storage()
            .persistent()
            .get(&DataKey::ApprovedReq(request_id, approver.clone()))
            .unwrap_or(false);
        assert!(!already_approved, "Already approved");

        env.storage().persistent().set(&DataKey::ApprovedReq(request_id, approver.clone()), &true);
        request.approved_by.push_back(approver.clone());

        if let Some(share) = encrypted_share_for_beneficiary {
            env.storage().persistent().set(&DataKey::BShare(request_id, approver), &share);
        }

        if request.approved_by.len() >= vault.approval_threshold {
            request.status = RequestStatus::Approved;
            env.storage().persistent().set(&DataKey::HasAccess(request.document_id, request.requester.clone()), &true);
            env.storage().persistent().set(&DataKey::AccessLvl(request.document_id, request.requester.clone()), &doc.required_access);
        }

        env.storage().persistent().set(&DataKey::Request(request_id), &request);
    }

    /// Record proof of life for inactivity check
    pub fn prove_life(env: Env, owner: Address, vault_id: u64) {
        owner.require_auth();

        let vault: Vault = env
            .storage()
            .persistent()
            .get(&DataKey::Vault(vault_id))
            .expect("Vault not found");
        assert!(vault.creator == owner, "Only creator can record proof of life");
        assert!(vault.is_active, "Vault not active");

        let mut state: VaultReleaseState = env
            .storage()
            .persistent()
            .get(&DataKey::ReleaseState(vault_id))
            .unwrap();
        state.last_proof_of_life = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::ReleaseState(vault_id), &state);
    }

    /// Configure vault release conditions
    pub fn configure_vault_release(
        env: Env,
        owner: Address,
        vault_id: u64,
        inactivity_period: u64,
    ) {
        owner.require_auth();

        let vault: Vault = env
            .storage()
            .persistent()
            .get(&DataKey::Vault(vault_id))
            .expect("Vault not found");
        assert!(vault.creator == owner, "Only creator can configure release");
        assert!(vault.is_active, "Vault not active");
        assert!(
            inactivity_period >= 24 * 60 * 60 && inactivity_period <= 365 * 24 * 60 * 60,
            "Inactivity period must be between 1 and 365 days"
        );

        let mut state: VaultReleaseState = env
            .storage()
            .persistent()
            .get(&DataKey::ReleaseState(vault_id))
            .unwrap();
        state.inactivity_period = inactivity_period;
        env.storage().persistent().set(&DataKey::ReleaseState(vault_id), &state);
    }

    /// Set vault emergency mode
    pub fn set_emergency_mode(env: Env, owner: Address, vault_id: u64, enabled: bool) {
        owner.require_auth();

        let vault: Vault = env
            .storage()
            .persistent()
            .get(&DataKey::Vault(vault_id))
            .expect("Vault not found");
        assert!(vault.creator == owner, "Only creator can set emergency mode");
        assert!(vault.is_active, "Vault not active");

        let mut state: VaultReleaseState = env
            .storage()
            .persistent()
            .get(&DataKey::ReleaseState(vault_id))
            .unwrap();
        state.emergency_mode = enabled;
        env.storage().persistent().set(&DataKey::ReleaseState(vault_id), &state);
    }

    /// Helper function to check if release condition is satisfied
    pub fn is_release_condition_satisfied(
        env: &Env,
        vault_id: u64,
        condition: ReleaseCondition,
    ) -> bool {
        if condition == ReleaseCondition::Anytime {
            return true;
        }

        let state: VaultReleaseState = env
            .storage()
            .persistent()
            .get(&DataKey::ReleaseState(vault_id))
            .expect("Vault state missing");

        let is_dead = env.ledger().timestamp() >= state.last_proof_of_life + state.inactivity_period;

        match condition {
            ReleaseCondition::LiveOnly => !is_dead,
            ReleaseCondition::EmergencyOnly => state.emergency_mode || is_dead,
            ReleaseCondition::PostDeathOnly => is_dead,
            ReleaseCondition::Anytime => true,
        }
    }

    pub fn get_vault(env: Env, vault_id: u64) -> Option<Vault> {
        env.storage().persistent().get(&DataKey::Vault(vault_id))
    }

    pub fn get_document(env: Env, document_id: u64) -> Option<Document> {
        env.storage().persistent().get(&DataKey::Doc(document_id))
    }

    pub fn get_access_request(env: Env, request_id: u64) -> Option<AccessRequest> {
        env.storage().persistent().get(&DataKey::Request(request_id))
    }

    pub fn get_invites(env: Env, guardian: Address) -> Vec<GuardianInvite> {
        env.storage()
            .persistent()
            .get(&DataKey::Invites(guardian))
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn get_release_state(env: Env, vault_id: u64) -> Option<VaultReleaseState> {
        env.storage().persistent().get(&DataKey::ReleaseState(vault_id))
    }
}

mod test;

