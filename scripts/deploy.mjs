/**
 * SpooVault Contract Deployment Script
 *
 * Deploys the updated SpooVault.sol to Avalanche Fuji Testnet.
 *
 * Prerequisites:
 *   npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox dotenv
 *   Set DEPLOYER_PRIVATE_KEY in .env
 *
 * Usage:
 *   node scripts/deploy.mjs
 *
 * The script will:
 *   1. Compile the contract via solc (expects ABI + bytecode JSON from hardhat artifacts)
 *   2. Deploy to Fuji using the signer derived from DEPLOYER_PRIVATE_KEY
 *   3. Print the new contract address
 *   4. Remind you to update VITE_CONTRACT_ADDRESS in .env
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load .env manually (no dotenv package required in this script)
const envPath = resolve(__dirname, "../.env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error(
    "\n❌ DEPLOYER_PRIVATE_KEY is not set in .env\n" +
      "   Add: DEPLOYER_PRIVATE_KEY=0x<your_private_key>\n" +
      "   ⚠️  Never commit your private key. Use a throwaway wallet for testnet.\n"
  );
  process.exit(1);
}

const RPC_URL =
  process.env.VITE_AVALANCHE_RPC ||
  "https://api.avax-test.network/ext/bc/C/rpc";

// Hardhat artifacts path (run `npx hardhat compile` first)
const ARTIFACT_PATH = resolve(
  __dirname,
  "../artifacts/contracts/SpooVault.sol/SpooVault.json"
);

if (!existsSync(ARTIFACT_PATH)) {
  console.error(
    "\n❌ Contract artifact not found at:\n   " +
      ARTIFACT_PATH +
      "\n\n" +
      "   Run: npx hardhat compile\n" +
      "   (Install Hardhat first: npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox)\n"
  );
  process.exit(1);
}

const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf-8"));
const { abi, bytecode } = artifact;

// Dynamic import of ethers (already in package.json)
const { ethers } = await import("ethers");

async function main() {
  console.log("\n🚀 SpooVault Deployment Script");
  console.log("================================");
  console.log("Network :", RPC_URL);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log("Deployer:", wallet.address);
  console.log("Balance :", ethers.formatEther(balance), "AVAX");

  if (balance === 0n) {
    console.warn(
      "\n⚠️  Deployer balance is 0 AVAX. Get testnet AVAX from:\n" +
        "   https://core.app/tools/testnet-faucet/\n"
    );
  }

  console.log("\nDeploying SpooVault...");
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy();

  console.log("Tx hash :", contract.deploymentTransaction()?.hash);
  console.log("Waiting for confirmation...");

  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("\n✅ SpooVault deployed at:", address);
  console.log("\n📝 Next steps:");
  console.log("   1. Update your .env file:");
  console.log("      VITE_CONTRACT_ADDRESS=" + address);
  console.log("   2. Get the deploy block from Snowtrace:");
  console.log("      https://testnet.snowtrace.io/address/" + address);
  console.log("      VITE_CONTRACT_DEPLOY_BLOCK=<block_number>");
  console.log("   3. Rebuild and redeploy the frontend.\n");
}

main().catch((err) => {
  console.error("\n❌ Deployment failed:", err.message || err);
  process.exit(1);
});
