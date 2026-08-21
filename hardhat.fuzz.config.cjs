require("@nomicfoundation/hardhat-toolbox");
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 } },
  },
  paths: { sources: ".", tests: "test", cache: "cache-fuzz", artifacts: "artifacts-fuzz" },
};
