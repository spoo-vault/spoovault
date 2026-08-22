# Changelog

All notable changes to the SpooVault project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Automated IPFS Unpinning Garbage Collection for Expired Key Envelopes**:
  - Added authenticated `DELETE /api/ipfs/unpin/:hash` proxy endpoint in `scripts/pinata-proxy.mjs` with HMAC signature validation and CORS restrictions.
  - Extended `ipfsService.unpin` and `keyInboxService.unpinKeyEnvelope` to support authenticated unpinning through proxy or direct Pinata API with graceful 404 handling.
  - Implemented `keyEnvelopeGCService` with automated evaluation (`isRequestExpiredOrRejected`), targeted request unpinning (`unpinEnvelopesForRequest`), and scoped/account garbage collection sweeps (`runGarbageCollection`).
  - Integrated automated unpinning lifecycle triggers into Access Center to automatically reclaim Pinata storage quota whenever access requests expire or are rejected.
  - Added comprehensive Vitest unit test suites (`ipfs.service.test.ts`, `keyEnvelopeGC.service.test.ts`, `keyInbox.service.test.ts`, `ipfsProxyGuard.test.ts`) with high statement and branch coverage.
- **Pinata proxy HMAC auth and CORS lock-down (Issue #27)**:
  - Restricted `scripts/pinata-proxy.mjs` CORS to `SPOOVUALT_ALLOWED_ORIGINS` instead of `Access-Control-Allow-Origin: *`.
  - Required `X-SpooVault-Signature` HMAC verification on pin/list routes so unsigned external requests are rejected with 403 Forbidden, keeping the Pinata JWT off the public internet.
- **Multi-gateway IPFS download circuit breaker (Issue #26)**:
  - Replaced single-gateway Pinata document fetches with a race across Pinata, Infura IPFS, Cloudflare IPFS, and ipfs.io.
  - Per-gateway circuit breaker skips endpoints that return HTTP 429, time out, or fail with 401/403/5xx until cooldown elapses, so public Pinata rate limits no longer crash document loading.
  - Wired `fetchFromIPFS` into Documents, Access Center, and NFT `ipfs://` metadata loads; uploads remain on Pinata/proxy.
- **Web Crypto API ECIES Migration (Issue #17)**:
  - Replaced deprecated MetaMask `eth_decrypt` and `eth_getEncryptionPublicKey` RPC methods with browser-native Web Crypto API ECIES (ECDH P-256 + AES-256-GCM).
  - Built `clientKeyringService` with browser IndexedDB storage (`spoovault-keyring`), encrypting client-side private keys using PBKDF2-SHA256 (600,000 iterations) + AES-256-GCM with optional PIN/passphrase protection and in-memory session caching.
  - Standardized ECIES payload format (`ecies-p256-aes256gcm-v1`) across Avalanche EVM and Stellar Soroban networks with seamless backward compatibility for legacy `x25519-xsalsa20-poly1305` payloads.
  - Updated Profile, Dashboard, AccessCenter, and Documents flows to perform key generation, guardian share decryption, and beneficiary key package delivery seamlessly across all Web3 wallets without relying on `eth_decrypt`.
- **Extended Crypto Utility Functions**:
  - `generateECIESKeyPair` & `generateECIESKeyPairBase64`: Generates ECDH P-256 keypairs using Web Crypto API.
  - `exportECIESPublicKey`, `exportECIESPrivateKey`, `importECIESPublicKey`, `importECIESPrivateKey`: Handles SPKI, PKCS#8, and raw uncompressed key import/export.
  - `encryptWithPublicKey`: Asynchronously encrypts messages using Web Crypto ECIES.
  - `decryptWithPrivateKey`: Decrypts ECIES payloads with legacy X25519 fallback.
  - `uint8ArrayToString`: Converts byte arrays to UTF-8 strings via `TextDecoder`.
  - `utf8ToBase64` & `base64ToUtf8`: Direct UTF-8 string <-> Base64 conversion helpers.
  - Added robust handling of URL-safe Base64 (`-`, `_`), whitespace, and padding in `base64ToUint8Array`.
- **Expanded Crypto & Keyring Test Suites**: Added comprehensive Vitest unit tests in `crypto.test.ts` and `clientKeyring.service.test.ts` covering key generation, ECIES encryption/decryption, tampered payloads, legacy fallbacks, PIN security, and encrypted backup export/import.

### Fixed

- **UTF-8 Multi-byte Character Encoding in Crypto Utilities**: Fixed character corruption and potential `DOMException: Invalid character` errors when encoding/decoding Base64 payloads containing multi-byte UTF-8 characters (emojis, international characters, and symbols) by refactoring to standard `TextEncoder` and `TextDecoder` APIs.
- **Timestamp Manipulation Guard on Post-Death Release** (#4): `SpooVault.sol` and `contracts-stellar/src/lib.rs` no longer unlock post-death release conditions from `block.timestamp`/ledger-timestamp comparisons alone. Both contracts now also require a minimum block/ledger-sequence delta (`MIN_POST_DEATH_BLOCK_DELTA` / `MIN_POST_DEATH_SEQUENCE_DELTA`, 256) to have elapsed since the last recorded proof of life, closing the window for miners/validators to trigger an early release via short-range timestamp drift.

---

## [1.1.0] - 2026-08-14

### Added

- **Web Worker Off-Thread Encryption Engine**: Dedicated `crypto.worker.ts` and `CryptoWorkerService` handling client-side AES-256-GCM encryption and decryption off the main UI thread with automatic fallback for high-throughput document processing.
- **Cryptographic Audit Certificate Exporter**: Built `AuditService` for generating SHA-256 signed JSON audit certificates and CSV activity logs for enterprise compliance verification.
- **Vault Dead-Man Switch & Inheritance Controls**: Smart contract methods and `InheritanceSettings` UI component supporting proof-of-life heartbeats, configurable inactivity timeouts, and emergency mode toggles.
- **Automated CI/CD Pipeline**: GitHub Actions workflow (`.github/workflows/ci.yml`) performing automated TypeScript type checks, Vitest test execution, Vite production bundling, and Hardhat EVM contract compilation on pushes and pull requests.
- **Comprehensive Unit Test Suites**:
  - Vitest test suite covering client-side crypto, TweetNaCl key boxes, Web Workers, audit service, and formatting helpers.
  - Hardhat test suite (`test/SpooVault.test.js`) testing EVM public key registry, vault creation, signature thresholds, proof of life, and emergency modes.
  - Native Rust unit test file (`contracts-stellar/src/test.rs`) for Stellar Soroban contract logic.
- **Document Filtering & Search Bar**: Integrated `DocumentFilterBar` supporting live keyword search, category tag pills, network isolation (Avalanche vs. Stellar), and sorting.
- **Repository Governance Documentation**: Added `ARCHITECTURE.md`, `SECURITY.md`, GitHub issue templates (`bug_report.md`, `feature_request.md`), and pull request template (`PULL_REQUEST_TEMPLATE.md`).

---

## [1.0.0] - 2026-08-01

### Added

- Initial release of SpooVault supporting dual Avalanche (EVM) and Stellar (Soroban) document custody, client-side encryption, and IPFS storage.
