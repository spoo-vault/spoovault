# Automated Web3 E2E Test Suite (Synpress, Playwright, Anvil/Soroban)

## Summary

Closes #161 by adding a runnable, automated end-to-end test suite for SpooVault's
wallet-connected flows. The suite drives the dApp against real local chains:

- **EVM** — a local **Anvil** node (chain-id `43113`) with the freshly deployed
  `SpooVault.sol` contract, exercised through the real **MetaMask** extension
  using **Synpress v4** (Playwright + MetaMask).
- **Stellar** — a **Soroban standalone** network (`stellar/quickstart`) with the
  `spoovault_stellar` contract built, deployed, and exercised end-to-end via the
  `stellar` CLI.

## Approach

- `e2e/wallet-setup/spoovault.setup.ts` — one-time MetaMask onboarding
  (import seed, register the local Anvil network, import the guardian account)
  cached by Synpress so the whole suite reuses a single browser profile.
- `e2e/support/test-with-metamask.ts` — shared Synpress + MetaMask test instance.
- `e2e/scripts/deploy-anvil.mjs` — deploys `SpooVault` to Anvil and writes
  `e2e/.env.e2e` with `VITE_CONTRACT_ADDRESS` / RPC / chain-id so the app is
  built against controlled on-chain state.
- `e2e/tests/01-connect-wallet.spec.ts` — connects MetaMask and asserts the dApp
  reflects the connected account and "Avalanche Fuji Online" status.
- `e2e/tests/02-create-vault.spec.ts` — opens the create-vault modal, submits the
  form, confirms the on-chain `createVault` (+ `configureVaultRelease`)
  transactions in MetaMask, and asserts the success toast + vault in the UI.
- `e2e/tests/03-guardian-access.spec.ts` — contract-level E2E verifying the full
  multi-guardian flow: `createVault` → `acceptGuardianInvite` → `mintAccessToken`
  → `addDocument` → `requestAccess` → `approveAccess`, asserting on-chain state
  at each step (guardian activation + `hasActiveAccess`).
- `e2e/soroban/soroban-flow.test.mjs` — Soroban standalone contract E2E:
  `create_vault → accept_guardian_invite → add_document → request_access →
  approve_access`, asserting the returned ids/states.
- `playwright.config.ts` — Playwright/Synpress config with `video` and `trace`
  set to `retain-on-failure` and HTML reporting.
- `.github/workflows/e2e.yml` — `e2e-evm` (Foundry/anvil + Playwright + Synpress
  cache + deploy + build + run, uploads videos/traces) and `e2e-stellar`
  (standalone network + Soroban contract E2E, best-effort).

## Test plan

1. `anvil --chain-id 43113 --mnemonic "test … junk" --accounts 10 --balance 10000`
2. `node e2e/scripts/deploy-anvil.mjs` (writes `e2e/.env.e2e`)
3. `set -a; . ./e2e/.env.e2e; set +a; npm run build`
4. `npm run e2e:install` (builds the MetaMask cache)
5. `HEADLESS=true npm run e2e:evm`
6. `docker run -d --name soroban -p 8000:8000 stellar/quickstart standalone && npm run e2e:stellar`

## Verification performed here

- `actionlint` on `.github/workflows/e2e.yml` — **passes**.
- `tsc -p e2e/tsconfig.json --noEmit` on all E2e TypeScript — **passes**.
- `node --check` on both `.mjs` scripts — **passes**.
- `npx hardhat compile --config hardhat.config.cjs` — **compiles** (artifact used
  by the deploy script).
- Derived Anvil account #0 (`0xf39Fd6e51aad88F6F4ce6ab8827279cffFb92266`) matches
  the MetaMask seed import and the deployer key.

## Notes / limitations

- The Stellar E2E drives the **contract** through the `stellar` CLI because
  Freighter has no Synpress support; a full Freighter-UI E2E would need a custom
  Playwright extension harness and is intentionally out of scope. The EVM UI
  flows (connect wallet + submit transaction) are the headline Synpress coverage.
- The `e2e-stellar` CI job is `continue-on-error` so a Soroban-network hiccup does
  not block the required EVM verification.

Closes #161
