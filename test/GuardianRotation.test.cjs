const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SpooVault Guardian Rotation & Threshold Adjustment", function () {
  let spooVault;
  let owner;
  let guardian1;
  let guardian2;
  let guardian3;
  let beneficiary;
  let vaultId;

  beforeEach(async function () {
    [owner, guardian1, guardian2, guardian3, beneficiary] = await ethers.getSigners();

    const SpooVault = await ethers.getContractFactory("SpooVault");
    spooVault = await SpooVault.deploy();
    await spooVault.waitForDeployment();

    // Create a vault with 4 guardians total (owner + 3 external), threshold = 3
    const guardians = [guardian1.address, guardian2.address, guardian3.address];
    const tx = await spooVault.connect(owner).createVault(
      "Guardian Rotation Test Vault",
      "Multi-sig vault for testing guardian rotation",
      guardians,
      3
    );
    await tx.wait();
    vaultId = 1;

    // Accept guardian invites
    await spooVault.connect(guardian1).acceptGuardianInvite(vaultId);
    await spooVault.connect(guardian2).acceptGuardianInvite(vaultId);
    await spooVault.connect(guardian3).acceptGuardianInvite(vaultId);
  });

  describe("Guardian Removal", function () {
    it("should allow a guardian to propose removal of another guardian", async function () {
      const tx = spooVault.connect(owner).proposeGuardianRemoval(vaultId, guardian1.address);
      await expect(tx)
        .to.emit(spooVault, "GuardianRemovalProposed")
        .withArgs(vaultId, guardian1.address, owner.address);
    });

    it("should revert if non-guardian tries to propose removal", async function () {
      await expect(
        spooVault.connect(beneficiary).proposeGuardianRemoval(vaultId, guardian1.address)
      ).to.be.revertedWithCustomError(spooVault, "OnlyGuardian");
    });

    it("should revert if trying to remove non-existent guardian", async function () {
      await expect(
        spooVault.connect(owner).proposeGuardianRemoval(vaultId, beneficiary.address)
      ).to.be.revertedWithCustomError(spooVault, "GuardianNotExists");
    });

    it("should allow majority of guardians to approve and execute removal", async function () {
      // Propose removal
      await spooVault.connect(owner).proposeGuardianRemoval(vaultId, guardian1.address);

      // Get approvals from 3 guardians (majority of 4)
      await spooVault.connect(owner).approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault.connect(guardian2).approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault.connect(guardian3).approveGuardianRemoval(vaultId, guardian1.address);

      // Execute reconfiguration
      const tx = spooVault.connect(owner).executeVaultReconfiguration(
        vaultId,
        guardian1.address,
        3 // Keep threshold same
      );
      
      await expect(tx)
        .to.emit(spooVault, "VaultReconfigurationExecuted")
        .to.emit(spooVault, "GuardianRemoved")
        .withArgs(vaultId, guardian1.address);

      // Verify guardian is removed
      const isGuardian = await spooVault.isGuardian(vaultId, guardian1.address);
      expect(isGuardian).to.equal(false);
    });

    it("should revert if trying to approve removal twice", async function () {
      await spooVault.connect(owner).proposeGuardianRemoval(vaultId, guardian1.address);
      await spooVault.connect(guardian2).approveGuardianRemoval(vaultId, guardian1.address);

      await expect(
        spooVault.connect(guardian2).approveGuardianRemoval(vaultId, guardian1.address)
      ).to.be.revertedWithCustomError(spooVault, "ApprovalAlreadyGiven");
    });

    it("should revert if approval is after proposal expiration", async function () {
      await spooVault.connect(owner).proposeGuardianRemoval(vaultId, guardian1.address);

      // Fast forward time by 8 days (past 7-day expiration)
      await time.increase(8 * 24 * 60 * 60);

      await expect(
        spooVault.connect(guardian2).approveGuardianRemoval(vaultId, guardian1.address)
      ).to.be.revertedWithCustomError(spooVault, "ProposalExpired");
    });

    it("should revert execution if insufficient approvals", async function () {
      await spooVault.connect(owner).proposeGuardianRemoval(vaultId, guardian1.address);
      // Only 1 approval, need 3 (majority of 4)
      await spooVault.connect(guardian2).approveGuardianRemoval(vaultId, guardian1.address);

      await expect(
        spooVault.connect(owner).executeVaultReconfiguration(vaultId, guardian1.address, 3)
      ).to.be.revertedWithCustomError(spooVault, "InsufficientApprovalsForExecution");
    });
  });

  describe("Threshold Update", function () {
    it("should allow a guardian to propose threshold update", async function () {
      const newThreshold = 2;
      const tx = spooVault.connect(owner).proposeThresholdUpdate(vaultId, newThreshold);
      
      await expect(tx)
        .to.emit(spooVault, "ThresholdUpdateProposed")
        .withArgs(vaultId, newThreshold, owner.address);
    });

    it("should revert if new threshold is zero", async function () {
      await expect(
        spooVault.connect(owner).proposeThresholdUpdate(vaultId, 0)
      ).to.be.revertedWithCustomError(spooVault, "InvalidNewThreshold");
    });

    it("should revert if new threshold exceeds guardian count", async function () {
      await expect(
        spooVault.connect(owner).proposeThresholdUpdate(vaultId, 5)
      ).to.be.revertedWithCustomError(spooVault, "InvalidNewThreshold");
    });

    it("should allow majority to approve and execute threshold update", async function () {
      const newThreshold = 2;
      await spooVault.connect(owner).proposeThresholdUpdate(vaultId, newThreshold);

      // Get 3 approvals (majority of 4)
      await spooVault.connect(owner).approveThresholdUpdate(vaultId, newThreshold);
      await spooVault.connect(guardian2).approveThresholdUpdate(vaultId, newThreshold);
      await spooVault.connect(guardian3).approveThresholdUpdate(vaultId, newThreshold);

      // Execute
      const tx = spooVault.connect(owner).executeVaultReconfiguration(
        vaultId,
        ethers.ZeroAddress,
        newThreshold
      );
      
      await expect(tx).to.emit(spooVault, "VaultReconfigurationExecuted");

      // Verify threshold updated
      const vault = await spooVault.vaults(vaultId);
      expect(vault.approvalThreshold).to.equal(newThreshold);
    });

    it("should revert execution if insufficient threshold approvals", async function () {
      const newThreshold = 2;
      await spooVault.connect(owner).proposeThresholdUpdate(vaultId, newThreshold);
      // Only 1 approval, need 3
      await spooVault.connect(guardian2).approveThresholdUpdate(vaultId, newThreshold);

      await expect(
        spooVault.connect(owner).executeVaultReconfiguration(vaultId, ethers.ZeroAddress, newThreshold)
      ).to.be.revertedWithCustomError(spooVault, "InsufficientApprovalsForExecution");
    });
  });

  describe("Atomic Reconfiguration", function () {
    it("should execute both removal and threshold update atomically when both have approvals", async function () {
      const newThreshold = 2;

      // Propose both changes
      await spooVault.connect(owner).proposeGuardianRemoval(vaultId, guardian1.address);
      await spooVault.connect(owner).proposeThresholdUpdate(vaultId, newThreshold);

      // Approve removal (need 3 out of 4)
      await spooVault.connect(owner).approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault.connect(guardian2).approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault.connect(guardian3).approveGuardianRemoval(vaultId, guardian1.address);

      // Approve threshold (need 3 out of 4)
      await spooVault.connect(owner).approveThresholdUpdate(vaultId, newThreshold);
      await spooVault.connect(guardian2).approveThresholdUpdate(vaultId, newThreshold);
      await spooVault.connect(guardian3).approveThresholdUpdate(vaultId, newThreshold);

      // Execute both
      const tx = spooVault.connect(owner).executeVaultReconfiguration(
        vaultId,
        guardian1.address,
        newThreshold
      );
      
      await expect(tx).to.emit(spooVault, "VaultReconfigurationExecuted");

      // Verify both changes applied
      const vault = await spooVault.vaults(vaultId);
      expect(vault.approvalThreshold).to.equal(newThreshold);
      expect(await spooVault.isGuardian(vaultId, guardian1.address)).to.equal(false);
    });

    it("should revert if new threshold exceeds remaining guardians after removal", async function () {
      // Try to set threshold to 4 but only 3 guardians remain after removal
      await spooVault.connect(owner).proposeGuardianRemoval(vaultId, guardian1.address);
      await spooVault.connect(owner).proposeThresholdUpdate(vaultId, 4);

      // Approve removal
      await spooVault.connect(owner).approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault.connect(guardian2).approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault.connect(guardian3).approveGuardianRemoval(vaultId, guardian1.address);

      // Approve threshold
      await spooVault.connect(owner).approveThresholdUpdate(vaultId, 4);
      await spooVault.connect(guardian2).approveThresholdUpdate(vaultId, 4);
      await spooVault.connect(guardian3).approveThresholdUpdate(vaultId, 4);

      // Execution should fail due to invalid threshold
      await expect(
        spooVault.connect(owner).executeVaultReconfiguration(vaultId, guardian1.address, 4)
      ).to.be.revertedWithCustomError(spooVault, "InvalidNewThreshold");
    });
  });

  describe("Access Control", function () {
    it("should prevent non-guardian from proposing removal", async function () {
      await expect(
        spooVault.connect(beneficiary).proposeGuardianRemoval(vaultId, guardian1.address)
      ).to.be.revertedWithCustomError(spooVault, "OnlyGuardian");
    });

    it("should prevent non-guardian from approving removal", async function () {
      await spooVault.connect(owner).proposeGuardianRemoval(vaultId, guardian1.address);
      await expect(
        spooVault.connect(beneficiary).approveGuardianRemoval(vaultId, guardian1.address)
      ).to.be.revertedWithCustomError(spooVault, "OnlyGuardian");
    });

    it("should prevent non-guardian from proposing threshold update", async function () {
      await expect(
        spooVault.connect(beneficiary).proposeThresholdUpdate(vaultId, 2)
      ).to.be.revertedWithCustomError(spooVault, "OnlyGuardian");
    });

    it("should prevent non-guardian from approving threshold update", async function () {
      await spooVault.connect(owner).proposeThresholdUpdate(vaultId, 2);
      await expect(
        spooVault.connect(beneficiary).approveThresholdUpdate(vaultId, 2)
      ).to.be.revertedWithCustomError(spooVault, "OnlyGuardian");
    });
  });
});
