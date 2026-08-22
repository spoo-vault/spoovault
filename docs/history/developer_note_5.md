# EVM Contract Specifications (Solidity + Hardhat)

The EVM smart contract logic is implemented in Solidity (`contracts/SpooVault.sol`).

## Core Functions

- `createVault(string name, string description, address[] guardians, uint256 threshold)`: Initializes a vault record.
- `addDocument(uint256 vaultId, string encryptedMetadata, string ipfsHash, uint8 requiredAccess)`: Adds a document reference.
- `requestAccess(uint256 documentId)`: Registers a beneficiary access request.
- `approveAccess(uint256 requestId, string encryptedShare)`: Signs off on a request and uploads the SSS share encrypted for the beneficiary.
- `acceptGuardianInvite(uint256 vaultId)`: Registers acceptance of a guardian role.

The EVM system is compiled and deployed locally using Hardhat and ethers.js.
