import { testWithSynpress } from "@synthetixio/synpress";
import { MetaMask, metaMaskFixtures } from "@synthetixio/synpress/playwright";
import type { MetaMask as MetaMaskType } from "@synthetixio/synpress/playwright";
import basicSetup from "../wallet-setup/spoovault.setup";
import { WALLET_PASSWORD } from "../wallets";

/**
 * Shared Synpress + MetaMask test instance. Every E2E spec imports `test` and
 * `expect` from here so the MetaMask browser cache (built once via
 * `npx synpress e2e/wallet-setup`) is reused across the whole suite.
 */
export const test = testWithSynpress(metaMaskFixtures(basicSetup));

export const expect = test.expect;

/**
 * Custom fixture that exposes a ready-to-use MetaMask controller. Remove the
 * boilerplate of re-instantiating `new MetaMask(...)` in every test.
 */
export const testWithMetaMask = test.extend<{ metamask: MetaMaskType }>({
  metamask: async ({ context, metamaskPage, extensionId }, use) => {
    const metamask = new MetaMask(
      context,
      metamaskPage,
      WALLET_PASSWORD,
      extensionId
    );
    await use(metamask);
  },
});
