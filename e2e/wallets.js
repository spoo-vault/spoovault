"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.E2E_CHAIN_NAME = exports.E2E_CHAIN_ID = exports.ANVIL_RPC_URL = exports.BENEFICIARY_PRIVATE_KEY = exports.BENEFICIARY_ADDRESS = exports.GUARDIAN_PRIVATE_KEY = exports.GUARDIAN_ADDRESS = exports.DEPLOYER_PRIVATE_KEY = exports.DEPLOYER_ADDRESS = exports.WALLET_PASSWORD = exports.TEST_MNEMONIC = void 0;
exports.privateKeyForIndex = privateKeyForIndex;
var ethers_1 = require("ethers");
/**
 * Deterministic local test wallets derived from the well-known Anvil/Hardhat
 * dev mnemonic. These map 1:1 to the accounts exposed by the local Anvil node
 * started in CI (chain-id 43113) so the MetaMask seed import and the on-chain
 * E2E contract flows share the same funded accounts.
 */
exports.TEST_MNEMONIC = "test test test test test test test test test test test junk";
exports.WALLET_PASSWORD = "Tester@1234";
/** First account = the MetaMask "Account 1" imported from the seed phrase. */
exports.DEPLOYER_ADDRESS = accountAt(0).address;
exports.DEPLOYER_PRIVATE_KEY = accountAt(0).privateKey;
/** Second account = guardian invited to the vault. */
exports.GUARDIAN_ADDRESS = accountAt(1).address;
exports.GUARDIAN_PRIVATE_KEY = accountAt(1).privateKey;
/** Third account = beneficiary that later requests document access. */
exports.BENEFICIARY_ADDRESS = accountAt(2).address;
exports.BENEFICIARY_PRIVATE_KEY = accountAt(2).privateKey;
exports.ANVIL_RPC_URL = "http://localhost:8545";
exports.E2E_CHAIN_ID = 43113;
exports.E2E_CHAIN_NAME = "Avalanche Fuji Testnet";
/** Resolve a private key for a given Anvil account index (0-based). */
function privateKeyForIndex(index) {
    return accountAt(index).privateKey;
}
function accountAt(index) {
    return ethers_1.HDNodeWallet.fromPhrase(exports.TEST_MNEMONIC, "", "m/44'/60'/0'/0/".concat(index));
}
