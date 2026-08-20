# Changelog

All notable changes to the SpooVault project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- **Live Stellar Soroban Integration**: `createVault`, `addDocument`, `requestAccess`, `approveAccess`, `acceptGuardianInvite`, and `registerPublicKey` now submit real Soroban Testnet transactions via `@stellar/stellar-sdk` and Freighter, with contract reads (vaults, documents, invites, approvals, tokens) fetching live on-chain state and falling back to the localStorage mock layer when no contract is configured. See `docs/history/developer_note_21.md`.
- **Freighter Rejection Handling**: Signing rejections from Freighter are normalized into a friendly error surfaced as an error toast; non-rejection failures propagate unchanged.
- **Test Coverage Enforcement**: `@vitest/coverage-v8` with per-file thresholds (lines/branches/functions/statements ≥ 90%) on `src/services/stellar.service.ts`; `npm run test:coverage` script; coverage step added to the CI workflow.

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
