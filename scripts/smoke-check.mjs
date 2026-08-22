import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ethers } from "ethers";

const root = process.cwd();
const envPath = path.join(root, ".env");
const envExamplePath = path.join(root, ".env.example");

const readEnvFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const env = {};
  for (const line of lines) {
    if (!line || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    env[key] = value;
  }
  return env;
};

const localEnv = readEnvFile(envPath);
const sampleEnv = readEnvFile(envExamplePath);
const env = { ...sampleEnv, ...localEnv };

const rpc = env.VITE_AVALANCHE_RPC;
const address = env.VITE_CONTRACT_ADDRESS;
const deployBlock = Number(env.VITE_CONTRACT_DEPLOY_BLOCK || "0");

if (!rpc) {
  console.log("SKIP: Missing VITE_AVALANCHE_RPC in .env");
  process.exit(0);
}
if (!address || !ethers.isAddress(address)) {
  console.log("SKIP: Missing or invalid VITE_CONTRACT_ADDRESS in .env");
  process.exit(0);
}

const provider = new ethers.JsonRpcProvider(rpc);

const assertStep = async (name, fn) => {
  try {
    const value = await fn();
    console.log(`PASS: ${name}${value ? ` -> ${value}` : ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL: ${name} -> ${message}`);
    process.exit(1);
  }
};

let latestBlock = null;
try {
  latestBlock = await provider.getBlockNumber();
  console.log(`PASS: RPC reachable -> latest block ${latestBlock}`);
} catch {
  console.log("SKIP: RPC unreachable from current environment");
  process.exit(0);
}

await assertStep("Contract address checksum", async () =>
  ethers.getAddress(address)
);

await assertStep("Contract code exists", async () => {
  const code = await provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error("No contract code at configured address");
  }
  return `${Math.max(0, (code.length - 2) / 2)} bytes`;
});

await assertStep("Read totalSupply()", async () => {
  const abi = ["function totalSupply() view returns (uint256)"];
  const contract = new ethers.Contract(address, abi, provider);
  const supply = await contract.totalSupply();
  return supply.toString();
});

if (deployBlock > 0) {
  await assertStep("Deploy block sanity", async () => {
    const latest = latestBlock ?? (await provider.getBlockNumber());
    if (deployBlock > latest) {
      throw new Error(
        `deploy block ${deployBlock} is above latest block ${latest}`
      );
    }
    return `${deployBlock}`;
  });
}

console.log("PASS: Smoke check complete");
