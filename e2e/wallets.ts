import { HDNodeWallet } from "ethers";

/**
 * Deterministic local test wallets derived from the well-known Anvil/Hardhat
 * dev mnemonic. These map 1:1 to the accounts exposed by the local Anvil node
 * started in CI (chain-id 43113) so the MetaMask seed import and the on-chain
 * E2E contract flows share the same funded accounts.
 */
export const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

export const WALLET_PASSWORD = "Tester@1234";

/** First account = the MetaMask "Account 1" imported from the seed phrase. */
export const DEPLOYER_ADDRESS = accountAt(0).address;
export const DEPLOYER_PRIVATE_KEY = accountAt(0).privateKey;

/** Second account = guardian invited to the vault. */
export const GUARDIAN_ADDRESS = accountAt(1).address;
export const GUARDIAN_PRIVATE_KEY = accountAt(1).privateKey;

/** Third account = beneficiary that later requests document access. */
export const BENEFICIARY_ADDRESS = accountAt(2).address;
export const BENEFICIARY_PRIVATE_KEY = accountAt(2).privateKey;

export const ANVIL_RPC_URL = "http://localhost:8545";
export const E2E_CHAIN_ID = 43113;
export const E2E_CHAIN_NAME = "Avalanche Fuji Testnet";

/** Resolve a private key for a given Anvil account index (0-based). */
export function privateKeyForIndex(index: number): string {
  const hd = HDNodeWallet.fromPhrase(TEST_MNEMONIC);
  const child = hd.derivePath(`m/44'/60'/0'/0/${index}`);
  return child.privateKey;
}

function accountAt(index: number): HDNodeWallet {
  return HDNodeWallet.fromPhrase(TEST_MNEMONIC, "", `m/44'/60'/0'/0/${index}`);
}
