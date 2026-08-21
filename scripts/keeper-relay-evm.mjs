/**
 * SpooVault Web3 Keeper Heartbeat Relay (EVM / Avalanche)
 *
 * Reference implementation of the off-chain half of the EIP-712 keeper
 * delegation flow added for the proof-of-life relay feature: a Chainlink
 * Automation "custom logic" upkeep or a Gelato Web3 Function periodically
 * runs a job like this one to call `proveLifeByKeeper(vaultId)` on behalf of
 * a vault owner who has already delegated to this keeper via
 * `authorizeKeeperBySig`, so the owner's dead-man's-switch never trips just
 * because they didn't personally send a transaction.
 *
 * This script only performs the keeper's half of the job (checking whether a
 * heartbeat is due and relaying it). Producing the initial EIP-712
 * authorization signature is the vault owner's action, done once from their
 * own wallet (e.g. via `contractService.signKeeperAuthorization`); the
 * resulting signature is then submitted on-chain once via
 * `contractService.relayKeeperAuthorization` (by the keeper or anyone else)
 * before this job can relay heartbeats.
 *
 * Prerequisites:
 *   Set in .env:
 *     KEEPER_PRIVATE_KEY=0x<keeper wallet private key>
 *     VITE_CONTRACT_ADDRESS=<deployed SpooVault address>
 *     VITE_AVALANCHE_RPC=<RPC url> (optional, defaults to Fuji testnet)
 *
 * Usage:
 *   node scripts/keeper-relay-evm.mjs <vaultId> [vaultId...]
 *
 * For each vault id, the script only submits a relay transaction if this
 * keeper is still an authorized, unexpired delegate for that vault AND the
 * vault is past `HEARTBEAT_SAFETY_MARGIN_RATIO` of its inactivity window —
 * mirroring how a real Chainlink Automation `checkUpkeep` would gate whether
 * `performUpkeep` runs, instead of relaying on every single invocation.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

const KEEPER_PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.VITE_CONTRACT_ADDRESS;
const RPC_URL = process.env.VITE_AVALANCHE_RPC || "https://api.avax-test.network/ext/bc/C/rpc";

// Only the heartbeat-relay surface of SpooVault.sol is needed here.
const RELAY_ABI = [
  "function proveLifeByKeeper(uint256 vaultId) external",
  "function keeperAuthorizations(uint256 vaultId) external view returns (address keeper, uint256 expiresAt)",
  "function getVaultReleaseState(uint256 vaultId) external view returns (bool emergencyMode, uint256 inactivityPeriod, uint256 lastProofOfLife, bool postDeathUnlocked)",
];

// Relay once the vault has used up this fraction of its inactivity window,
// rather than waiting until it is nearly dead.
const HEARTBEAT_SAFETY_MARGIN_RATIO = 0.5;

async function checkAndRelay(contract, keeperAddress, vaultId) {
  const authorization = await contract.keeperAuthorizations(vaultId);
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (authorization.keeper.toLowerCase() !== keeperAddress.toLowerCase()) {
    console.log(`Vault ${vaultId}: this keeper is not authorized. Skipping.`);
    return;
  }
  if (Number(authorization.expiresAt) <= nowSeconds) {
    console.log(`Vault ${vaultId}: keeper authorization expired. Skipping.`);
    return;
  }

  const state = await contract.getVaultReleaseState(vaultId);
  const elapsed = nowSeconds - Number(state.lastProofOfLife);
  const dueAt = Number(state.inactivityPeriod) * HEARTBEAT_SAFETY_MARGIN_RATIO;

  if (elapsed < dueAt) {
    console.log(`Vault ${vaultId}: heartbeat not due yet (${elapsed}s / ${dueAt}s). Skipping.`);
    return;
  }

  console.log(`Vault ${vaultId}: heartbeat due (${elapsed}s elapsed). Relaying...`);
  const tx = await contract.proveLifeByKeeper(vaultId);
  const receipt = await tx.wait();
  console.log(`Vault ${vaultId}: relayed in tx ${receipt.hash}`);
}

async function main() {
  const vaultIds = process.argv.slice(2).map(Number);
  if (vaultIds.length === 0 || vaultIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    console.error("Usage: node scripts/keeper-relay-evm.mjs <vaultId> [vaultId...]");
    process.exit(1);
  }
  if (!KEEPER_PRIVATE_KEY) {
    console.error("KEEPER_PRIVATE_KEY is not set in .env");
    process.exit(1);
  }
  if (!CONTRACT_ADDRESS) {
    console.error("VITE_CONTRACT_ADDRESS is not set in .env");
    process.exit(1);
  }

  const { ethers } = await import("ethers");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const keeper = new ethers.Wallet(KEEPER_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, RELAY_ABI, keeper);

  console.log(`Keeper address: ${keeper.address}`);
  for (const vaultId of vaultIds) {
    await checkAndRelay(contract, keeper.address, vaultId);
  }
}

main().catch((err) => {
  console.error("Keeper relay failed:", err.message || err);
  process.exit(1);
});
