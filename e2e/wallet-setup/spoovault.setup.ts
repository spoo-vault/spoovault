import { defineWalletSetup } from "@synthetixio/synpress";
import { MetaMask, getExtensionId } from "@synthetixio/synpress/playwright";
import { TEST_MNEMONIC, WALLET_PASSWORD } from "../wallets";

export default defineWalletSetup(WALLET_PASSWORD, async (context, walletPage) => {
  const extensionId = await getExtensionId(context, "MetaMask");
  const metamask = new MetaMask(context, walletPage, WALLET_PASSWORD, extensionId);
  await metamask.importWallet(TEST_MNEMONIC);
});
