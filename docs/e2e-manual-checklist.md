# SpooVault End-to-End Manual Checklist

Use 3 wallets for full validation:

- Owner
- Guardian
- Beneficiary

## 1. Setup

1. Connect all wallets to Avalanche Fuji.
2. Ensure app is connected to contract in `.env`.
3. Run `npm run test:smoke`.

## 2. Owner Flow

1. Create a vault with at least one guardian.
2. Configure threshold and inactivity timer.
3. Upload one encrypted document.
4. Set release condition (`anytime`, `live_only`, `emergency_only`, or `post_death_only`).
5. Download owner backup key.

Expected:

- Vault and document appear in dashboard and lists.
- Upload completes without indefinite loading.

## 3. Guardian Flow

1. Guardian accepts invite in Profile page.
2. Guardian sees pending request in Dashboard approval queue.
3. Guardian approves request.

Expected:

- Request status moves from pending to approved after threshold.

## 4. Beneficiary Flow

1. Owner mints access pass to beneficiary in Access Passes page.
2. Beneficiary opens **My Access** page.
3. Beneficiary requests document access.
4. Owner or guardian exports beneficiary key package from Documents page.
5. Beneficiary imports package using `Import Beneficiary Package`.
6. Beneficiary opens/downloads approved document.

Expected:

- State progression: `No Pass` -> `Can Request` -> `Pending` -> `Key Needed` -> `Ready`.

## 5. Release Policy Checks

1. `live_only`: request should fail once post-death unlock is active.
2. `emergency_only`: request works when emergency mode is on.
3. `post_death_only`: request works after inactivity window passes.

## 6. Reliability Checks

1. During upload, verify status stages are shown.
2. Abort upload before on-chain submission and confirm clean cancellation.
3. Retry upload and confirm success.

## 7. Security Checks

1. Rotate Pinata credentials before production use.
2. Ensure no secrets are committed to git.
3. Verify key package imports only on the intended beneficiary wallet.
