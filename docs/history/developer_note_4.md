# Decentralized Guardians & Threshold Signature Logic

Instead of trusting a single custodian, SpooVault distributes key management among a set of user-designated "Guardians."

## Guardian Lifecycle

1. **Designation**: During vault creation, the creator inputs the addresses of trusted guardians and sets an approval threshold $T$ (where $T le 	ext{total guardians}$).
2. **Invitation**: On-chain invites are registered.
3. **Acceptance**: Guardians accept invitations on-chain via MetaMask or Freighter.
4. **Key Delivery**: The creator encrypts the SSS key shares using each guardian's public key (using asymmetric NaCl box encryption) and saves them in the guardian's inbox.
5. **Reconstruction Request**: The beneficiary requests access, which the guardians approve on-chain to release their key shares.
