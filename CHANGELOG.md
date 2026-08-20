# Changelog

All notable changes to the SpooVault project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **UTF-8 Multi-byte Character Encoding in Crypto Utilities**: Fixed character corruption and potential `DOMException: Invalid character` errors when encoding/decoding Base64 payloads containing multi-byte UTF-8 characters (emojis, international characters, and symbols) by refactoring to standard `TextEncoder` and `TextDecoder` APIs.

### Added
- **Extended Crypto Utility Functions**:
  - `uint8ArrayToString`: Converts byte arrays to UTF-8 strings via `TextDecoder`.
  - `utf8ToBase64` & `base64ToUtf8`: Direct UTF-8 string <-> Base64 conversion helpers.
  - `decryptWithPrivateKey`: Decrypts X25519-XSalsa20-Poly1305 encrypted JSON payloads using receiver's private key.
  - Added robust handling of URL-safe Base64 (`-`, `_`), whitespace, and padding in `base64ToUint8Array`.
- **Expanded Crypto Test Suite**: Added comprehensive Vitest tests verifying multi-byte UTF-8, emoji, URL-safe Base64, and asymmetric encryption/decryption round trips.

---

## [1.1.0] - 2026-08-14

### Added
- **Web Worker Off-Thread Encryption Engine**: Dedicated `crypto.worker.ts` and `CryptoWorkerService` handling client-side AES-256-GCM encryption and decryption off the main UI thread with automatic fallback for high-throughput document processing.
- **Cryptographic Audit Certificate Exporter**: Built `AuditService` for generating SHA-256 signed JSON audit certificates and CSV activity logs for enterprise compliance verification.
- **Vault Dead-Man Switch & Inheritance Controls**: Smart contract methods and `InheritanceSettings` UI component supporting proof-of-life heartbeats, configurable inactivity timeouts, and emergency mode toggles.
- **Automated CI/CD Pipeline**: GitHub Actions workflow (`.github/workflows/ci.yml`) performing automated TypeScript type checks, Vitest test execution, Vite production bundling, and Hardhat EVM contract compilation on pushes and pull requests.
- **Comprehensive Unit Test Suites**:
  - Vitest test suite covering client-side crypto, TweetNaCl key boxes, Web Workers, audit service, and formatting helpers (16 passing tests).
  - Hardhat test suite (`test/SpooVault.test.js`) testing EVM public key registry, vault creation, signature thresholds, proof of life, and emergency modes (6 passing tests).
  - Native Rust unit test file (`contracts-stellar/src/test.rs`) for Stellar Soroban contract logic.
- **Document Filtering & Search Bar**: Integrated `DocumentFilterBar` supporting live keyword search, category tag pills, network isolation (Avalanche vs. Stellar), and sorting.
- **Repository Governance Documentation**: Added `ARCHITECTURE.md`, `SECURITY.md`, GitHub issue templates (`bug_report.md`, `feature_request.md`), and pull request template (`PULL_REQUEST_TEMPLATE.md`).

---

## [1.0.0] - 2026-08-01

### Added
- Initial release of SpooVault supporting dual Avalanche (EVM) and Stellar (Soroban) document custody, client-side encryption, and IPFS storage.
