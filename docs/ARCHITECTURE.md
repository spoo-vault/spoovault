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
4. **No Self-Approval Invariant**: An access approval can never originate from the request's beneficiary. `_approveAccess` reverts with `CannotSelfApproveAccess` when `msg.sender == request.requester`, so quorum counts only distinct, accepted guardians other than the requester. This holds even when the requester later becomes a guardian (e.g. a request filed before accepting a guardian invite), preventing any self-vote from inflating multi-sig quorum in multi-custody or emergency inheritance configurations.

---

## 3. Dual-Chain Smart Contract Layer

### Avalanche (Solidity `SpooVault.sol`)

- Manages document metadata records, vault configurations, guardian thresholds, and NFT access pass minting on Avalanche Fuji testnet (Chain ID `43113`).

### Stellar (Soroban Rust Contract)

- Manages document registry, guardian approvals, and key inbox distribution on the Stellar Soroban testnet using native Rust Soroban SDK data structures.

---

## 4. IPFS Storage, Gateway Pool & Circuit Breaker

To prevent client-side leaks of Pinata API credentials:

- Production pin and unpin requests route through `scripts/pinata-proxy.mjs`. The Pinata JWT stays on the server.
- CORS is restricted to `SPOOVUALT_ALLOWED_ORIGINS` (local Vite URLs by default). Wildcard `Access-Control-Allow-Origin: *` is not used.
- Every `/api/ipfs/*` pin, unpin, or list call must present `X-SpooVault-Signature: t=<unix>,v1=<hmac-sha256-hex>`. The HMAC covers timestamp, method, path, and body hash. Unsigned or cross-origin callers receive **403 Forbidden**.
- The frontend signs with `VITE_SPOOVUALT_PROXY_SECRET` (a dedicated HMAC key, not the Pinata JWT). See `scripts/lib/ipfsProxyGuard.mjs`.

### Key Envelope Unpinning & Garbage Collection Lifecycle

When access requests expire or are rejected, key envelope JSON blobs pinned on Pinata consume unnecessary storage quota. SpooVault implements automated garbage collection for key envelopes:

- **Proxy Unpin Endpoint**: `DELETE /api/ipfs/unpin/:hash` forwards authenticated deletion requests directly to Pinata's unpin API (`https://api.pinata.cloud/pinning/unpin/:hash`).
- **Unpinning Service (`ipfsService.unpin` & `keyInboxService.unpinKeyEnvelope`)**: Routes unpin calls through the HMAC-guarded proxy in production/configured environments, with direct Pinata API fallback in development.
- **Automated Garbage Collection (`keyEnvelopeGCService`)**:
  - Automatically identifies expired (`expiresAt <= now` or `status: 3`) and rejected (`status: 2`) access requests.
  - Automatically unpins corresponding key envelope blobs from IPFS when access requests are rejected, expired, or scanned during Access Center workflows.
  - Emits telemetry events (`ipfs.unpin.gc`, `ipfs.unpin.gc.sweep`) for observability.

Document **downloads** no longer depend on a single Pinata URL. `src/services/ipfsGateway.ts` races a public gateway pool and fails over automatically when the primary gateway rate-limits or stalls:

1. Pinata (`VITE_IPFS_GATEWAY`, default `https://gateway.pinata.cloud/ipfs/`)
2. Infura IPFS (`https://ipfs.infura.io/ipfs/`)
3. Cloudflare IPFS (`https://cloudflare-ipfs.com/ipfs/`)
4. IPFS.io (`https://ipfs.io/ipfs/`)

Each gateway has a circuit breaker. HTTP 429, timeouts, 401/403, and 5xx responses open that gateway's circuit for 30 seconds so a rate-limited Pinata endpoint is skipped on the next fetch. Healthy (or half-open) gateways are raced in parallel; the first 2xx wins and remaining in-flight requests are aborted.

Callers use `ipfsService.fetchFile` / `fetchFromIPFS` (Documents, Access Center, and NFT `ipfs://` metadata). `getIPFSURL` remains a deterministic primary-gateway URL for display and copy. Extra download gateways can be appended with `VITE_IPFS_FALLBACK_GATEWAYS`.

---

## 5. Read-Call Caching

`contract.service.ts` caches the results of read-only view calls (`hasActiveAccess`, `getVault`) for a 10-second TTL, keyed by their arguments (document/vault/user), with concurrent duplicate calls deduped into a single underlying request. This avoids re-issuing the same RPC call on every page navigation or component remount. Write actions that change cached state (e.g. `approveAccess`, `acceptGuardianInvite`, `burnAccessToken`) invalidate the relevant cache entries immediately, and `contractService.clear()` resets the cache on wallet disconnect. See `src/utils/ttlCache.ts` for the generic cache implementation.

The Stellar/Soroban path currently has no real RPC calls (reads are `localStorage`-backed mocks pending real Soroban integration — see the `// TODO (Contributor)` markers in `stellar.service.ts`), so this caching layer reduces real RPC volume only on the Avalanche path today. It is wired at the ecosystem-agnostic `proxied*` layer so it applies automatically once real Soroban reads are implemented.

---

## 6. Windowed List Rendering (Document & Access Pass Lists)

`Documents.tsx` and `NFTGallery.tsx` render potentially large lists (uploaded documents, minted access passes) that previously mounted every item to the DOM unconditionally, causing scroll jank as a vault's item count grows.

Both pages now delegate their list rendering to a dedicated, presentational component that windows the DOM using [`@tanstack/react-virtual`](https://tanstack.com/virtual/latest):

- `src/components/documents/VirtualizedDocumentsList.tsx` — windows the document table body. The table markup itself is a CSS-grid of `role="table"/"row"/"cell"` divs rather than a native `<table>`, because native table rows can't be absolutely positioned for windowing without breaking column alignment (see decision rationale in PR #45).
- `src/components/nft/VirtualizedNftGrid.tsx` — windows the access-pass card grid by chunking tokens into rows matching the current responsive column count (1/2/3 columns) and virtualizing rows of cards.

Both components use `useVirtualizer`'s `measureElement` for dynamic per-row sizing (rather than a single fixed row height), since row/card content height varies with wrapped text and action-button counts. Only rows within the viewport plus a small overscan are ever mounted to the DOM, regardless of total list length.

`@tanstack/react-virtual` was already present in `package-lock.json` as a transitive dependency of `@heroui/react`'s internal `Table`/`Listbox` virtualization (HeroUI's own `<Table isVirtualized>` uses it internally) — it is now also a direct dependency, pinned to the same locked version, since both pages call it directly.
