# Security Threat Model & Cryptographic Assumptions

## 1. Scope
This document outlines the trust boundaries, adversary capabilities, and mitigations for the `spoovault` protocol. It covers the cryptographic primitives (ECIES, SSS) and the integration with the Stellar network.

## 2. Cryptographic Primitives & Assumptions
- **ECIES (Elliptic Curve Integrated Encryption Scheme):** Used for encrypting payloads. We assume the underlying curve (e.g., secp256k1 or Curve25519) provides semantic security against chosen-plaintext attacks (IND-CPA).
- **SSS (Shamir's Secret Sharing):** Used to split the vault's master key. We assume a threshold of `k` out of `n` shares is required. Any fewer than `k` shares reveals zero information about the secret.
- **Stellar Network:** Used for consensus and anchor of proofs. We assume the Stellar network is Byzantine Fault Tolerant (BFT) and that the majority of validators are honest.

## 3. Trust Boundaries
- **Client-Side:** The encryption and secret sharing happen locally. The client's private key MUST NOT leave the device. Trust boundary = Device OS / Browser sandbox.
- **On-Chain (Stellar):** Only the hash of the encrypted payload and the public keys are stored on-chain. The chain provides immutability but not confidentiality.
- **Keeper Nodes:** Keepers store SSS shares. A single keeper is untrusted. The protocol relies on the assumption that an adversary cannot compromise `k` out of `n` keepers simultaneously.

## 4. Threat Actors & Adversaries
- **Passive Network Observer:** Can read traffic but cannot modify it. Mitigated by TLS and ECIES.
- **Malicious Keeper (Collusion):** Attempts to collect `k` shares to reconstruct the master key. Mitigated by the assumption that `k` keepers will not collude. If collusion is detected, the protocol must support proactive secret re-sharing.
- **Quantum Adversary:** ECIES relies on ECDLP (Elliptic Curve Discrete Logarithm Problem). This is vulnerable to Shor's algorithm. *Mitigation (Roadmap):* Migrate ECIES to ML-KEM (NIST FIPS 203) hybrid encryption.

## 5. Mitigations
- **Zero-Knowledge Proofs:** Keepers must prove they hold the share without revealing it.
- **Proactive Re-sharing:** Periodically refresh the shares to limit the time window for keeper collusion.
- **Stellar Anchors:** All state transitions are anchored to Stellar to prevent double-spending or forged shares.
