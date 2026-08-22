# Key Inbox Services & TweetNaCl Asymmetric Cryptography

Asymmetric cryptography is used to securely pass Shamir key shares between the vault creator and guardians.

## Cryptographic Operations (TweetNaCl)

- **NaCl Box**: Symmetric key shares are encrypted using the sender's private key and the receiver's public key.
- **Zero-Knowledge Delivery**: The encrypted key share is stored on-chain (or in the IPFS key inbox). Only the specific guardian with the matching private key can decrypt it.
- **Re-encryption**: Upon approval, the guardian decrypts the share and re-encrypts it using the beneficiary's public key, safeguarding key confidentiality.
