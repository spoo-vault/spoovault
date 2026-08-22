import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import { ANVIL_RPC_URL, privateKeyForIndex } from "../wallets";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

const ABI = [
  "function createVault(string name, string description, address[] guardians, uint256 approvalThreshold) external returns (uint256)",
  "function acceptGuardianInvite(uint256 vaultId) external",
  "function addDocumentWithReleaseCondition(uint256 vaultId, string encryptedMetadata, string ipfsHash, uint8 requiredAccess, uint8 releaseCondition) external returns (uint256)",
  "function mintAccessToken(uint256 vaultId, address to, string tokenURIValue) external returns (uint256)",
  "function requestAccess(uint256 documentId) external returns (uint256)",
  "function approveAccess(uint256 requestId) external",
  "function isGuardian(uint256 vaultId, address guardian) external view returns (bool)",
  "function hasActiveAccess(uint256 documentId, address user) external view returns (bool)",
  "function setEmergencyMode(uint256 vaultId, bool enabled) external",
  "function configureVaultRelease(uint256 vaultId, uint256 inactivityPeriod) external",
  "function proveLife(uint256 vaultId) external",
  "function getVaultReleaseState(uint256 vaultId) external view returns (bool emergencyMode, uint256 inactivityPeriod, uint256 lastProofOfLife, bool postDeathUnlocked)",
  "event VaultCreated(uint256 indexed vaultId, address indexed creator, string name)",
  "event DocumentAdded(uint256 indexed documentId, uint256 indexed vaultId, string ipfsHash)",
  "event AccessRequested(uint256 indexed requestId, uint256 indexed documentId, address indexed requester)",
  "event EmergencyModeUpdated(uint256 indexed vaultId, bool enabled)",
  "event VaultReleaseConfigured(uint256 indexed vaultId, uint256 inactivityPeriod)",
  "event ProofOfLifeRecorded(uint256 indexed vaultId, address indexed owner, uint256 timestamp)",
];

const ReleaseCondition = {
  ANYTIME: 0,
  LIVE_ONLY: 1,
  EMERGENCY_ONLY: 2,
  POST_DEATH_ONLY: 3,
} as const;

const DAY = 24 * 60 * 60;

function loadContractAddress(): string {
  const envPath = resolve(repoRoot, "e2e", ".env.e2e");
  const text = readFileSync(envPath, "utf8");
  const match = text.match(/VITE_CONTRACT_ADDRESS=(0x[0-9a-fA-F]+)/);
  if (!match) {
    throw new Error(
      "e2e/.env.e2e not found. Run `node e2e/scripts/deploy-anvil.mjs` first."
    );
  }
  return match[1];
}

async function extractEventId(
  receipt: any,
  contract: Contract,
  eventName: string
): Promise<bigint | undefined> {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === eventName) {
        return parsed.args[0];
      }
    } catch {
      /* ignore unrelated logs */
    }
  }
  return undefined;
}

async function increaseTime(provider: JsonRpcProvider, seconds: number) {
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
}

