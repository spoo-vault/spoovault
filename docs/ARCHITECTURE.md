# SpooVault System Architecture

SpooVault is an enterprise-grade document custody and secret sharing application supporting dual-chain operation across **Avalanche (EVM)** and **Stellar (Soroban)** networks.

---

## 1. High-Level System Topology

```
+-----------------------------------------------------------------------------------+
|                                  SpooVault React DApp                             |
|    +-----------------------+   +------------------------+   +-------------------+ |
|    | Client-Side AES-256   |   | Shamir Secret Sharing  |   | TweetNaCl Box     | |
|    +-----------------------+   +------------------------+   +-------------------+ |
+------------------------------------------+----------------------------------------+
                                           |
                    +----------------------+----------------------+
                    |                                             |
                    v                                             v
     +------------------------------+             +-------------------------------+
     |   Avalanche C-Chain (EVM)    |             |    Stellar Network (Soroban)  |
     |   - SpooVault.sol            |             |    - SpooVault Soroban Contract|
     |   - Document Metadata Registry|             |    - Guardian Thresholds      |
     |   - Guardian Consensus Vaults|             |    - Key Release Requests     |
     |   - Access Pass NFTs         |             |                               |
     +------------------------------+             +-------------------------------+
                    |                                             |
                    +----------------------+----------------------+
                                           |
                                           v
                             +--------------------------+
                             |    Decentralized Storage |
                             |    - IPFS Gateway Proxy  |
                             |    - Encrypted Data CID   |
                             +--------------------------+
```

---

## 2. Cryptographic Security Model

1. **Zero-Knowledge Upload**: Documents are encrypted entirely client-side using AES-256-GCM prior to being dispatched to IPFS. Raw document payloads never touch server or blockchain memory unencrypted.
2. **Key Splitting via Shamir Secret Sharing (SSS)**: Master encryption keys are split into threshold shares \( (k, n) \). Shares are distributed securely to designated Guardian public keys via TweetNaCl public-key box encryption.
3. **Threshold Key Reconstruction**: Beneficiaries initiate document release requests. Guardians independently review and approve requests on-chain. Once the required threshold \( k \) of \( n \) signatures is met, encrypted key packages are released for client-side assembly and document decryption.

---

## 3. Dual-Chain Smart Contract Layer

### Avalanche (Solidity `SpooVault.sol`)
- Manages document metadata records, vault configurations, guardian thresholds, and NFT access pass minting on Avalanche Fuji testnet (Chain ID `43113`).

### Stellar (Soroban Rust Contract)
- Manages document registry, guardian approvals, and key inbox distribution on the Stellar Soroban testnet using native Rust Soroban SDK data structures.

---

## 4. IPFS Storage & Proxy Isolation

To prevent client-side leaks of Pinata API credentials:
- Production requests route through a lightweight proxy script (`scripts/pinata-proxy.mjs`).
- Upload payloads are authenticated using ephemeral tokens or scoped proxy headers.

---

## 5. Read-Call Caching

`contract.service.ts` caches the results of read-only view calls (`hasActiveAccess`, `getVault`) for a 10-second TTL, keyed by their arguments (document/vault/user), with concurrent duplicate calls deduped into a single underlying request. This avoids re-issuing the same RPC call on every page navigation or component remount. Write actions that change cached state (e.g. `approveAccess`, `acceptGuardianInvite`, `burnAccessToken`) invalidate the relevant cache entries immediately, and `contractService.clear()` resets the cache on wallet disconnect. See `src/utils/ttlCache.ts` for the generic cache implementation.

The Stellar/Soroban path currently has no real RPC calls (reads are `localStorage`-backed mocks pending real Soroban integration — see the `// TODO (Contributor)` markers in `stellar.service.ts`), so this caching layer reduces real RPC volume only on the Avalanche path today. It is wired at the ecosystem-agnostic `proxied*` layer so it applies automatically once real Soroban reads are implemented.
