require("@nomicfoundation/hardhat-toolbox");

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
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  gasReporter: {
    enabled: gasReporterEnabled,
    noColors: true,
    outputFile: "gas-report.txt",
    showMethodSig: false,
  },
  networks: {
    fuji: {
      url: process.env.VITE_AVALANCHE_RPC || "https://api.avax-test.network/ext/bc/C/rpc",
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
