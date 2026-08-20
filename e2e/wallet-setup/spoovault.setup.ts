import { defineWalletSetup } from "@synthetixio/synpress";
import { MetaMask, getExtensionId } from "@synthetixio/synpress/playwright";
import { TEST_MNEMONIC, WALLET_PASSWORD, ANVIL_RPC_URL, E2E_CHAIN_ID, E2E_CHAIN_NAME, GUARDIAN_PRIVATE_KEY } from "../wallets";

/**
 * One-time MetaMask onboarding used by Synpress to build a cached browser
 * profile. The same seed phrase is used by the local Anvil node so the
 * imported "Account 1" holds funds and is the deployer/creator of the vaults
 * exercised in the E2E suite.
 */
export default defineWalletSetup(WALLET_PASSWORD, async (context, walletPage) => {
  const extensionId = await getExtensionId(context, "MetaMask");

  const metamask = new MetaMask(context, walletPage, WALLET_PASSWORD, extensionId);

  const SEED_PHRASE = TEST_MNEMONIC;

  await metamask.importWallet(SEED_PHRASE);

  // Register the local Anvil network inside MetaMask so the dApp connects to the
  // same chain-id (43113) the app expects for "Avalanche Fuji".
  await metamask.addNetwork({
    name: E2E_CHAIN_NAME,
    rpcUrl: ANVIL_RPC_URL,
    chainId: E2E_CHAIN_ID,
    symbol: "AVAX",
    blockExplorerUrl: "https://testnet.snowtrace.io/",
  });

  // Import the guardian account so multi-guardian approval flows can switch to it.
  await metamask.importWalletFromPrivateKey(GUARDIAN_PRIVATE_KEY);
});
