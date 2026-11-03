use soroban_sdk::{contracterror, contracttype, token, Address, Env, Symbol, Vec};

use crate::{
    DataKey, VaultRecord, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
    PERSISTENT_BUMP_AMOUNT, PERSISTENT_LIFETIME_THRESHOLD,
};

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AutomationRegistryError {
    NotInitialized = 1,
    UnauthorizedAdmin = 2,
    InvalidStakeAmount = 3,
    StakeConfigMissing = 4,
    InsufficientStake = 5,
    KeeperAlreadyRegistered = 6,
    KeeperNotRegistered = 7,
    VaultNotFound = 8,
    VaultNotActive = 9,
    OnlyCreator = 10,
    InvalidBountyConfig = 11,
    TokenMismatch = 12,
    TaskNotOpen = 13,
    IntervalNotElapsed = 14,
    InsufficientBounty = 15,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperStakeConfig {
    pub stake_token: Address,
    pub min_stake: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperProfile {
    pub keeper: Address,
    pub stake_token: Address,
    pub staked_amount: i128,
    pub registered_at: u64,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AutomationTask {
    pub vault_id: u64,
    pub funder: Address,
    pub reward_token: Address,
    pub bounty_balance: i128,
    pub reward_per_execution: i128,
    pub interval_seconds: u64,
    pub last_executed_at: u64,
    pub is_open: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BountyDepositedEvent {
    pub vault_id: u64,
    pub funder: Address,
    pub reward_token: Address,
    pub amount_added: i128,
    pub bounty_balance: i128,
    pub reward_per_execution: i128,
    pub interval_seconds: u64,
}

#[contracttype]
pub enum AutomationDataKey {
    KeeperStakeConfig,
    KeeperProfile(Address),
    RegisteredKeepers,
    AutomationTask(u64),
    OpenBountyVaults,
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn bump_persistent(env: &Env, key: &AutomationDataKey) {
    env.storage().persistent().extend_ttl(
        key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

fn try_load_vault(env: &Env, vault_id: u64) -> Option<VaultRecord> {
    env.storage().persistent().get(&DataKey::Vault(vault_id))
}

fn save_vault(env: &Env, vault_id: u64, record: &VaultRecord) {
    let key = DataKey::Vault(vault_id);
    env.storage().persistent().set(&key, record);
    env.storage().persistent().extend_ttl(
        &key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

fn remove_address(env: &Env, list: &Vec<Address>, target: &Address) -> Vec<Address> {
    let mut updated = Vec::new(env);
    for item in list.iter() {
        if &item != target {
            updated.push_back(item);
        }
    }
    updated
}

fn remove_u64(env: &Env, list: &Vec<u64>, target: u64) -> Vec<u64> {
    let mut updated = Vec::new(env);
    for item in list.iter() {
        if item != target {
            updated.push_back(item);
        }
    }
    updated
}

pub fn configure_keeper_stake(
    env: &Env,
    admin: Address,
    stake_token: Address,
    min_stake: i128,
) -> Result<(), AutomationRegistryError> {
    admin.require_auth();
    bump_instance(env);

    let admins: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::Admins)
        .ok_or(AutomationRegistryError::NotInitialized)?;
    if !admins.contains(&admin) {
        return Err(AutomationRegistryError::UnauthorizedAdmin);
    }
    if min_stake <= 0 {
        return Err(AutomationRegistryError::InvalidStakeAmount);
    }

    let config = KeeperStakeConfig {
        stake_token: stake_token.clone(),
        min_stake,
    };
    env.storage()
        .instance()
        .set(&AutomationDataKey::KeeperStakeConfig, &config);

    env.events().publish(
        (Symbol::new(env, "keeper_stake_configured"), stake_token),
        (admin, min_stake),
    );
    Ok(())
}

pub fn get_keeper_stake_config(env: &Env) -> Option<KeeperStakeConfig> {
    bump_instance(env);
    env.storage()
        .instance()
        .get(&AutomationDataKey::KeeperStakeConfig)
}

pub fn register_keeper(
    env: &Env,
    keeper: Address,
    stake_amount: i128,
) -> Result<KeeperProfile, AutomationRegistryError> {
    keeper.require_auth();
    bump_instance(env);

    let config: KeeperStakeConfig = env
        .storage()
        .instance()
        .get(&AutomationDataKey::KeeperStakeConfig)
        .ok_or(AutomationRegistryError::StakeConfigMissing)?;
    if stake_amount < config.min_stake {
        return Err(AutomationRegistryError::InsufficientStake);
    }

    let profile_key = AutomationDataKey::KeeperProfile(keeper.clone());
    if let Some(existing) = env
        .storage()
        .persistent()
        .get::<AutomationDataKey, KeeperProfile>(&profile_key)
    {
        if existing.active {
            return Err(AutomationRegistryError::KeeperAlreadyRegistered);
        }
    }

    let contract_addr = env.current_contract_address();
    token::Client::new(env, &config.stake_token).transfer(&keeper, &contract_addr, &stake_amount);

    let now = env.ledger().timestamp();
    let profile = KeeperProfile {
        keeper: keeper.clone(),
        stake_token: config.stake_token.clone(),
        staked_amount: stake_amount,
        registered_at: now,
        active: true,
    };
    env.storage().persistent().set(&profile_key, &profile);
    bump_persistent(env, &profile_key);

    let keepers_key = AutomationDataKey::RegisteredKeepers;
    let mut keepers: Vec<Address> = env
        .storage()
        .persistent()
        .get(&keepers_key)
        .unwrap_or_else(|| Vec::new(env));
    if !keepers.contains(&keeper) {
        keepers.push_back(keeper.clone());
    }
    env.storage().persistent().set(&keepers_key, &keepers);
    bump_persistent(env, &keepers_key);

    env.events().publish(
        (Symbol::new(env, "keeper_registered"), keeper),
        (config.stake_token, stake_amount, now),
    );
    Ok(profile)
}

pub fn unregister_keeper(env: &Env, keeper: Address) -> Result<i128, AutomationRegistryError> {
    keeper.require_auth();
    bump_instance(env);

    let profile_key = AutomationDataKey::KeeperProfile(keeper.clone());
    let mut profile: KeeperProfile = env
        .storage()
        .persistent()
        .get(&profile_key)
        .ok_or(AutomationRegistryError::KeeperNotRegistered)?;
    if !profile.active {
        return Err(AutomationRegistryError::KeeperNotRegistered);
    }

    let refund = profile.staked_amount;
    profile.active = false;
    profile.staked_amount = 0;
    env.storage().persistent().set(&profile_key, &profile);
    bump_persistent(env, &profile_key);

    let keepers_key = AutomationDataKey::RegisteredKeepers;
    if let Some(keepers) = env
        .storage()
        .persistent()
        .get::<AutomationDataKey, Vec<Address>>(&keepers_key)
    {
        let updated = remove_address(env, &keepers, &keeper);
        env.storage().persistent().set(&keepers_key, &updated);
        bump_persistent(env, &keepers_key);
    }

    if refund > 0 {
        let contract_addr = env.current_contract_address();
        token::Client::new(env, &profile.stake_token).transfer(&contract_addr, &keeper, &refund);
    }

    env.events()
        .publish((Symbol::new(env, "keeper_unregistered"), keeper), refund);
    Ok(refund)
}

pub fn get_keeper_profile(env: &Env, keeper: Address) -> Option<KeeperProfile> {
    bump_instance(env);
    let key = AutomationDataKey::KeeperProfile(keeper);
    let profile: Option<KeeperProfile> = env.storage().persistent().get(&key);
    if profile.is_some() {
        bump_persistent(env, &key);
    }
    profile
}

pub fn get_registered_keepers(env: &Env) -> Vec<Address> {
    bump_instance(env);
    let key = AutomationDataKey::RegisteredKeepers;
    let keepers: Option<Vec<Address>> = env.storage().persistent().get(&key);
    if let Some(list) = keepers {
        bump_persistent(env, &key);
        list
    } else {
        Vec::new(env)
    }
}

pub fn deposit_automation_bounty(
    env: &Env,
    funder: Address,
    vault_id: u64,
    reward_token: Address,
    amount: i128,
    reward_per_execution: i128,
    interval_seconds: u64,
) -> Result<AutomationTask, AutomationRegistryError> {
    funder.require_auth();
    bump_instance(env);

    let record = try_load_vault(env, vault_id).ok_or(AutomationRegistryError::VaultNotFound)?;
    if !record.vault.is_active {
        return Err(AutomationRegistryError::VaultNotActive);
    }
    if amount <= 0 || reward_per_execution <= 0 || interval_seconds == 0 {
        return Err(AutomationRegistryError::InvalidBountyConfig);
    }

    let task_key = AutomationDataKey::AutomationTask(vault_id);
    let existing = env
        .storage()
        .persistent()
        .get::<AutomationDataKey, AutomationTask>(&task_key);

    let (new_balance, last_executed_at, effective_funder) = match existing {
        Some(prev) if prev.bounty_balance > 0 => {
            if prev.reward_token != reward_token {
                return Err(AutomationRegistryError::TokenMismatch);
            }
            let total = prev
                .bounty_balance
                .checked_add(amount)
                .ok_or(AutomationRegistryError::InvalidBountyConfig)?;
            (total, prev.last_executed_at, prev.funder)
        }
        Some(prev) => (amount, prev.last_executed_at, funder.clone()),
        None => (amount, 0, funder.clone()),
    };

    if new_balance < reward_per_execution {
        return Err(AutomationRegistryError::InsufficientBounty);
    }

    let contract_addr = env.current_contract_address();
    token::Client::new(env, &reward_token).transfer(&funder, &contract_addr, &amount);

    let task = AutomationTask {
        vault_id,
        funder: effective_funder,
        reward_token: reward_token.clone(),
        bounty_balance: new_balance,
        reward_per_execution,
        interval_seconds,
        last_executed_at,
        is_open: true,
    };
    env.storage().persistent().set(&task_key, &task);
    bump_persistent(env, &task_key);

    let open_key = AutomationDataKey::OpenBountyVaults;
    let mut open_vaults: Vec<u64> = env
        .storage()
        .persistent()
        .get(&open_key)
        .unwrap_or_else(|| Vec::new(env));
    if !open_vaults.contains(vault_id) {
        open_vaults.push_back(vault_id);
    }
    env.storage().persistent().set(&open_key, &open_vaults);
    bump_persistent(env, &open_key);

    env.events().publish(
        (
            Symbol::new(env, "bounty_deposited"),
            vault_id,
            reward_token.clone(),
        ),
        BountyDepositedEvent {
            vault_id,
            funder,
            reward_token,
            amount_added: amount,
            bounty_balance: new_balance,
            reward_per_execution,
            interval_seconds,
        },
    );

    Ok(task)
}

pub fn execute_automation_task(
    env: &Env,
    keeper: Address,
    vault_id: u64,
) -> Result<i128, AutomationRegistryError> {
    keeper.require_auth();
    bump_instance(env);

    let profile_key = AutomationDataKey::KeeperProfile(keeper.clone());
    let profile: KeeperProfile = env
        .storage()
        .persistent()
        .get(&profile_key)
        .ok_or(AutomationRegistryError::KeeperNotRegistered)?;
    if !profile.active {
        return Err(AutomationRegistryError::KeeperNotRegistered);
    }
    if let Some(config) = env
        .storage()
        .instance()
        .get::<AutomationDataKey, KeeperStakeConfig>(&AutomationDataKey::KeeperStakeConfig)
    {
        if profile.stake_token != config.stake_token || profile.staked_amount < config.min_stake {
            return Err(AutomationRegistryError::InsufficientStake);
        }
    }
    bump_persistent(env, &profile_key);

    let mut record = try_load_vault(env, vault_id).ok_or(AutomationRegistryError::VaultNotFound)?;
    if !record.vault.is_active {
        return Err(AutomationRegistryError::VaultNotActive);
    }

    let task_key = AutomationDataKey::AutomationTask(vault_id);
    let mut task: AutomationTask = env
        .storage()
        .persistent()
        .get(&task_key)
        .ok_or(AutomationRegistryError::TaskNotOpen)?;
    if !task.is_open {
        return Err(AutomationRegistryError::TaskNotOpen);
    }
    if task.bounty_balance < task.reward_per_execution {
        return Err(AutomationRegistryError::InsufficientBounty);
    }

    let now = env.ledger().timestamp();
    if task.last_executed_at > 0
        && now < task.last_executed_at.saturating_add(task.interval_seconds)
    {
        return Err(AutomationRegistryError::IntervalNotElapsed);
    }

    let reward = task.reward_per_execution;
    task.bounty_balance -= reward;
    task.last_executed_at = now;
    if task.bounty_balance < task.reward_per_execution {
        task.is_open = false;
        let open_key = AutomationDataKey::OpenBountyVaults;
        if let Some(open_vaults) = env
            .storage()
            .persistent()
            .get::<AutomationDataKey, Vec<u64>>(&open_key)
        {
            let updated = remove_u64(env, &open_vaults, vault_id);
            env.storage().persistent().set(&open_key, &updated);
            bump_persistent(env, &open_key);
        }
    }
    env.storage().persistent().set(&task_key, &task);
    bump_persistent(env, &task_key);

    record.release_state.last_proof_of_life = now;
    record.release_state.last_proof_of_life_sequence = env.ledger().sequence();
    save_vault(env, vault_id, &record);

    let contract_addr = env.current_contract_address();
    token::Client::new(env, &task.reward_token).transfer(&contract_addr, &keeper, &reward);

    env.events().publish(
        (Symbol::new(env, "task_executed"), vault_id, keeper),
        (reward, task.bounty_balance, now),
    );
    Ok(reward)
}

pub fn cancel_automation_bounty(
    env: &Env,
    creator: Address,
    vault_id: u64,
) -> Result<i128, AutomationRegistryError> {
    creator.require_auth();
    bump_instance(env);

    let record = try_load_vault(env, vault_id).ok_or(AutomationRegistryError::VaultNotFound)?;
    if record.vault.creator != creator {
        return Err(AutomationRegistryError::OnlyCreator);
    }

    let task_key = AutomationDataKey::AutomationTask(vault_id);
    let mut task: AutomationTask = env
        .storage()
        .persistent()
        .get(&task_key)
        .ok_or(AutomationRegistryError::TaskNotOpen)?;
    if !task.is_open && task.bounty_balance == 0 {
        return Err(AutomationRegistryError::TaskNotOpen);
    }

    let refund = task.bounty_balance;
    let refund_recipient = task.funder.clone();
    let reward_token = task.reward_token.clone();

    task.bounty_balance = 0;
    task.is_open = false;
    env.storage().persistent().set(&task_key, &task);
    bump_persistent(env, &task_key);

    let open_key = AutomationDataKey::OpenBountyVaults;
    if let Some(open_vaults) = env
        .storage()
        .persistent()
        .get::<AutomationDataKey, Vec<u64>>(&open_key)
    {
        let updated = remove_u64(env, &open_vaults, vault_id);
        env.storage().persistent().set(&open_key, &updated);
        bump_persistent(env, &open_key);
    }

    if refund > 0 {
        let contract_addr = env.current_contract_address();
        token::Client::new(env, &reward_token).transfer(&contract_addr, &refund_recipient, &refund);
    }

    env.events().publish(
        (Symbol::new(env, "bounty_cancelled"), vault_id),
        (refund_recipient, refund),
    );
    Ok(refund)
}

pub fn get_automation_task(env: &Env, vault_id: u64) -> Option<AutomationTask> {
    bump_instance(env);
    let key = AutomationDataKey::AutomationTask(vault_id);
    let task: Option<AutomationTask> = env.storage().persistent().get(&key);
    if task.is_some() {
        bump_persistent(env, &key);
    }
    task
}

pub fn get_open_bounty_vaults(env: &Env) -> Vec<u64> {
    bump_instance(env);
    let key = AutomationDataKey::OpenBountyVaults;
    let open: Option<Vec<u64>> = env.storage().persistent().get(&key);
    let Some(vault_ids) = open else {
        return Vec::new(env);
    };
    bump_persistent(env, &key);

    let mut active_open = Vec::new(env);
    for vid in vault_ids.iter() {
        if let Some(record) = try_load_vault(env, vid) {
            if record.vault.is_active {
                if let Some(task) = env
                    .storage()
                    .persistent()
                    .get::<AutomationDataKey, AutomationTask>(&AutomationDataKey::AutomationTask(
                        vid,
                    ))
                {
                    if task.is_open && task.bounty_balance >= task.reward_per_execution {
                        active_open.push_back(vid);
                    }
                }
            }
        }
    }
    active_open
}

pub fn get_open_automation_tasks(env: &Env) -> Vec<AutomationTask> {
    let vault_ids = get_open_bounty_vaults(env);
    let mut tasks = Vec::new(env);
    for vid in vault_ids.iter() {
        if let Some(task) = env
            .storage()
            .persistent()
            .get::<AutomationDataKey, AutomationTask>(&AutomationDataKey::AutomationTask(vid))
        {
            bump_persistent(env, &AutomationDataKey::AutomationTask(vid));
            tasks.push_back(task);
        }
    }
    tasks
}
