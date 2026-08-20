import { test, expect } from "../support/test-with-metamask";
import { E2E_CHAIN_NAME, GUARDIAN_ADDRESS } from "../wallets";

test.describe("SpooVault — vault creation flow (EVM / MetaMask)", () => {
  test("creates a vault through the UI and submits the on-chain transaction", async ({
    page,
    metamask,
  }) => {
    await page.goto("/vaults");

    // Connect MetaMask and select the local Anvil (Fuji-equivalent) network.
    await page.getByRole("button", { name: /Connect Wallet/i }).first().click();
    await metamask.connectToDapp();
    await metamask.switchNetwork(E2E_CHAIN_NAME, true);
    await expect(page.getByText(/Avalanche Fuji Online/i)).toBeVisible({
      timeout: 30_000,
    });

    // Open the create-vault modal directly via the deep link the app listens for.
    await page.goto("/vaults?create=true");
    await expect(
      page.getByPlaceholder(/Family Estate Records/i),
    ).toBeVisible({ timeout: 15_000 });

    const vaultName = `E2E Vault ${Date.now()}`;
    await page.getByPlaceholder(/Family Estate Records/i).fill(vaultName);
    await page
      .getByPlaceholder(/Describe which files/i)
      .fill("E2E automated encrypted document vault");

    // Add a guardian (validated Ethereum address).
    await page
      .getByPlaceholder(/guardian's Ethereum address/i)
      .fill(GUARDIAN_ADDRESS);
    await page.getByRole("button", { name: /^Add$/i }).click();
    await expect(page.getByText(GUARDIAN_ADDRESS)).toBeVisible();

    // Submit -> MetaMask transaction (createVault, followed by configureVaultRelease).
    await page
      .getByRole("button", { name: /Create Access Vault/i })
      .last()
      .click();

    await metamask.confirmTransaction();
    // configureVaultRelease is sent immediately after the vault is created.
    await page.waitForTimeout(2500);
    await metamask.confirmTransaction();

    await expect(page.getByText(/created successfully/i)).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(vaultName)).toBeVisible();
  });
});
