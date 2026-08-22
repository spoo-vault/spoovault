import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JsonRpcProvider, NonceManager, Wallet, Contract } from "ethers";
import { ANVIL_RPC_URL, privateKeyForIndex } from "../wallets";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

/**
 * Minimal ABI covering only the functions exercised by the multi-guardian
 * access-approval E2E. This keeps the test independent of the Hardhat build
 * output while still driving the *deployed* SpooVault contract on the local
 * Anvil network.
 */
const ABI = [
  "function createVault(string name, string description, address[] guardians, uint256 approvalThreshold) external returns (uint256)",
  "function acceptGuardianInvite(uint256 vaultId) external",
  "function mintAccessToken(uint256 vaultId, address to, string tokenURIValue) external returns (uint256)",
  "function addDocument(uint256 vaultId, string encryptedMetadata, string ipfsHash, uint8 requiredAccess) external returns (uint256)",
  "function requestAccess(uint256 documentId) external returns (uint256)",
  "function approveAccess(uint256 requestId) external",
  "function isGuardian(uint256 vaultId, address guardian) external view returns (bool)",
  "function hasActiveAccess(uint256 documentId, address user) external view returns (bool)",
  "event VaultCreated(uint256 indexed vaultId, address indexed creator, string name)",
  "event DocumentAdded(uint256 indexed documentId, uint256 indexed vaultId, string ipfsHash)",
  "event AccessRequested(uint256 indexed requestId, uint256 indexed documentId, address indexed requester)",
];

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

function firstArg(parsed: any, name: string): any {
  if (parsed?.name === name) return parsed.args[0];
  return undefined;
}

test.describe("SpooVault — multi-guardian access approval (EVM contract E2E)", () => {
  test("guardian accepts invite, beneficiary requests and is granted access", async () => {
    const provider = new JsonRpcProvider(ANVIL_RPC_URL);
    // NonceManager keeps local nonce state: the automining node mines a block
    // per transaction and ethers' provider-side count cache can go stale
    // between rapid successive sends from the same account. The raw wallets
    // stay available because NonceManager does not expose `.address`.
    const mkSigner = (index: number) => {
      const wallet = new Wallet(privateKeyForIndex(index), provider);
      return { wallet, signer: new NonceManager(wallet) };
    };
    const { signer: deployer } = mkSigner(0);
    const { wallet: guardianWallet, signer: guardian } = mkSigner(1);
    const { wallet: beneficiaryWallet, signer: beneficiary } = mkSigner(2);

    const address = loadContractAddress();
    const contract = new Contract(address, ABI, deployer);
    const guardianContract = new Contract(address, ABI, guardian);
    const beneficiaryContract = new Contract(address, ABI, beneficiary);

    // 1) Creator deploys a vault with the guardian invited.
    const createTx = await contract.createVault(
      "Guardian E2E Vault",
      "multi-guardian approval flow",
      [guardianWallet.address],
      1
    );
    const createReceipt = await createTx.wait();
    let vaultId: bigint | undefined;
    for (const log of createReceipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        const id = firstArg(parsed, "VaultCreated");
        if (id !== undefined) vaultId = id;
      } catch {
        /* ignore unrelated logs */
      }
    }
    expect(vaultId).toBeDefined();
    expect(await contract.isGuardian(vaultId, guardianWallet.address)).toBe(
      false
    );

    // 2) Guardian accepts the invitation -> becomes an active guardian.
    await (await guardianContract.acceptGuardianInvite(vaultId)).wait();
    expect(await contract.isGuardian(vaultId, guardianWallet.address)).toBe(
      true
    );

    // 3) Guardian mints the beneficiary an access token and uploads a document.
    await (
      await guardianContract.mintAccessToken(
        vaultId,
        beneficiaryWallet.address,
        "e2e-uri"
      )
    ).wait();
    const docTx = await guardianContract.addDocument(
      vaultId,
      "encrypted-meta",
      "ipfs://e2e-document",
      0
    );
    const docReceipt = await docTx.wait();
    let documentId: bigint | undefined;
    for (const log of docReceipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        const id = firstArg(parsed, "DocumentAdded");
        if (id !== undefined) documentId = id;
      } catch {
        /* ignore */
      }
    }
    expect(documentId).toBeDefined();

    // 4) Beneficiary requests access to the document.
    const reqTx = await beneficiaryContract.requestAccess(documentId);
    const reqReceipt = await reqTx.wait();
    let requestId: bigint | undefined;
    for (const log of reqReceipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        const id = firstArg(parsed, "AccessRequested");
        if (id !== undefined) requestId = id;
      } catch {
        /* ignore */
      }
    }
    expect(requestId).toBeDefined();
    expect(
      await contract.hasActiveAccess(documentId, beneficiaryWallet.address)
    ).toBe(false);

    // 5) Guardian approves the request -> beneficiary gains active access.
    await (await guardianContract.approveAccess(requestId)).wait();
    expect(
      await contract.hasActiveAccess(documentId, beneficiaryWallet.address)
    ).toBe(true);
  });
});
