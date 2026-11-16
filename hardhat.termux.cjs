require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

// Enable the gas reporter only when requested (CI gas-profiling job sets
// REPORT_GAS=true). It emits a parseable plain-text report to gas-report.txt.
const gasReporterEnabled = process.env.REPORT_GAS === "true";
if (gasReporterEnabled) {
  require("hardhat-gas-reporter");
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "cancun",
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 1,
      },
      // Dropping the CBOR metadata hash from deployed bytecode buys back size
      // margin against the EIP-170 24,576-byte contract-size limit at zero
      // gas/behavior cost — SpooVault.sol otherwise compiles to within a few
      // bytes of that cap.
      metadata: {
        bytecodeHash: "none",
      },
      // Requests solc's storageLayout output (slot/offset per state
      // variable) into artifacts/build-info/*.json so storage packing can be
      // inspected/verified without a separate plugin — see
      // scripts/print-storage-layout.mjs.
      outputSelection: {
        "*": {
          "*": ["storageLayout"],
        },
      },
    },
  },
  gasReporter: {
    enabled: gasReporterEnabled,
    noColors: true,
    outputFile: "gas-report.txt",
    showMethodSig: true,
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
    },
    fuji: {
      url:
        process.env.VITE_AVALANCHE_RPC ||
        "https://api.avax-test.network/ext/bc/C/rpc",
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
      chainId: 43113,
    },
    avalanche: {
      url: "https://api.avax.network/ext/bc/C/rpc",
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
      chainId: 43114,
    },
  },
};
