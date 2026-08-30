const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deploySpooVault } = require("./helpers/deploySpooVault.cjs");

describe("SpooVault EVM Contract Unit Tests", function () {
  let spooVault;
  let owner;
  let guardian1;
  let guardian2;
  let beneficiary;

  beforeEach(async function () {
    [owner, guardian1, guardian2, beneficiary] = await ethers.getSigners();

    spooVault = await deploySpooVault();
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

  describe("Beneficiary Registry", function () {
    beforeEach(async function () {
      await spooVault.connect(owner).createVault("Beneficiary Vault", "Desc", [guardian1.address], 1);
    });

    it("should allow the vault creator to set a beneficiary", async function () {
      await expect(spooVault.connect(owner).setBeneficiary(1, beneficiary.address))
        .to.emit(spooVault, "BeneficiarySet")
        .withArgs(1, beneficiary.address);

      expect(await spooVault.getBeneficiary(1)).to.equal(beneficiary.address);
    });

    it("should default to the zero address when no beneficiary is set", async function () {
      expect(await spooVault.getBeneficiary(1)).to.equal(ethers.ZeroAddress);
    });

    it("should revert when setting a zero-address beneficiary", async function () {
      await expect(
        spooVault.connect(owner).setBeneficiary(1, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(spooVault, "ZeroAddressBeneficiary");
    });

    it("should revert when a non-creator tries to set the beneficiary", async function () {
      await expect(
        spooVault.connect(guardian1).setBeneficiary(1, beneficiary.address)
      ).to.be.revertedWithCustomError(spooVault, "OnlyVaultCreator");
    });

    it("should revert when the beneficiary is already set", async function () {
      await spooVault.connect(owner).setBeneficiary(1, beneficiary.address);

      await expect(
        spooVault.connect(owner).setBeneficiary(1, guardian2.address)
      ).to.be.revertedWithCustomError(spooVault, "BeneficiaryAlreadySet");
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

  describe("Cross-Chain Revocation Broadcast", function () {
    let userA;

    beforeEach(async function () {
      const signers = await ethers.getSigners();
      userA = signers[4];

      await spooVault.connect(owner).createVault("Broadcast Vault", "Desc", [guardian1.address], 1);
      await spooVault.connect(guardian1).acceptGuardianInvite(1);
      await spooVault.connect(guardian1).mintAccessToken(1, userA.address, "uri");
      await spooVault.connect(guardian1).addDocument(1, "meta", "ipfs-hash", 0);
      await spooVault.connect(userA).requestAccess(1);
      await spooVault.connect(guardian1).approveAccess(1);
    });

    it("computes vaultGID from this contract's address and the vault id", async function () {
      const expected = ethers.solidityPackedKeccak256(
        ["address", "uint256"],
        [await spooVault.getAddress(), 1]
      );
      expect(await spooVault.vaultGID(1)).to.equal(expected);
    });

    it("differs per vault since vaultGID incorporates the vault id", async function () {
      await spooVault.connect(owner).createVault("Second Vault", "Desc", [guardian2.address], 1);
      const gid1 = await spooVault.vaultGID(1);
      const gid2 = await spooVault.vaultGID(2);
      expect(gid1).to.not.equal(gid2);
    });

    it("still clears on-chain access and emits AccessRevoked alongside the broadcast", async function () {
      expect(await spooVault.hasActiveAccess(1, userA.address)).to.equal(true);

      await expect(spooVault.connect(guardian1).revokeAccess(1, userA.address))
        .to.emit(spooVault, "AccessRevoked")
        .withArgs(1, userA.address);

      expect(await spooVault.hasActiveAccess(1, userA.address)).to.equal(false);
    });

    it("is disabled by default and does not emit a broadcast or touch the nonce", async function () {
      expect(await spooVault.crossChainRevocationEnabled(1)).to.equal(false);

      await expect(spooVault.connect(guardian1).revokeAccess(1, userA.address))
        .to.not.emit(spooVault, "CrossChainRevocationBroadcast");
      expect(await spooVault.documentRevocationNonce(1, userA.address)).to.equal(0);
    });

    it("only the vault creator can enable cross-chain revocation broadcasting", async function () {
      await expect(
        spooVault.connect(guardian1).setCrossChainRevocationEnabled(1, true)
      ).to.be.revertedWithCustomError(spooVault, "OnlyVaultCreator");
    });

    it("emits CrossChainRevocationBroadcast and RevokeAccess with a strictly increasing nonce once enabled, bumping vaultAccessVersion", async function () {
      await spooVault.connect(owner).setCrossChainRevocationEnabled(1, true);
      const gid = await spooVault.vaultGID(1);
      const initialVer = await spooVault.getVaultAccessVersion(1, userA.address);

      await expect(spooVault.connect(guardian1).revokeAccess(1, userA.address))
        .to.emit(spooVault, "CrossChainRevocationBroadcast")
        .withArgs(gid, 1, userA.address, 1)
        .and.to.emit(spooVault, "RevokeAccess")
        .withArgs(gid, 1, userA.address, 1);
      expect(await spooVault.documentRevocationNonce(1, userA.address)).to.equal(1);
      expect(await spooVault.getVaultAccessVersion(1, userA.address)).to.equal(initialVer + 1n);

      // A relayed message for a Soroban-side relay_revoke_access call must
      // never be replayable, so the nonce keeps increasing even across
      // repeated revokes of the same document/user pair.
      await expect(spooVault.connect(guardian1).revokeAccess(1, userA.address))
        .to.emit(spooVault, "CrossChainRevocationBroadcast")
        .withArgs(gid, 1, userA.address, 2)
        .and.to.emit(spooVault, "RevokeAccess")
        .withArgs(gid, 1, userA.address, 2);
      expect(await spooVault.documentRevocationNonce(1, userA.address)).to.equal(2);
      expect(await spooVault.getVaultAccessVersion(1, userA.address)).to.equal(initialVer + 2n);
    });
  });
});
