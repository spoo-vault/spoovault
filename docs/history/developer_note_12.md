# Local Development Workspace & System Prerequisites

Ensure the following tools are installed to run SpooVault locally.

## Development Toolkit

- **Node.js**: Version 18+ and npm.
- **Rust Compiler**: Required for compiling Soroban contracts:
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- **Hardhat CLI**: Node package for running local Hardhat nodes and Solidity compilation.
- **freighter Wallet & MetaMask**: Browser extensions set to Testnets.
- **Pinata Account**: API keys for IPFS proxy configuration.
