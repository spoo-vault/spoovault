//! Payment Token and Fee Policy: Amount Precision and Overflow Management.
//!
//! Objective:
//! Make accepted assets, fee calculation, and token configuration explicit,
//! bounded, and consistent across operations. Implement and verify amount precision
//! and overflow handling to provide a deterministic, reviewable guarantee under
//! normal, invalid, repeated, concurrent, and failure conditions.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env,
};

/// Maximum allowable token scale (decimals), matching standard ERC20/Stellar precision caps.
pub const MAX_TOKEN_DECIMALS: u32 = 18;
/// Basis points denominator (10,000 BPS = 100%).
pub const BPS_DENOMINATOR: i128 = 10_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PaymentTokenError {
    /// Contract state is uninitialized.
    NotInitialized = 1,
    /// Caller is unauthorized.
    Unauthorized = 2,
    /// Asset address or configuration is invalid.
    AssetNotAccepted = 3,
    /// Scale / decimals value exceeds maximum allowed bound (18).
    InvalidScale = 4,
    /// Min/max payment bounds are invalid (min <= 0 or max < min).
    InvalidBounds = 5,
    /// Fee BPS value exceeds 10,000 (100%).
    InvalidFeeBps = 6,
    /// Amount is below the minimum allowed payment bound.
    AmountTooLow = 7,
    /// Amount exceeds the maximum allowed payment bound.
    AmountTooHigh = 8,
    /// Arithmetic overflow occurred during balance, scale, or fee calculation.
    MathOverflow = 9,
    /// Arithmetic underflow occurred during balance or fee deduction.
    MathUnderflow = 10,
    /// Asset is marked inactive.
    InactiveAsset = 11,
    /// Calculated total fee exceeds the gross payment amount.
    FeeExceedsAmount = 12,
    /// Precision loss occurred during scale conversion (non-zero remainder).
    PrecisionLoss = 13,
}

/// Token configuration for accepted payment assets.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenConfig {
    /// Asset contract address.
    pub asset: Address,
    /// Scale / decimals (0 to 18).
    pub decimals: u32,
    /// Minimum allowed payment amount in asset base units.
    pub min_amount: i128,
    /// Maximum allowed payment amount in asset base units.
    pub max_amount: i128,
    /// Flag indicating if asset is accepted for payments.
    pub is_active: bool,
}

/// Fee calculation policy configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeePolicy {
    /// Fee in basis points (1 BPS = 0.01%, 10,000 BPS = 100%).
    pub fee_bps: u32,
    /// Flat fee in asset base units.
    pub flat_fee: i128,
    /// Minimum total fee threshold.
    pub min_fee: i128,
    /// Maximum total fee cap (0 = uncapped).
    pub max_fee: i128,
    /// Fee recipient treasury address.
    pub treasury: Address,
}

/// Detailed quote breakdown for a payment settlement.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeQuote {
    /// Total gross payment amount.
    pub gross_amount: i128,
    /// Total calculated fee.
    pub fee_amount: i128,
    /// Net amount payable to recipient (gross_amount - fee_amount).
    pub net_amount: i128,
    /// Asset contract address.
    pub asset: Address,
}

#[contracttype]
pub enum DataKey {
    Admin,
    TokenConfig(Address),
    FeePolicy(Address),
}

/// Converts an integer amount between token scales (decimals) with exact integer rules.
/// Returns error on invalid scale (>18), overflow, or precision loss when downscaling.
pub fn convert_amount_scale(
    amount: i128,
    from_decimals: u32,
    to_decimals: u32,
) -> Result<i128, PaymentTokenError> {
    if from_decimals > MAX_TOKEN_DECIMALS || to_decimals > MAX_TOKEN_DECIMALS {
        return Err(PaymentTokenError::InvalidScale);
    }

    if amount < 0 {
        return Err(PaymentTokenError::InvalidBounds);
    }

    if from_decimals == to_decimals || amount == 0 {
        return Ok(amount);
    }

    if to_decimals > from_decimals {
        let diff = to_decimals - from_decimals;
        let factor = 10i128
            .checked_pow(diff)
            .ok_or(PaymentTokenError::MathOverflow)?;
        amount
            .checked_mul(factor)
            .ok_or(PaymentTokenError::MathOverflow)
    } else {
        let diff = from_decimals - to_decimals;
        let factor = 10i128
            .checked_pow(diff)
            .ok_or(PaymentTokenError::MathOverflow)?;
        
        // Exact integer division rule: non-zero remainder means fractional precision loss
        if amount % factor != 0 {
            return Err(PaymentTokenError::PrecisionLoss);
        }

        Ok(amount / factor)
    }
}

