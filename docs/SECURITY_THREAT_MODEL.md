# SpooVault Threat Model & Cryptographic Assumptions

## 1. Scope
This document outlines the threat model for the SpooVault protocol, covering the ECIES encryption scheme, Shamir's Secret Sharing (SSS) for key sharding, and the Stellar/Soroban smart contract trust boundaries.

## 2. Adversary Capabilities
We consider adversaries with the following capabilities:
- **Network-level attackers:** Can observe and manipulate network traffic.
- **Malicious guardians:** A subset of guardians may collude to reconstruct secrets.
- **Quantum adversaries:** Future quantum computers capable of breaking classical public-key cryptography.

## 3. Trust Assumptions
- The client-side encryption is performed in a trusted execution environment (the user's browser).
- At least one guardian is honest and will not collude with others.
- The Stellar network provides Byzantine fault tolerance.

## 4. Mitigations
- **ECIES:** Provides confidentiality against network eavesdroppers.
- **SSS:** Ensures that a threshold of guardians is required to reconstruct secrets, mitigating single points of failure.
- **Post-Quantum Considerations:** Future migration to post-quantum algorithms (e.g., Kyber, Dilithium) is planned.

## 5. Conclusion
This threat model provides a baseline for security analysis. Regular audits and updates are required to address evolving threats.
