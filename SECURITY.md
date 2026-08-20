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
3. **Threshold Enforcement**: Smart contracts enforce \( k \)-of-\( n \) consensus thresholds before unlocking access grant states.

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