/// Computes the fee quote for a given amount using token config and fee policy.
/// Guarantees exact integer BPS math, min/max fee caps, overflow protection,
/// and ensures net_amount = gross_amount - fee_amount >= 0.
pub fn calculate_fee_quote(
    config: &TokenConfig,
    policy: &FeePolicy,
    gross_amount: i128,
) -> Result<FeeQuote, PaymentTokenError> {
    if !config.is_active {
        return Err(PaymentTokenError::InactiveAsset);
    }

    if gross_amount <= 0 {
        return Err(PaymentTokenError::AmountTooLow);
    }

    if gross_amount < config.min_amount {
        return Err(PaymentTokenError::AmountTooLow);
    }

    if gross_amount > config.max_amount {
        return Err(PaymentTokenError::AmountTooHigh);
    }

    if policy.fee_bps > 10_000 {
        return Err(PaymentTokenError::InvalidFeeBps);
    }

    // 1. Calculate BPS fee: (gross_amount * fee_bps) / 10,000
    let bps_fee = gross_amount
        .checked_mul(policy.fee_bps as i128)
        .ok_or(PaymentTokenError::MathOverflow)?
        / BPS_DENOMINATOR;

    // 2. Add flat fee
    let mut fee_total = bps_fee
        .checked_add(policy.flat_fee)
        .ok_or(PaymentTokenError::MathOverflow)?;

    // 3. Apply minimum fee floor if set
    if fee_total < policy.min_fee {
        fee_total = policy.min_fee;
    }

    // 4. Apply maximum fee cap if configured (max_fee > 0)
    if policy.max_fee > 0 && fee_total > policy.max_fee {
        fee_total = policy.max_fee;
    }

    // 5. Bounds safety: total fee cannot exceed gross payment amount
    if fee_total > gross_amount {
        return Err(PaymentTokenError::FeeExceedsAmount);
    }

    // 6. Net settlement calculation with underflow protection
    let net_amount = gross_amount
        .checked_sub(fee_total)
        .ok_or(PaymentTokenError::MathUnderflow)?;

    Ok(FeeQuote {
        gross_amount,
        fee_amount: fee_total,
        net_amount,
        asset: config.asset.clone(),
    })
}

#[contract]
pub struct PaymentTokenPolicy;

