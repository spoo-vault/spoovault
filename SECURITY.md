# Security Policy

SpooVault handles sensitive document custody, secret sharing, and smart contract access management. We take security seriously and welcome reports from community researchers.

---

## Supported Versions

Only the latest release tag and master branch are supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0.0 | :x:                |

---

## Threat Model & Guarantees

1. **Client-Side Encryption**: Document payloads are encrypted client-side using AES-256-GCM. Unencrypted plaintext never touches the IPFS gateway or smart contract state.
2. **Key Isolation**: Master keys are zeroized from memory post-encryption. Key shares are encrypted with recipient public keys using standard Web Crypto API ECIES (ECDH P-256 + AES-256-GCM) before transmission, with client private keys securely stored in browser IndexedDB (encrypted via PBKDF2-SHA256 and AES-256-GCM).
3. **IPFS Proxy Isolation**: The Pinata JWT is held only by `scripts/pinata-proxy.mjs`. Browser pin requests must present a valid `X-SpooVault-Signature` HMAC and originate from an allowlisted domain; all other callers receive 403 Forbidden.
4. **Threshold Enforcement**: Smart contracts enforce \( k \)-of-\( n \) consensus thresholds before unlocking access grant states.

---

## Automated Security Analysis

Every pull request and push to `main` runs [Slither](https://github.com/crytic/slither) and [Mythril](https://github.com/Consensys/mythril) against `contracts/SpooVault.sol` and `contracts/SpooVaultConsumer.sol` in GitHub Actions (see `.github/workflows/security.yml`, job `solidity-security`).

- **Slither** (static analysis) runs via `crytic/slither-action`, filtered to exclude `node_modules` and `contracts-stellar`, and fails the build on High-severity findings (`fail-on: high`). Results are also uploaded as SARIF to the repository's Security tab regardless of pass/fail. Medium- and Low-severity findings are visible there for review but do not currently block the PR, because the contracts have pre-existing Medium/Low findings (dangerous strict equality, uninitialized locals, and `block.timestamp` comparisons) that predate this scanning setup and are out of scope for a CI-integration fix. Escalate the gate to `fail-on: medium` once those are triaged.
- **Mythril** (symbolic execution) runs `myth analyze contracts/SpooVault.sol contracts/SpooVaultConsumer.sol --solv 0.8.24 --solc-args "--allow-paths . --base-path ." --solc-json .github/mythril-solc-settings.json --execution-timeout 300 -o text`. It fails the build on any finding; there are none for the current contracts. (`contracts/ISpooVault.sol` is a pure interface with no bytecode and is skipped.)

### Reproducing locally

```bash
npm install --legacy-peer-deps
npx hardhat compile --config hardhat.config.cjs

pip install slither-analyzer==0.10.4
slither . --filter-paths "node_modules|contracts-stellar" --fail-high

python3 -m venv .mythril-venv && source .mythril-venv/bin/activate
pip install "setuptools==59.6.0" wheel && pip install mythril==0.24.8
ln -sfn node_modules/@openzeppelin @openzeppelin   # lets Mythril resolve the OZ import path it records
myth analyze contracts/SpooVault.sol contracts/SpooVaultConsumer.sol --solv 0.8.24 \
  --solc-args "--allow-paths . --base-path ." \
  --solc-json .github/mythril-solc-settings.json \
  --execution-timeout 300 -o text
```

If a scanner reports a new finding on your PR, fix it or explain in the PR description why it's a false positive or an accepted risk — do not suppress the finding or weaken the scanner configuration to make CI pass.

---

## Reporting Vulnerabilities

If you discover a potential security vulnerability in SpooVault, please **do not open a public issue**. Instead, report it privately:

- **Email**: security@spoovault.io
- **Response SLA**: Initial triage within 48 hours; status updates provided every 5 business days until resolution.

Please include:

- Description of the vulnerability and potential impact.
- Proof of Concept (PoC) steps or script to reproduce.
- Any suggested mitigations.

---

## Bounty Program

Valid security vulnerabilities reported responsibly are eligible for recognition in our Security Hall of Fame and potential grant-backed bounties.
