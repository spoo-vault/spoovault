# Security Auditing & Code Hardening Standards

Secure development practices are fundamental to document custody security.

## Code Standards

- **Solidity**: Follows CEI (Checks-Effects-Interactions) patterns to prevent re-entrancy attacks.
- **Rust**: Minimizes panic boundaries and validates authorization via `Address::require_auth()` before any state mutation.
- **Zero Local Logs**: Decryption keys and unencrypted file buffers are cleared from browser memory as soon as the file download/assembly is completed.
