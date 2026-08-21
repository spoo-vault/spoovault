# Changelog

All notable changes to the SpooVault project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **EIP-712 / Soroban Auth Relayer for Automated Proof-of-Life Heartbeats (Issue #32)**:
  - `SpooVault.sol`: `authorizeKeeperBySig`, `revokeKeeper`, and `proveLifeByKeeper` let a vault owner delegate proof-of-life heartbeats to a Web3 Keeper (Chainlink Automation / Gelato) via a one-time EIP-712 typed signature, so the keeper can relay heartbeats on its own signed transactions until the delegation expires without needing a fresh owner signature each time.
  - `contracts-stellar/src/lib.rs`: `authorize_keeper`, `revoke_keeper`, and `prove_life_by_keeper` mirror the same delegation model using Soroban's native `require_auth`, which already decouples the authorizing owner from the fee-paying/submitting keeper.
  - `contractService`/`stellarService`: signing and relay helpers (`signKeeperAuthorization`, `relayKeeperAuthorization`, `revokeKeeper`, `relayProofOfLife` / `authorizeKeeper`, `revokeKeeperAuthorization`, `relayProofOfLifeAsKeeper`, `getKeeperAuthorization`) for both chains.
  - Reference keeper jobs: `scripts/keeper-relay-evm.mjs` and `scripts/keeper-relay-soroban.mjs`.
  - Hardhat tests (`test/HeartbeatRelay.test.cjs`) and Soroban `cargo test` coverage (`contracts-stellar/src/test.rs`) for the authorization, expiry, revocation, and replay-protection paths on both chains.
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
