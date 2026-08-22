const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SpooVault EVM Contract Unit Tests", function () {
  let spooVault;
  let owner;
  let guardian1;
  let guardian2;
  let beneficiary;

  beforeEach(async function () {
    [owner, guardian1, guardian2, beneficiary] = await ethers.getSigners();

    const SpooVault = await ethers.getContractFactory("SpooVault");
    spooVault = await SpooVault.deploy();
    await spooVault.waitForDeployment();
  });

  describe("Public Key Registry", function () {
    it("should allow a user to register an X25519 public key", async function () {
      const pubKey = "B64_PUBLIC_KEY_TEST_STRING_12345";
      await expect(spooVault.connect(beneficiary).registerPublicKey(pubKey))
        .to.emit(spooVault, "PublicKeyRegistered")
        .withArgs(beneficiary.address, pubKey);

      const registeredKey = await spooVault.userPublicKeys(beneficiary.address);
      expect(registeredKey).to.equal(pubKey);
    });
  });

  describe("Vault Creation & Guardian Thresholds", function () {
    it("should create a vault with valid threshold and guardian invite list", async function () {
      const guardians = [guardian1.address, guardian2.address];
      const threshold = 2; // threshold out of owner + 2 guardians = 3 total

      const tx = await spooVault
        .connect(owner)
        .createVault(
          "Executive Vault",
          "Confidential legal documents",
          guardians,
          threshold
        );

      await expect(tx).to.emit(spooVault, "VaultCreated");

      const vault = await spooVault.vaults(1);
      expect(vault.name).to.equal("Executive Vault");
      expect(vault.creator).to.equal(owner.address);
      expect(vault.approvalThreshold).to.equal(threshold);
      expect(vault.isActive).to.equal(true);
    });

    it("should revert vault creation if no external guardians are provided", async function () {
      await expect(
        spooVault.connect(owner).createVault("Single Vault", "Desc", [], 1)
      ).to.be.revertedWithCustomError(spooVault, "AtLeastOneGuardian");
    });

    it("should revert if approval threshold is zero or exceeds total guardian count", async function () {
      const guardians = [guardian1.address];
      await expect(
        spooVault
          .connect(owner)
          .createVault("Invalid Threshold Vault", "Desc", guardians, 0)
      ).to.be.revertedWithCustomError(spooVault, "InvalidApprovalThreshold");

      await expect(
        spooVault
          .connect(owner)
          .createVault("Over Threshold Vault", "Desc", guardians, 5)
      ).to.be.revertedWithCustomError(spooVault, "InvalidApprovalThreshold");
    });
  });

  describe("Vault Release State & Proof of Life", function () {
    it("should allow vault creator to record proof of life", async function () {
      const guardians = [guardian1.address];
      await spooVault
        .connect(owner)
        .createVault("Inheritance Vault", "Desc", guardians, 1);

      await expect(spooVault.connect(owner).proveLife(1)).to.emit(
        spooVault,
        "ProofOfLifeRecorded"
      );
    });

    it("should allow vault creator to toggle emergency mode", async function () {
      const guardians = [guardian1.address];
      await spooVault
        .connect(owner)
        .createVault("Emergency Vault", "Desc", guardians, 1);

      await expect(spooVault.connect(owner).setEmergencyMode(1, true))
        .to.emit(spooVault, "EmergencyModeUpdated")
        .withArgs(1, true);
    });
  });

  describe("NFT Transfer Access Revocation", function () {
    let userA;
    let userB;

    beforeEach(async function () {
      const signers = await ethers.getSigners();
      userA = signers[4];
      userB = signers[5];

      await spooVault
        .connect(owner)
        .createVault("Access Vault", "Desc", [guardian1.address], 1);
      await spooVault.connect(guardian1).acceptGuardianInvite(1);
    });

    async function grantAccessToUserA() {
      await spooVault
        .connect(guardian1)
        .mintAccessToken(1, userA.address, "uri");
      await spooVault.connect(guardian1).addDocument(1, "meta", "ipfs-hash", 0);
      await spooVault.connect(userA).requestAccess(1);
      await spooVault.connect(guardian1).approveAccess(1);
    }

    it("should revoke all past document access grants when sender transfers their last NFT pass", async function () {
      await grantAccessToUserA();
      expect(await spooVault.hasActiveAccess(1, userA.address)).to.equal(true);

      await spooVault
        .connect(userA)
        .transferFrom(userA.address, userB.address, 1);

      expect(await spooVault.hasActiveAccess(1, userA.address)).to.equal(false);
      expect(await spooVault.hasVaultToken(userA.address, 1)).to.equal(false);
    });

    it("should not let the transfer recipient inherit the sender's document grants", async function () {
      await grantAccessToUserA();

      await spooVault
        .connect(userA)
        .transferFrom(userA.address, userB.address, 1);

      expect(await spooVault.hasActiveAccess(1, userB.address)).to.equal(false);
    });

    it("should require fresh guardian approval before re-acquired passes restore access", async function () {
      await grantAccessToUserA();
      await spooVault
        .connect(userA)
        .transferFrom(userA.address, userB.address, 1);

      await spooVault
        .connect(guardian1)
        .mintAccessToken(1, userA.address, "uri-2");
      expect(await spooVault.hasActiveAccess(1, userA.address)).to.equal(false);

      await expect(spooVault.connect(userA).requestAccess(1))
        .to.emit(spooVault, "AccessRequested")
        .withArgs(2, 1, userA.address);

      await expect(spooVault.connect(guardian1).approveAccess(2))
        .to.emit(spooVault, "AccessGranted")
        .withArgs(2, 1, userA.address);

      expect(await spooVault.hasActiveAccess(1, userA.address)).to.equal(true);
    });

    it("should preserve active grants on partial transfer while any pass remains", async function () {
      await spooVault
        .connect(guardian1)
        .mintAccessToken(1, userA.address, "uri-1");
      await spooVault
        .connect(guardian1)
        .mintAccessToken(1, userA.address, "uri-2");
      await spooVault.connect(guardian1).addDocument(1, "meta", "ipfs-hash", 0);
      await spooVault.connect(userA).requestAccess(1);
      await spooVault.connect(guardian1).approveAccess(1);

      await spooVault
        .connect(userA)
        .transferFrom(userA.address, userB.address, 1);

      expect(await spooVault.hasActiveAccess(1, userA.address)).to.equal(true);
      expect(await spooVault.hasVaultToken(userA.address, 1)).to.equal(true);
    });

    it("should not revoke access on self-transfer", async function () {
      await grantAccessToUserA();

      await spooVault
        .connect(userA)
        .transferFrom(userA.address, userA.address, 1);

      expect(await spooVault.hasActiveAccess(1, userA.address)).to.equal(true);
    });

    it("should revoke access on burn and require fresh approval after re-mint", async function () {
      await grantAccessToUserA();

      await expect(spooVault.connect(userA).burnAccessToken(1)).to.emit(
        spooVault,
        "NFTBurned"
      );
      expect(await spooVault.hasActiveAccess(1, userA.address)).to.equal(false);

      await spooVault
        .connect(guardian1)
        .mintAccessToken(1, userA.address, "uri-2");
      expect(await spooVault.hasActiveAccess(1, userA.address)).to.equal(false);

      await spooVault.connect(userA).requestAccess(1);
      await spooVault.connect(guardian1).approveAccess(2);
      expect(await spooVault.hasActiveAccess(1, userA.address)).to.equal(true);
    });
  });
});
