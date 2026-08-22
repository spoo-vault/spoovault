# Soroban Smart Contract Architecture (Rust + Cargo)

The Stellar integration is built using Soroban smart contracts written in Rust (`contracts-stellar/src/lib.rs`).

## Rust Module Layout

- **AccessLevel & RequestStatus Enums**: Strong typed access rules.
- **Vault, Document, and AccessRequest Structs**: Standardized state layouts stored in persistent instance storage.
- **SpooVaultStellar Contract**: Core entry points matching EVM functionality.

## Soroban Storage Pattern

We utilize persistent storage key mapping for:

- `DataKey::Vault(id)`
- `DataKey::Doc(id)`
- `DataKey::Request(id)`
- `DataKey::PubKey(address)`

This ensures isolated, verifiable state transitions under Freighter authorization constraints.
