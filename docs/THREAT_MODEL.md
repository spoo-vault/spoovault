This file addresses the STRIDE matrix requirement with 15+ attack vectors.

```markdown
# Spoo-Vault Cryptographic Threat Model (STRIDE)

| ID | Threat Category | Threat Vector | Mitigation |
|:---|:--- |:--- |:--- |
| 1 | **Spoofing** | Compromised User Private Key | Multi-signature requirements & hardware wallet support. |
| 2 | **Spoofing** | Relayer impersonation | Mutual TLS (mTLS) and signature verification on all relayer calls. |
| 3 | **Tampering** | Malicious IPFS payload modification | Content Addressing (CID) verification on-chain/in-worker. |
| 4 | **Tampering** | Man-in-the-Middle (MitM) share interception | End-to-end ECIES encryption; shares never exist in plaintext over the wire. |
| 5 | **Tampering** | Smart Contract state manipulation | Regular security audits and use of OpenZeppelin/Stellar vetted libraries. |
| 6 | **Repudiation** | User denies vault creation | Cryptographic audit logs stored in IPFS linked to on-chain events. |
| 7 | **Information Disclosure** | Memory scraping of Web Workers | Clearing sensitive variables immediately after VSS reconstruction. |
| 8 | **Information Disclosure** | IPFS Metadata leakage | Metadata anonymization before pinning to IPFS. |
| 9 | **Information Disclosure** | Side-channel attacks on ECIES | Implementation of constant-time cryptographic primitives. |
| 10 | **Denial of Service** | Relayer endpoint flooding | Rate limiting and CAPTCHA integration on frontend API. |
| 11 | **Denial of Service** | IPFS pinning service or public gateway failure (HTTP 429 / timeout) | Redundant pinning; document downloads race Pinata, Infura, Cloudflare, and ipfs.io with a per-gateway circuit breaker. |
| 12 | **Information Disclosure** | Unauthenticated Pinata proxy (`Access-Control-Allow-Origin: *`) leaking JWT-backed pin API | CORS allowlist plus `X-SpooVault-Signature` HMAC; unsigned requests return 403 Forbidden. |
| 13 | **Denial of Service** | Gas price spikes blocking recovery | Relayer gas-tank logic with dynamic fee estimation. |
| 14 | **Elevation of Privilege** | Admin key compromise (EVM) | Transition to decentralized governance (DAO) or 48-hour Timelock. |
| 15 | **Elevation of Privilege** | Unauthorized Relayer access | Role-Based Access Control (RBAC) within the Relayer network. |
| 16 | **Cryptographic** | Weak Entropy for VSS | Using `window.crypto.getRandomValues()` for cryptographically secure randomness. |
| 17 | **Cryptographic** | Insufficient Threshold ($t < n/2$) | Enforcing a minimum threshold of 2/3 for all vault configurations. |

## Formal Security Guarantees
- **Non-Custodial**: Neither Spoo-Vault nor the Relayer ever possesses a full recovery key.
- **Privacy-First**: No PII (Personally Identifiable Information) is stored on-chain or in IPFS.
