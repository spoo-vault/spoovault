# Live Stellar Soroban Integration & Test Coverage

This note documents the live Stellar Soroban integration work completed in `feat/stellar-soroban-live-integration`.

## Live Soroban Transactions
`src/services/stellar.service.ts` now submits real Soroban contract transactions on the Stellar Testnet instead of only falling back to localStorage mocks:

- `createVault`, `addDocument`, `requestAccess`, `approveAccess`, `acceptGuardianInvite`, and `registerPublicKey` build Soroban `InvokeHostFunction` operations via `@stellar/stellar-sdk`, sign them through the Freighter browser extension, submit them to the RPC server, and poll for the result.
- `getVault`, `getDocument`, `fetchVaultsForAccount`, `fetchDocumentsForVaults`, `getPendingInvites`, `fetchPendingApprovalsForGuardian`, and `fetchUserTokens` read live contract state with graceful fallback to the localStorage mock layer when no contract is configured or the RPC is unreachable.
- `@stellar/freighter-api` is loaded lazily via `import(/* @vite-ignore */ "@stellar/freighter-api")` so it is not bundled into the production build and can be shimmed in tests.
- Freighter user rejections are normalized into a friendly "Transaction signing was rejected in Freighter" error that the UI surfaces as an error toast. Non-rejection failures are re-thrown untouched.
- The contract address is configured through `VITE_STELLAR_CONTRACT_ADDRESS` in `.env`; when empty, the service operates in mock mode.

## Testability Seam
Because `vi.mock` cannot intercept native dynamic imports of externalized packages under Vitest's `forks` pool, the service exposes a module-level test seam:

- `__setFreighterModuleForTesting(moduleOrRejection)` injects a fake Freighter module (or rejection) for tests and resets the cached module.
- `invokeSorobanContract` is exported from the module (not the service instance) so tests can drive RPC round-trips directly.

## Test Coverage
`src/__tests__/stellar.service.test.ts` contains 109 tests covering live transactions, RPC polling, SCVal decoding edge cases, Freighter connection/resolution variants, wallet-not-connected guards, and mock-layer behavior. The full Vitest suite is 10 files / 173 tests, all passing.

Coverage is enforced by `vitest.config.ts` (v8 provider, per-file thresholds on `src/services/stellar.service.ts`):

| Metric | Threshold | Actual |
| ------ | --------- | ------ |
| Statements | 90% | 97.9% |
| Branches   | 90% | 95.66% |
| Functions  | 90% | 96.34% |
| Lines      | 90% | 98.09% |

Run it locally with:

```bash
npm run test:coverage
```

The GitHub Actions CI workflow now also runs `npm run test:coverage` to enforce the thresholds on every push and pull request.