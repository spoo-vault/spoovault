# SpooVault Bug Bounty Program & Responsible Disclosure

Welcome to the SpooVault Bug Bounty Program. We are committed to protecting our users' decentralized document custody vaults, multi-chain smart contracts (Avalanche EVM & Stellar Soroban), and client-side cryptographic guarantees. We invite security researchers, ethical hackers, and vulnerability hunters to participate in our bug bounty program.

---

## 🛡️ Safe Harbor Guidelines

If you conduct security research in accordance with the guidelines set out in this policy, SpooVault:
1. **Will not initiate legal action** against you or report you to law enforcement for accidental or good-faith security research.
2. **Considers your research authorized** under the Computer Fraud and Abuse Act (CFAA) and similar anti-hacking laws.
3. **Will cooperate with you** to understand and remediate any vulnerability quickly.

You must respect Safe Harbor by:
- Making every effort to avoid privacy violations, data destruction, and service interruption or degradation.
- Only interacting with test accounts and testnets (Stellar Testnet / Avalanche Fuji) or your own deployed test vaults. Never access or modify user data belonging to others.
- Not extorting, blackmailing, or demanding payment in exchange for withholding vulnerability details.

---

## 🏆 Reward Tiers & Severity Guidelines

Bounty rewards are evaluated based on CVSS v3.1 score, exploitability, and potential financial, cryptographic, or operational impact on SpooVault users.

| Severity | CVSS Score | Example Vulnerabilities | Indicative Reward Range |
| :--- | :--- | :--- | :--- |
| **Critical** | 9.0 – 10.0 | • Unauth remote code execution on relayer / infrastructure<br>• Smart contract fund drain / permanent lock without recovery<br>• Master decryption key recovery without authorization / SSS bypass | Up to $10,000 (USDC / XLM) |
| **High** | 7.0 – 8.9 | • Logic flaws bypassing Dead Man's Switch inactivity thresholds<br>• Unauthorized document access across vault boundaries<br>• Cryptographic signature verification bypass in keeper relays | Up to $5,000 (USDC / XLM) |
| **Medium** | 4.0 – 6.9 | • Client-side XSS affecting session storage / key management<br>• Pinata IPFS proxy signature validation bypass<br>• DoS attacks on client UI or gateway circuit breakers | Up to $1,500 (USDC / XLM) |
| **Low** | 0.1 – 3.9 | • Informational disclosures without direct user data risk<br>• Minor information leaks in error messages or logs | Swag & Hall of Fame |

---

## 📬 Vulnerability Submission Channels & PGP Key

Please **do not** report security vulnerabilities via public GitHub issues, pull requests, or public chat channels.

- **Primary Submission Email**: `security@spoovault.io`
- **Encrypted Communication (PGP)**: If you wish to send encrypted correspondence, please use our official security PGP key.
  - **Key ID**: `[Placeholder Security PGP Key ID]`
  - **Fingerprint**: `0000 0000 0000 0000 0000 0000 0000 0000 0000 0000`
  - **Public Key Block**: Available upon request or via key server `keys.openpgp.org` under `security@spoovault.io`.

### Submission Requirements
Please include the following in your report:
1. **Description**: Clear description of the vulnerability and affected components (smart contracts, frontend, IPFS proxy, relayer).
2. **Impact**: Potential impact and attack scenario.
3. **Proof of Concept (PoC)**: Step-by-step instructions, scripts, or transaction hashes demonstrating the issue.
4. **Remediation**: Suggested fixes or mitigations.

---

## ⏱️ Response SLAs & Disclosure Timelines

We are committed to transparent and prompt communication with security researchers:

- **Initial Acknowledgment**: Within **24 to 48 hours** of report receipt.
- **Initial Triage & Severity Assignment**: Within **5 business days**.
- **Status Updates**: Every **5 business days** until resolution or patch deployment.
- **Patch Disclosure Timeline**:
  - We target a patch deployment window of **30 to 90 days** depending on complexity and coordination across multi-chain networks.
  - Coordinated public disclosure is encouraged once the fix is deployed and verified in production.
