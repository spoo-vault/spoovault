const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SpooVault Cryptographic Share Commitment Verification", function () {
  let spooVault;
  let owner;
  let guardian1;
  let guardian2;
  let beneficiary;
  let vaultId;
  let documentId;
  let requestId;

  beforeEach(async function () {
    [owner, guardian1, guardian2, beneficiary] = await ethers.getSigners();

    const SpooVault = await ethers.getContractFactory("SpooVault");
    spooVault = await SpooVault.deploy();
    await spooVault.waitForDeployment();

    // Create a vault with 2 guardians and threshold 2
    const guardians = [guardian1.address, guardian2.address];
    await spooVault.connect(owner).createVault(
      "Commitment Test Vault",
      "Testing cryptographic commitment verification",
      guardians,
      2
    );
    vaultId = 1;

    await spooVault.connect(guardian1).acceptGuardianInvite(vaultId);
    await spooVault.connect(guardian2).acceptGuardianInvite(vaultId);

    // Upload a document with per-guardian key share commitments
    const tx = await spooVault.connect(owner)["addDocument(uint256,string,string,uint8,address[],string[])"](
      vaultId,
      "encrypted-doc-metadata",
      "QmCommitmentDocHash123",
      0, // AccessLevel.READ
      [guardian1.address, guardian2.address],
      ["enc-share-guardian1-valid", "enc-share-guardian2-valid"]
    );
    await tx.wait();
    documentId = 1;

    // Mint access token for beneficiary & request access
    await spooVault.connect(owner).mintAccessToken(vaultId, beneficiary.address, "ipfs://token");
    const reqTx = await spooVault.connect(beneficiary).requestAccess(documentId);
    await reqTx.wait();
    requestId = 1;
  });

  it("stores cryptographic hash commitments upon document creation", async function () {
    const expectedCommitment1 = ethers.keccak256(ethers.toUtf8Bytes("enc-share-guardian1-valid"));
    const expectedCommitment2 = ethers.keccak256(ethers.toUtf8Bytes("enc-share-guardian2-valid"));

    const storedCommitment1 = await spooVault.guardianShareCommitments(documentId, guardian1.address);
    const storedCommitment2 = await spooVault.guardianShareCommitments(documentId, guardian2.address);

    expect(storedCommitment1).to.equal(expectedCommitment1);
    expect(storedCommitment2).to.equal(expectedCommitment2);
  });

  it("accepts valid matching key share and emits ShareValidated event", async function () {
    const validShare = "enc-share-guardian1-valid";
    const expectedCommitment = ethers.keccak256(ethers.toUtf8Bytes(validShare));

    await expect(
      spooVault.connect(guardian1)["approveAccess(uint256,string)"](requestId, validShare)
    )
      .to.emit(spooVault, "ShareValidated")
      .withArgs(requestId, guardian1.address, expectedCommitment)
      .and.to.emit(spooVault, "ShareSubmittedForBeneficiary")
      .withArgs(requestId, guardian1.address, validShare);

    expect(await spooVault.getBeneficiaryKeyShare(requestId, guardian1.address)).to.equal(validShare);
  });

  it("reverts with InvalidShareCommitment when a guardian submits a corrupted/mismatched share", async function () {
    const corruptedShare = "corrupted-or-malicious-share-string";

    await expect(
      spooVault.connect(guardian1)["approveAccess(uint256,string)"](requestId, corruptedShare)
    ).to.be.revertedWithCustomError(spooVault, "InvalidShareCommitment");
  });

  it("allows approving access without a share payload (empty string)", async function () {
    await expect(
      spooVault.connect(guardian1)["approveAccess(uint256)"](requestId)
    ).to.emit(spooVault, "AccessApproved").withArgs(requestId, guardian1.address);
  });

  it("updates commitment hash upon share refresh", async function () {
    // Start reshare session
    await spooVault.connect(owner).startShareRefresh(documentId, 86400);

    const newShareOwner = "refreshed-enc-share-owner";
    const newShare1 = "refreshed-enc-share-guardian1";
    const newShare2 = "refreshed-enc-share-guardian2";

    await spooVault.connect(owner).submitZeroShareCommitment(
      documentId,
      [ethers.ZeroHash, ethers.id("coeffOwner")]
    );
    await spooVault.connect(guardian1).submitZeroShareCommitment(
      documentId,
      [ethers.ZeroHash, ethers.id("coeff1")]
    );
    await spooVault.connect(guardian2).submitZeroShareCommitment(
      documentId,
      [ethers.ZeroHash, ethers.id("coeff2")]
    );

    await spooVault.connect(guardian1).applyShareRefresh(
      documentId,
      [owner.address, guardian1.address, guardian2.address],
      [newShareOwner, newShare1, newShare2]
    );

    const newCommitment1 = ethers.keccak256(ethers.toUtf8Bytes(newShare1));
    expect(await spooVault.guardianShareCommitments(documentId, guardian1.address)).to.equal(newCommitment1);

    // Old share should revert
    await expect(
      spooVault.connect(guardian1)["approveAccess(uint256,string)"](requestId, "enc-share-guardian1-valid")
    ).to.be.revertedWithCustomError(spooVault, "InvalidShareCommitment");

    // New share should succeed
    await expect(
      spooVault.connect(guardian1)["approveAccess(uint256,string)"](requestId, newShare1)
    ).to.emit(spooVault, "ShareValidated").withArgs(requestId, guardian1.address, newCommitment1);
  });
});
