# Vault Access & Multi-Sig Approval Workflows

The vault access workflow ensures that documents can only be unlocked through consensus.

## Workflow Phases

1. **Access Request**: The beneficiary navigates to "My Access" and triggers a request for a document.
2. **Guardian Notification**: Guardians log in and see pending requests for vaults they guard.
3. **Guardian Approval**: The guardian retrieves their encrypted SSS share from the key inbox, decrypts it locally using their private key, re-encrypts it with the beneficiary's public key, and registers it on-chain via the `approveAccess` contract call.
4. **Key Assembly**: Once the threshold is met, the beneficiary downloads the encrypted shares, decrypts them, reconstructs the key, and unlocks the file.
