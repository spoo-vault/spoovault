import { test, expect } from "../support/test-with-metamask";
import { E2E_CHAIN_NAME } from "../wallets";

test.describe("SpooVault — wallet connection (EVM / MetaMask)", () => {
  test("connects MetaMask to the dApp and reflects the connected account", async ({
    page,
    metamask,
  }) => {
    await page.goto("/vaults");

    // The header starts in a disconnected state.
    await expect(page.getByText("Wallet Disconnected")).toBeVisible();

    // Trigger the in-app connect flow (shows the MetaMask connection prompt).
    await page
      .getByRole("button", { name: /Connect Wallet/i })
      .first()
      .click();

    // Approve the connection request inside the MetaMask extension.
    await metamask.connectToDapp();

    // Point MetaMask at the local Anvil network (chain-id 43113 == Fuji in the app).
    await metamask.switchNetwork(E2E_CHAIN_NAME, true);

    // The dApp now shows a connected, on-network status and the shortened address.
    await expect(page.getByText(/Avalanche Fuji Online/i)).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText(/0x[a-fA-F0-9]{4}\.\.\.[a-fA-F0-9]{4}/)
    ).toBeVisible();
  });
});
