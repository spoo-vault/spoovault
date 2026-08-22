# Smart Contract Test Execution (Hardhat & Cargo test)

Continuous testing ensures the smart contracts behave correctly before deployment.

## Running Solidity Tests (EVM)

To compile contracts and run the Hardhat test suite:

```bash
npx hardhat compile
npx hardhat test
```

## Running Rust Tests (Soroban)

To execute tests in the Rust Soroban contract:

```bash
cd contracts-stellar
cargo test
```

Tests verify the creation of vaults, invite acceptance, public key registrations, and threshold logic.
