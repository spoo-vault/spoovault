//! Payment Token and Fee Policy: Amount Precision and Overflow Management.
//!
//! Re-exports and exposes the Soroban contracts payment token policy engine
//! from `contracts-stellar/src/payment_token_policy.rs`.

#[path = "../contracts-stellar/src/payment_token_policy.rs"]
pub mod payment_token_policy;

pub use payment_token_policy::*;
