# EIP-712 / Soroban Auth Relayer for Automated Proof-of-Life Heartbeats

Resolves #32.

## Problem

A vault's dead-man's-switch only stays "alive" while its owner submits a
`proveLife` / `prove_life` transaction from their own wallet before the
configured inactivity window elapses. If the owner is simply offline —
travelling, asleep, wallet locked — the vault can incorrectly flip into
post-death mode and release documents to beneficiaries.

Web3 Keepers (Chainlink Automation, Gelato Web3 Functions) are the standard
way to automate this kind of periodic on-chain check-in, but they need a way
to act *on the owner's behalf* without ever holding the owner's private key.

## Design

Each chain gets a delegation mechanism that fits its own native primitives —
this is deliberately **two different mechanisms**, not one design ported
twice:

|                     | Avalanche (EVM)                                   | Stellar (Soroban)                                  |
|---------------------|----------------------------------------------------|-----------------------------------------------------|
| Delegation grant     | Owner signs an **EIP-712** typed message off-chain (`KeeperAuthorization{vaultId, keeper, expiresAt, nonce}`), no gas required to sign. | Owner calls `authorize_keeper` directly, authenticated by Soroban's native `require_auth`. |
| Grant submission     | Anyone (typically the keeper) relays the signature on-chain once via `authorizeKeeperBySig`, which verifies it with `_hashTypedDataV4` + `ECDSA.recover`. | The call itself *is* the submission — no separate relay step, since `require_auth` already lets the owner authorize an action that someone else pays for and submits. |
| Heartbeat relay      | `proveLifeByKeeper(vaultId)` — keeper calls directly, checked against the stored grant. No further owner signature needed until the grant expires. | `prove_life_by_keeper(keeper, vault_id)` — same shape, checked against the stored grant. |
| Revocation           | Owner calls `revokeKeeper(vaultId)`.               | Owner calls `revoke_keeper(vault_id)`.               |
| Replay protection    | Per-vault nonce (`keeperAuthNonces`), incremented on every accepted grant. | Not applicable — Soroban's `require_auth` is not a bearer signature that can be replayed. |

Why not port one design verbatim to both chains?

- EVM has no native way to separate "who authorized this call" from "who is
  submitting this transaction", so an off-chain signature scheme (EIP-712) is
  the standard, gas-efficient way to build one.
- Soroban already separates those two roles for every entrypoint via
  `require_auth`. Building an EIP-712-style signature scheme on top would be
  redundant — the "signature" already exists as the transaction's own
  authorization entry — so the natural Soroban-idiomatic design is a small
  on-chain delegation registry instead.

Both designs give the same operational guarantee: after **one** authorization
(a free off-chain signature on EVM, a single on-chain call on Soroban), a
keeper can relay heartbeats indefinitely until the grant expires or is
revoked — true unattended automation, not a signature-per-heartbeat scheme.

## Contract surface

### `contracts/SpooVault.sol`

- `authorizeKeeperBySig(uint256 vaultId, address keeper, uint256 expiresAt, bytes signature)`
- `revokeKeeper(uint256 vaultId)`
- `proveLifeByKeeper(uint256 vaultId)`
- `keeperAuthorizations(uint256 vaultId)` / `keeperAuthNonces(uint256 vaultId)` (public mapping getters)
- Events: `KeeperAuthorized`, `KeeperRevoked`, `ProofOfLifeRelayed`

### `contracts-stellar/src/lib.rs`

- `authorize_keeper(owner, vault_id, keeper, expires_at)`
- `revoke_keeper(owner, vault_id)`
- `prove_life_by_keeper(keeper, vault_id)`
- `get_keeper_authorization(vault_id) -> Option<KeeperAuthorization>`
- Typed `RelayerError` (`VaultNotFound`, `VaultNotActive`, `OnlyCreator`, `ExpiryInPast`, `NoKeeperAuthorized`, `KeeperMismatch`, `KeeperAuthorizationExpired`) returned as `Result::Err` rather than a contract panic, so the negative paths are testable via the generated `try_*` client methods.

Neither change touches the existing owner-direct `proveLife`/`prove_life`
path — an owner can always heartbeat their own vault regardless of keeper
state.

## Off-chain / application layer

- `src/services/contract.service.ts`: `signKeeperAuthorization`, `relayKeeperAuthorization`, `revokeKeeper`, `relayProofOfLife`, `getKeeperAuthorization`.
- `src/services/stellar.service.ts`: `authorizeKeeper`, `revokeKeeperAuthorization`, `relayProofOfLifeAsKeeper`, `getKeeperAuthorization`.
- `scripts/keeper-relay-evm.mjs` / `scripts/keeper-relay-soroban.mjs`: standalone reference keeper jobs — the shape a Chainlink Automation custom-logic upkeep or a Gelato Web3 Function would run on a schedule. Each checks that its configured keeper is still authorized and unexpired, checks whether a heartbeat is actually due (past half of the vault's inactivity window), and only then submits the relay call.

## Testing

- `test/HeartbeatRelay.test.cjs` (Hardhat/chai/ethers v6): happy-path relay, wrong signer, expired grant, wrong keeper, stale-nonce replay, revocation, non-existent vault, and that direct owner heartbeats keep working alongside delegation.
- `contracts-stellar/src/test.rs`: happy-path relay (including a second heartbeat with no further owner action), unauthorized/wrong-keeper/expired/revoked relay attempts (via `try_*` client methods, since a `Result`-returning contract call — unlike a host panic — surfaces cleanly as an `Err` instead of aborting the test process), and non-creator authorization attempts.