#[contractimpl]
impl PaymentTokenPolicy {
    /// Initialize payment token policy admin.
    pub fn init_admin(env: Env, admin: Address) -> Result<(), PaymentTokenError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(PaymentTokenError::Unauthorized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// Configures token precision and payment bounds for an accepted asset.
    pub fn set_token_config(
        env: Env,
        admin: Address,
        asset: Address,
        decimals: u32,
        min_amount: i128,
        max_amount: i128,
        is_active: bool,
    ) -> Result<(), PaymentTokenError> {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(PaymentTokenError::NotInitialized)?;
        if admin != stored_admin {
            return Err(PaymentTokenError::Unauthorized);
        }

        if decimals > MAX_TOKEN_DECIMALS {
            return Err(PaymentTokenError::InvalidScale);
        }

        if min_amount <= 0 || max_amount < min_amount {
            return Err(PaymentTokenError::InvalidBounds);
        }

        let config = TokenConfig {
            asset: asset.clone(),
            decimals,
            min_amount,
            max_amount,
            is_active,
        };

        env.storage()
            .persistent()
            .set(&DataKey::TokenConfig(asset), &config);

        Ok(())
    }

    /// Returns configured token parameters for an asset.
    pub fn get_token_config(env: Env, asset: Address) -> Option<TokenConfig> {
        env.storage()
            .persistent()
            .get(&DataKey::TokenConfig(asset))
    }

    /// Configures fee policy (BPS rate, flat fee, min/max caps, treasury) for an asset.
    pub fn set_fee_policy(
        env: Env,
        admin: Address,
        asset: Address,
        fee_bps: u32,
        flat_fee: i128,
        min_fee: i128,
        max_fee: i128,
        treasury: Address,
    ) -> Result<(), PaymentTokenError> {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(PaymentTokenError::NotInitialized)?;
        if admin != stored_admin {
            return Err(PaymentTokenError::Unauthorized);
        }

        if fee_bps > 10_000 {
            return Err(PaymentTokenError::InvalidFeeBps);
        }

        if flat_fee < 0 || min_fee < 0 || (max_fee > 0 && max_fee < min_fee) {
            return Err(PaymentTokenError::InvalidBounds);
        }

        let policy = FeePolicy {
            fee_bps,
            flat_fee,
            min_fee,
            max_fee,
            treasury,
        };

        env.storage()
            .persistent()
            .set(&DataKey::FeePolicy(asset), &policy);

        Ok(())
    }

    /// Returns configured fee policy for an asset.
    pub fn get_fee_policy(env: Env, asset: Address) -> Option<FeePolicy> {
        env.storage()
            .persistent()
            .get(&DataKey::FeePolicy(asset))
    }

    /// Quotes the fee breakdown for a proposed payment.
    pub fn quote_fee(env: Env, asset: Address, gross_amount: i128) -> Result<FeeQuote, PaymentTokenError> {
        let config: TokenConfig = env
            .storage()
            .persistent()
            .get(&DataKey::TokenConfig(asset.clone()))
            .ok_or(PaymentTokenError::AssetNotAccepted)?;

        let policy: FeePolicy = env
            .storage()
            .persistent()
            .get(&DataKey::FeePolicy(asset))
            .ok_or(PaymentTokenError::AssetNotAccepted)?;

        calculate_fee_quote(&config, &policy, gross_amount)
    }

    /// Converts an amount between scales.
    pub fn convert_scale(
        _env: Env,
        amount: i128,
        from_decimals: u32,
        to_decimals: u32,
    ) -> Result<i128, PaymentTokenError> {
        convert_amount_scale(amount, from_decimals, to_decimals)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};


    /// Independent oracle math calculation for validating fee quotes.
    fn oracle_calculate_fee(
        gross_amount: i128,
        fee_bps: u32,
        flat_fee: i128,
        min_fee: i128,
        max_fee: i128,
    ) -> (i128, i128) {
        let bps_fee = (gross_amount * fee_bps as i128) / 10_000;
        let mut total_fee = bps_fee + flat_fee;
        if total_fee < min_fee {
            total_fee = min_fee;
        }
        if max_fee > 0 && total_fee > max_fee {
            total_fee = max_fee;
        }
        let net = gross_amount - total_fee;
        (total_fee, net)
    }

    #[test]
    fn test_scale_conversion_up_and_down() {
        // 100.5 USDC (6 decimals) -> 18 decimals
        let usdc_amount = 100_500_000i128;
        let converted = convert_amount_scale(usdc_amount, 6, 18).unwrap();
        assert_eq!(converted, 100_500_000_000_000_000_000i128);

        // Convert back from 18 to 6 decimals
        let back = convert_amount_scale(converted, 18, 6).unwrap();
        assert_eq!(back, usdc_amount);
    }

    #[test]
    fn test_scale_conversion_precision_loss_reverts() {
        // 1.000000000000000001 (18 decimals) downscaling to 6 decimals loses 1 wei -> must fail
        let amount = 1_000_000_000_000_000_001i128;
        let res = convert_amount_scale(amount, 18, 6);
        assert_eq!(res, Err(PaymentTokenError::PrecisionLoss));
    }

    #[test]
    fn test_scale_conversion_invalid_scale_reverts() {
        assert_eq!(
            convert_amount_scale(100, 19, 6),
            Err(PaymentTokenError::InvalidScale)
        );
        assert_eq!(
            convert_amount_scale(100, 6, 20),
            Err(PaymentTokenError::InvalidScale)
        );
    }

    #[test]
    fn test_fee_calculation_normal_and_oracle_match() {
        let env = Env::default();
        let asset = Address::generate(&env);
        let treasury = Address::generate(&env);

        let config = TokenConfig {
            asset: asset.clone(),
            decimals: 6,
            min_amount: 1_000_000,       // $1.00
            max_amount: 1_000_000_000_000,// $1M
            is_active: true,
        };

        let policy = FeePolicy {
            fee_bps: 50,                  // 0.50%
            flat_fee: 100_000,            // $0.10
            min_fee: 500_000,             // $0.50 min
            max_fee: 50_000_000,          // $50 max cap
            treasury: treasury.clone(),
        };

        let gross = 10_000_000i128; // $10.00
        let quote = calculate_fee_quote(&config, &policy, gross).unwrap();

        let (oracle_fee, oracle_net) = oracle_calculate_fee(gross, 50, 100_000, 500_000, 50_000_000);
        assert_eq!(quote.fee_amount, oracle_fee);
        assert_eq!(quote.net_amount, oracle_net);
        assert_eq!(quote.gross_amount, gross);
        assert_eq!(quote.fee_amount + quote.net_amount, gross);
    }

    #[test]
    fn test_fee_calculation_min_and_max_caps() {
        let env = Env::default();
        let asset = Address::generate(&env);

        let config = TokenConfig {
            asset: asset.clone(),
            decimals: 6,
            min_amount: 10,
            max_amount: 1_000_000_000_000,
            is_active: true,
        };

        let policy = FeePolicy {
            fee_bps: 10,        // 0.10%
            flat_fee: 0,
            min_fee: 50,        // Minimum $0.000050
            max_fee: 100,       // Maximum $0.000100
            treasury: Address::generate(&env),
        };

        // Small amount ($0.01 = 10,000 base units) -> 0.10% is 10, below min_fee 50 -> should cap at min_fee 50
        let quote_min = calculate_fee_quote(&config, &policy, 10_000).unwrap();
        assert_eq!(quote_min.fee_amount, 50);

        // Large amount ($100 = 100,000_000) -> 0.10% is 100,000, above max_fee 100 -> should cap at max_fee 100
        let quote_max = calculate_fee_quote(&config, &policy, 100_000_000).unwrap();
        assert_eq!(quote_max.fee_amount, 100);
    }

    #[test]
    fn test_fee_calculation_zero_min_max_boundary_values() {
        let env = Env::default();
        let asset = Address::generate(&env);

        let config = TokenConfig {
            asset: asset.clone(),
            decimals: 18,
            min_amount: 1,
            max_amount: i128::MAX,
            is_active: true,
        };

        let policy = FeePolicy {
            fee_bps: 0,
            flat_fee: 0,
            min_fee: 0,
            max_fee: 0,
            treasury: Address::generate(&env),
        };

        // Amount = 1 wei
        let quote = calculate_fee_quote(&config, &policy, 1).unwrap();
        assert_eq!(quote.fee_amount, 0);
        assert_eq!(quote.net_amount, 1);
    }

    #[test]
    fn test_near_overflow_amount_handled_safely() {
        let env = Env::default();
        let asset = Address::generate(&env);

        let config = TokenConfig {
            asset: asset.clone(),
            decimals: 18,
            min_amount: 1,
            max_amount: i128::MAX,
            is_active: true,
        };

        let policy = FeePolicy {
            fee_bps: 500, // 5%
            flat_fee: 1000,
            min_fee: 0,
            max_fee: 0,
            treasury: Address::generate(&env),
        };

        // Amount near i128::MAX where gross * fee_bps would overflow i128
        let huge_amount = i128::MAX / 2;
        let res = calculate_fee_quote(&config, &policy, huge_amount);
        assert_eq!(res, Err(PaymentTokenError::MathOverflow));
    }

    #[test]
    fn test_out_of_bounds_and_inactive_rejections() {
        let env = Env::default();
        let asset = Address::generate(&env);

        let config = TokenConfig {
            asset: asset.clone(),
            decimals: 6,
            min_amount: 100,
            max_amount: 1000,
            is_active: true,
        };

        let policy = FeePolicy {
            fee_bps: 100,
            flat_fee: 0,
            min_fee: 0,
            max_fee: 0,
            treasury: Address::generate(&env),
        };

        // Amount below min
        assert_eq!(
            calculate_fee_quote(&config, &policy, 50),
            Err(PaymentTokenError::AmountTooLow)
        );

        // Amount above max
        assert_eq!(
            calculate_fee_quote(&config, &policy, 1500),
            Err(PaymentTokenError::AmountTooHigh)
        );

        // Inactive asset
        let inactive_config = TokenConfig {
            is_active: false,
            ..config
        };
        assert_eq!(
            calculate_fee_quote(&inactive_config, &policy, 500),
            Err(PaymentTokenError::InactiveAsset)
        );
    }

    #[test]
    fn test_payment_token_policy_contract_flow() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, PaymentTokenPolicy);
        let client = PaymentTokenPolicyClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let asset = Address::generate(&env);
        let treasury = Address::generate(&env);