test.describe("SpooVault — emergency mode & post-death document release (EVM contract E2E)", () => {
  test("emergency mode trigger enables EMERGENCY_ONLY document release", async () => {
    const provider = new JsonRpcProvider(ANVIL_RPC_URL);
    const deployer = new Wallet(privateKeyForIndex(0), provider);
    const guardian = new Wallet(privateKeyForIndex(1), provider);
    const beneficiary = new Wallet(privateKeyForIndex(2), provider);

    const address = loadContractAddress();
    const contract = new Contract(address, ABI, deployer);
    const guardianContract = new Contract(address, ABI, guardian);
    const beneficiaryContract = new Contract(address, ABI, beneficiary);

    // 1) Creator deploys a vault with the guardian invited.
    const createTx = await contract.createVault(
      "Emergency E2E Vault",
      "emergency mode release flow",
      [guardian.address],
      1
    );
    const createReceipt = await createTx.wait();
    const vaultId = await extractEventId(
      createReceipt,
      contract,
      "VaultCreated"
    );
    expect(vaultId).toBeDefined();
    expect(vaultId).toBeGreaterThan(0);

    // 2) Guardian accepts the invitation.
    await (await guardianContract.acceptGuardianInvite(vaultId)).wait();
    expect(await contract.isGuardian(vaultId, guardian.address)).toBe(true);

    // 3) Guardian mints an access token for the beneficiary (required to request documents).
    await (
      await guardianContract.mintAccessToken(
        vaultId,
        beneficiary.address,
        "e2e-emergency-uri"
      )
    ).wait();

    // 4) Guardian adds a document gated behind EMERGENCY_ONLY release condition.
    const docTx = await guardianContract.addDocumentWithReleaseCondition(
      vaultId,
      "encrypted-meta",
      "ipfs://e2e-emergency-document",
      0,
      ReleaseCondition.EMERGENCY_ONLY
    );
    const docReceipt = await docTx.wait();
    const documentId = await extractEventId(
      docReceipt,
      contract,
      "DocumentAdded"
    );
    expect(documentId).toBeDefined();
    expect(documentId).toBeGreaterThan(0);

    // 5) Beneficiary cannot request access while emergency mode is OFF (ReleaseConditionLocked).
    await expect(
      beneficiaryContract.requestAccess(documentId)
    ).rejects.toThrow();

    // 6) Creator triggers emergency mode.
    const emergTx = await contract.setEmergencyMode(vaultId, true);
    const emergReceipt = await emergTx.wait();
    const state = await contract.getVaultReleaseState(vaultId);
    expect(state.emergencyMode).toBe(true);

    // 7) Beneficiary can now request access and the guardian approves.
    const reqTx = await beneficiaryContract.requestAccess(documentId);
    const reqReceipt = await reqTx.wait();
    const requestId = await extractEventId(
      reqReceipt,
      contract,
      "AccessRequested"
    );
    expect(requestId).toBeDefined();
    expect(requestId).toBeGreaterThan(0);

    await (await guardianContract.approveAccess(requestId)).wait();

    // 8) Beneficiary now has active access.
    expect(
      await contract.hasActiveAccess(documentId, beneficiary.address)
    ).toBe(true);
  });

  test("post-death release unlocks POST_DEATH_ONLY documents after inactivity period", async () => {
    const provider = new JsonRpcProvider(ANVIL_RPC_URL);
    const deployer = new Wallet(privateKeyForIndex(0), provider);
    const guardian = new Wallet(privateKeyForIndex(1), provider);
    const beneficiary = new Wallet(privateKeyForIndex(2), provider);

    const address = loadContractAddress();
    const contract = new Contract(address, ABI, deployer);
    const guardianContract = new Contract(address, ABI, guardian);
    const beneficiaryContract = new Contract(address, ABI, beneficiary);

    // 1) Creator deploys a vault.
    const createTx = await contract.createVault(
      "PostDeath E2E Vault",
      "post-death release flow",
      [guardian.address],
      1
    );
    const createReceipt = await createTx.wait();
    const vaultId = await extractEventId(
      createReceipt,
      contract,
      "VaultCreated"
    );
    expect(vaultId).toBeDefined();

    // 2) Configure a 1-day inactivity period (minimum allowed by the contract).
    await (await contract.configureVaultRelease(vaultId, DAY)).wait();
    const stateBefore = await contract.getVaultReleaseState(vaultId);
    expect(stateBefore.inactivityPeriod).toBe(BigInt(DAY));
    expect(stateBefore.postDeathUnlocked).toBe(false);

    // 3) Guardian accepts invite, mints token, and adds a POST_DEATH_ONLY document.
    await (await guardianContract.acceptGuardianInvite(vaultId)).wait();
    expect(await contract.isGuardian(vaultId, guardian.address)).toBe(true);

    await (
      await guardianContract.mintAccessToken(
        vaultId,
        beneficiary.address,
        "e2e-postdeath-uri"
      )
    ).wait();

    const docTx = await guardianContract.addDocumentWithReleaseCondition(
      vaultId,
      "encrypted-meta",
      "ipfs://e2e-postdeath-document",
      0,
      ReleaseCondition.POST_DEATH_ONLY
    );
    const docReceipt = await docTx.wait();
    const documentId = await extractEventId(
      docReceipt,
      contract,
      "DocumentAdded"
    );
    expect(documentId).toBeDefined();

    // 4) Beneficiary cannot request access while not post-death.
    await expect(
      beneficiaryContract.requestAccess(documentId)
    ).rejects.toThrow();

    // 5) Simulate time passing beyond the inactivity window.
    await increaseTime(provider, DAY * 2);

    // 6) Post-death is now unlocked.
    const stateAfter = await contract.getVaultReleaseState(vaultId);
    expect(stateAfter.postDeathUnlocked).toBe(true);

    // 7) Beneficiary requests access; guardian approves.
    const reqTx = await beneficiaryContract.requestAccess(documentId);
    const reqReceipt = await reqTx.wait();
    const requestId = await extractEventId(
      reqReceipt,
      contract,
      "AccessRequested"
    );
    expect(requestId).toBeDefined();

    await (await guardianContract.approveAccess(requestId)).wait();

    // 8) Beneficiary has active access.
    expect(
      await contract.hasActiveAccess(documentId, beneficiary.address)
    ).toBe(true);
  });

  test("creator can record proof of life to keep vault in live mode", async () => {
    const provider = new JsonRpcProvider(ANVIL_RPC_URL);
    const deployer = new Wallet(privateKeyForIndex(0), provider);
    const guardian = new Wallet(privateKeyForIndex(1), provider);

    const address = loadContractAddress();
    const contract = new Contract(address, ABI, deployer);
    const guardianContract = new Contract(address, ABI, guardian);

    // 1) Creator deploys a vault.
    const createTx = await contract.createVault(
      "Heartbeat E2E Vault",
      "proof-of-life flow",
      [guardian.address],
      1
    );
    const createReceipt = await createTx.wait();
    const vaultId = await extractEventId(
      createReceipt,
      contract,
      "VaultCreated"
    );
    expect(vaultId).toBeDefined();

    // 2) Creator records proof of life.
    const tx = await contract.proveLife(vaultId);
    await tx.wait();

    // 3) State should reflect an updated lastProofOfLife.
    const state = await contract.getVaultReleaseState(vaultId);
    expect(state.lastProofOfLife).toBeGreaterThan(0);
    expect(state.emergencyMode).toBe(false);
  });
});
