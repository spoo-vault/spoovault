# Web3 E2E Test Suite (Synpress + Playwright)

Automated end-to-end tests for SpooVault's wallet-connected flows, added for
issue **#161**. The suite exercises the dApp against real local chains:

- **EVM** — Anvil (local, chain-id `43113`) + the deployed `SpooVault.sol`
  contract, driven through the real **MetaMask** extension via **Synpress v4**.
- **Stellar** — a Soroban standalone network (`stellar/quickstart`) with the
  `spoovault_stellar` contract built, deployed, and exercised end-to-end through
  the `stellar` CLI.

## Layout

```
e2e/
  wallets.ts                     # deterministic Anvil dev wallets (shared seed)
  wallet-setup/spoovault.setup.ts  # one-time MetaMask onboarding (Synpress cache)
  support/test-with-metamask.ts  # shared Synpress + MetaMask test instance
  tests/
    01-connect-wallet.spec.ts    # connect MetaMask -> dApp reflects account
    02-create-vault.spec.ts      # create vault via UI + confirm on-chain tx
    03-guardian-access.spec.ts   # multi-guardian accept/request/approve (contract E2E)
  scripts/deploy-anvil.mjs       # deploy SpooVault to Anvil, write e2e/.env.e2e
  soroban/soroban-flow.test.mjs  # Soroban standalone contract E2E (node:test)
playwright.config.ts             # Playwright/Synpress config (videos + traces)
.github/workflows/e2e.yml       # CI: e2e-evm + e2e-stellar jobs
```

## Local run (EVM)

```bash
# 1. Start a local Anvil node matching the app's Fuji expectations.
anvil --chain-id 43113 \
  --mnemonic "test test test test test test test test test test test junk" \
  --accounts 10 --balance 10000

# 2. Deploy SpooVault and write e2e/.env.e2e (contract address + RPC).
node e2e/scripts/deploy-anvil.mjs

# 3. Build the app with the E2E env so VITE_CONTRACT_ADDRESS is injected.
set -a; . ./e2e/.env.e2e; set +a
npm run build

# 4. Build the MetaMask browser cache once.
npm run e2e:install

# 5. Run the E2E suite (headless).
HEADLESS=true npm run e2e:evm
```

The wallet seed is the well-known Anvil dev mnemonic, so MetaMask "Account 1"
(`0xf39Fd6e51aad88F6F4ce6ab8827279cffFb92266`) is the deployer/creator and holds
funds. A second account is imported as the guardian.

## Local run (Stellar)

```bash
# Start a standalone network (friendbot available for funding).
docker run -d --name soroban -p 8000:8000 stellar/quickstart standalone
export SOROBAN_RPC_URL=http://localhost:8000
npm run e2e:stellar
```

This builds the wasm, deploys it, and runs the full
`create_vault -> accept_guardian_invite -> add_document -> request_access ->
approve_access` flow, asserting each returned id/state.

## CI

`.github/workflows/e2e.yml` runs two jobs:

- `e2e-evm` — installs Foundry (anvil) + Playwright browsers, compiles the
  Hardhat contracts, builds the MetaMask cache, starts Anvil, deploys the
  contract, builds the app, and runs the Synpress suite headlessly. Videos and
  Playwright traces are uploaded as artifacts on every run.
- `e2e-stellar` — starts a Soroban standalone network and runs the Soroban
  contract E2E (best-effort; does not block the EVM verification).

## Notes / limitations

- The Stellar E2E drives the **contract** through the `stellar` CLI (Freighter
  has no Synpress support); a full Freighter-UI E2E would require a custom
  Playwright extension harness and is out of scope here.
- The EVM UI tests require the MetaMask browser cache to be built
  (`npm run e2e:install`) before `npm run e2e:evm`; CI does this automatically.