        // Initialize admin
        client.init_admin(&admin);

        // Set token config: 6 decimals, min $1.00 (1_000_000), max $1M (1_000_000_000_000)
        client.set_token_config(
            &admin,
            &asset,
            &6,
            &1_000_000,
            &1_000_000_000_000,
            &true,
        );

        let config = client.get_token_config(&asset).unwrap();
        assert_eq!(config.decimals, 6);
        assert_eq!(config.min_amount, 1_000_000);
        assert_eq!(config.max_amount, 1_000_000_000_000);
        assert!(config.is_active);

        // Set fee policy: 50 BPS (0.50%), flat fee 100_000 ($0.10), min_fee 500_000 ($0.50), max_fee 50_000_000 ($50)
        client.set_fee_policy(
            &admin,
            &asset,
            &50,
            &100_000,
            &500_000,
            &50_000_000,
            &treasury,
        );

        let policy = client.get_fee_policy(&asset).unwrap();
        assert_eq!(policy.fee_bps, 50);
        assert_eq!(policy.flat_fee, 100_000);
        assert_eq!(policy.treasury, treasury);

        // Quote fee for $100 (100_000_000 base units)
        // 0.50% of $100 = $0.50 (500_000) + $0.10 flat (100_000) = $0.60 (600_000)
        let quote = client.quote_fee(&asset, &100_000_000);
        assert_eq!(quote.gross_amount, 100_000_000);
        assert_eq!(quote.fee_amount, 600_000);
        assert_eq!(quote.net_amount, 99_400_000);
        assert_eq!(quote.asset, asset);

        // Scale conversion via contract entrypoint
        let converted = client.convert_scale(&100_000_000, &6, &18);
        assert_eq!(converted, 100_000_000_000_000_000_000i128);
    }
}

