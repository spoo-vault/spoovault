# Client-Side Encryption & Security Standards (AES-256)

Security in SpooVault is strictly zero-knowledge. Documents are encrypted directly in the client's browser before transit.

## Encryption Flow

1. **Key Generation**: A random 256-bit symmetric key is generated locally using secure random values.
2. **AES-256 Encryption**: The document's binary data is encrypted with the generated key using the AES-GCM or AES-CBC algorithm (provided by `crypto-js`).
3. **Metadata Encryption**: Filename, MIME type, and size are also encrypted to prevent leakage of metadata.
4. **Key Splitting**: The symmetric key is split into $N$ parts using Shamir's Secret Sharing.
5. **Upload**: The encrypted payload is sent to IPFS, and the on-chain registry receives the IPFS hash along with public key records.

No unencrypted files or keys are ever transmitted to external servers.
