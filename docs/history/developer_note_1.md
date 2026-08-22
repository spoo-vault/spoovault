# SpooVault Architecture & Multi-Chain Design

SpooVault is built as a zero-knowledge document custody platform that leverages both EVM-compatible networks (like Avalanche Fuji) and Stellar Soroban.

## Architectural Layering

1. **Presentation Layer**: React + TypeScript frontend utilizing Tailwind CSS and HeroUI.
2. **Security & Cryptography Layer**: Client-side AES-256 encryption combined with Shamir's Secret Sharing (SSS) for secret key splitting.
3. **Storage Layer**: IPFS via Pinata gateway (abstracted behind a local/serverless proxy to secure API keys).
4. **On-Chain Layer**: Smart contracts orchestrating vault access rules, guardian thresholds, and release conditions.

By employing a multi-chain strategy, users can store vault records on their preferred ledger, taking advantage of different speed, security, and fee structures.
