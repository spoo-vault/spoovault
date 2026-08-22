# Contributing to SpooVault

Thank you for your interest in contributing to SpooVault! This project is a **multi-chain encrypted document vault** supporting both **Avalanche (EVM)** and **Stellar (Soroban)** networks. We participate in open-source campaigns on Grantfox.

---

## Project Structure

- `contracts/`: Solidity smart contracts for Avalanche EVM.
- `contracts-stellar/`: Rust smart contracts for Stellar Soroban.
- `src/`: React + Vite frontend application.
  - `src/context/Web3Context.tsx`: Manages multi-chain connections (Metamask for Avalanche, Freighter for Stellar).
  - `src/services/contract.service.ts`: Client service wrapper routing calls to either network.
  - `src/services/stellar.service.ts`: Stellar/Freighter wallet integration service.
  - `src/services/ipfs.service.ts`, `src/services/ipfsGateway.ts` & `src/services/keyInbox.service.ts`: IPFS storage. Uploads use Pinata/proxy; downloads race Pinata, Infura, Cloudflare, and ipfs.io with a per-gateway circuit breaker.

---

## Getting Started

### Prerequisites

1. **Node.js** (v18 or higher) and **npm**
2. **Rust** and **Cargo** (for Stellar/Soroban contracts)
3. **Soroban CLI** (optional, for deploying Soroban contracts locally):
   ```bash
   cargo install --locked soroban-cli
   ```

### Installation

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Set up your environment variables:
   ```bash
   cp .env.example .env
   ```

---

## Developing Smart Contracts

### 1. Avalanche (Solidity + Hardhat)

- Compile contracts:
  ```bash
  npx hardhat compile
  ```
- Run tests:
  ```bash
  npx hardhat test
  ```
- Deploy to Avalanche Fuji testnet:
  ```bash
  npm run deploy:contract
  ```

### 2. Security Analysis (Slither & Mythril)

CI runs [Slither](https://github.com/crytic/slither) and [Mythril](https://github.com/Consensys/mythril) against the Solidity contracts on every pull request. See the "Automated Security Analysis" section of [SECURITY.md](./SECURITY.md) for the exact commands, the current findings policy, and how to reproduce a scan locally before pushing.

### 3. Stellar (Rust + Soroban)

- Navigate to the contract folder:
  ```bash
  cd contracts-stellar
  ```
- Build the contract to WASM:
  ```bash
  cargo build --target wasm32-unknown-unknown --release
  ```
- Run tests:
  ```bash
  cargo test
  ```
- Check test coverage ([cargo-tarpaulin](https://github.com/xd009642/tarpaulin), same as CI):
  ```bash
  cargo install cargo-tarpaulin --locked
  npm run test:stellar:coverage
  ```
  Opens an HTML report at `coverage/tarpaulin-report.html`. CI runs this on every push/PR (see [`coverage.yml`](.github/workflows/coverage.yml)) and uploads the XML/HTML reports as the `soroban-coverage-report` workflow artifact. SpooVault's PR policy targets >=90% line/branch coverage on new or modified contract code.

---

## Developing the Frontend

1. Start the React/Vite development server:
   ```bash
   npm run dev
   ```
2. Start the local Pinata proxy (optional, for testing IPFS uploads without exposing Pinata keys):
   ```bash
   SPOOVUALT_PROXY_SECRET=dev-hmac-secret PINATA_JWT=your_jwt npm run proxy:pinata
   ```
   Set the same value in `VITE_SPOOVUALT_PROXY_SECRET`. Unsigned or cross-origin pin requests are rejected with 403.
3. Use the network switcher in the header sidebar to toggle between Avalanche (MetaMask) and Stellar (Freighter).

---

## Contribution Guidelines

1. **Pick an Issue**: Search the GitHub issues list for items marked `help wanted` or `good first issue`.
2. **Branch Naming**: Create a feature branch named `feature/issue-<number>-description` or `bugfix/issue-<number>-description`.
3. **Write Tests**: If you are changing smart contract logic, ensure tests are updated or added.
4. **Code Styling**: Format your code before submitting a Pull Request.
5. **Submit PR**: Describe your changes in detail and link to the issue you are fixing.
