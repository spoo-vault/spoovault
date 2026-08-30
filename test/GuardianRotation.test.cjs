const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deploySpooVault } = require("./helpers/deploySpooVault.cjs");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SpooVault Guardian Rotation & Threshold Adjustment (Multi-Stage Governance)", function () {
  let spooVault;
  let owner;
  let guardian1;
  let guardian2;
  let guardian3;
  let beneficiary;
  let vaultId;

  beforeEach(async function () {
    [owner, guardian1, guardian2, guardian3, beneficiary] =
      await ethers.getSigners();

    spooVault = await deploySpooVault();

    // Create a vault with 4 guardians total (owner + 3 external), threshold = 3
    const guardians = [guardian1.address, guardian2.address, guardian3.address];
    const tx = await spooVault
      .connect(owner)
      .createVault(
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

  describe("Proposal Creation", function () {
    it("should allow a guardian to propose removal of another guardian", async function () {
      const tx = spooVault
        .connect(owner)
        .proposeGuardianRemoval(vaultId, guardian1.address);
      await expect(tx)
        .to.emit(spooVault, "GuardianRemovalProposed")
        .withArgs(vaultId, guardian1.address, owner.address);
    });

    it("should revert if non-guardian tries to propose removal", async function () {
      await expect(
        spooVault
          .connect(beneficiary)
          .proposeGuardianRemoval(vaultId, guardian1.address)
      ).to.be.revertedWithCustomError(spooVault, "OnlyGuardian");
    });

    it("should revert if trying to remove non-existent guardian", async function () {
      await expect(
        spooVault
          .connect(owner)
          .proposeGuardianRemoval(vaultId, beneficiary.address)
      ).to.be.revertedWithCustomError(spooVault, "GuardianNotExists");
    });

    it("should allow a guardian to propose threshold update", async function () {
      const newThreshold = 2;
      const tx = spooVault
        .connect(owner)
        .proposeThresholdUpdate(vaultId, newThreshold);

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
  });

  describe("Voting & Approvals", function () {
    it("should allow guardians to approve removal", async function () {
      await spooVault
        .connect(owner)
        .proposeGuardianRemoval(vaultId, guardian1.address);

      const tx = spooVault
        .connect(guardian2)
        .approveGuardianRemoval(vaultId, guardian1.address);

      await expect(tx)
        .to.emit(spooVault, "GuardianRemovalApproved")
        .withArgs(vaultId, guardian1.address, guardian2.address);
    });

    it("should revert if trying to approve removal twice", async function () {
      await spooVault
        .connect(owner)
        .proposeGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian2)
        .approveGuardianRemoval(vaultId, guardian1.address);

      await expect(
        spooVault
          .connect(guardian2)
          .approveGuardianRemoval(vaultId, guardian1.address)
      ).to.be.revertedWithCustomError(spooVault, "ApprovalAlreadyGiven");
    });

    it("should revert if approval is after proposal expiration", async function () {
      await spooVault
        .connect(owner)
        .proposeGuardianRemoval(vaultId, guardian1.address);

      // Fast forward time by 8 days (past 7-day expiration)
      await time.increase(8 * 24 * 60 * 60);

      await expect(
        spooVault
          .connect(guardian2)
          .approveGuardianRemoval(vaultId, guardian1.address)
      ).to.be.revertedWithCustomError(spooVault, "ProposalExpired");
    });

    it("should allow guardians to approve threshold update", async function () {
      const newThreshold = 2;
      await spooVault
        .connect(owner)
        .proposeThresholdUpdate(vaultId, newThreshold);

      const tx = spooVault
        .connect(guardian2)
        .approveThresholdUpdate(vaultId, newThreshold);

      await expect(tx)
        .to.emit(spooVault, "ThresholdUpdateApproved")
        .withArgs(vaultId, newThreshold, guardian2.address);
    });
  });

  describe("Timelock Queueing & Quorum Check", function () {
    it("should revert queueing if approvals do not meet ceil(K/2)+1 quorum", async function () {
      // 4 guardians: ceil(4/2) + 1 = 3 approvals required
      await spooVault
        .connect(owner)
        .proposeGuardianRemoval(vaultId, guardian1.address);

      // Only 2 approvals (owner + guardian2)
      await spooVault
        .connect(owner)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian2)
        .approveGuardianRemoval(vaultId, guardian1.address);

      // Try to queue with only 2 approvals -> should revert
      await expect(
        spooVault
          .connect(owner)
          .queueVaultReconfiguration(vaultId, guardian1.address, 0)
      ).to.be.revertedWithCustomError(
        spooVault,
        "InsufficientApprovalsForExecution"
      );
    });

    it("should allow queueing once ceil(K/2)+1 quorum approvals are met", async function () {
      await spooVault
        .connect(owner)
        .proposeGuardianRemoval(vaultId, guardian1.address);

      // Get 3 approvals out of 4 (ceil(4/2)+1 = 3)
      await spooVault
        .connect(owner)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian2)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian3)
        .approveGuardianRemoval(vaultId, guardian1.address);

      // Queue reconfiguration
      const tx = spooVault
        .connect(owner)
        .queueVaultReconfiguration(vaultId, guardian1.address, 0);

      await expect(tx).to.emit(spooVault, "VaultReconfigurationQueued");
    });

    it("should revert if non-guardian attempts to queue reconfiguration", async function () {
      await spooVault
        .connect(owner)
        .proposeGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(owner)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian2)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian3)
        .approveGuardianRemoval(vaultId, guardian1.address);

      await expect(
        spooVault
          .connect(beneficiary)
          .queueVaultReconfiguration(vaultId, guardian1.address, 0)
      ).to.be.revertedWithCustomError(spooVault, "OnlyGuardian");
    });

    it("should revert if queueing already-queued proposal", async function () {
      await spooVault
        .connect(owner)
        .proposeGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(owner)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian2)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian3)
        .approveGuardianRemoval(vaultId, guardian1.address);

      await spooVault
        .connect(owner)
        .queueVaultReconfiguration(vaultId, guardian1.address, 0);

      await expect(
        spooVault
          .connect(owner)
          .queueVaultReconfiguration(vaultId, guardian1.address, 0)
      ).to.be.revertedWithCustomError(spooVault, "ProposalAlreadyQueued");
    });
  });

  describe("Timelock Delay & Execution", function () {
    it("should revert execution if proposal was never queued", async function () {
      await spooVault
        .connect(owner)
        .proposeGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(owner)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian2)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian3)
        .approveGuardianRemoval(vaultId, guardian1.address);

      // Attempt to execute directly without queueing
      await expect(
        spooVault
          .connect(owner)
          .executeVaultReconfiguration(vaultId, guardian1.address, 3)
      ).to.be.revertedWithCustomError(spooVault, "ProposalNotQueued");
    });

    it("should revert execution if 24-hour timelock has not elapsed", async function () {
      await spooVault
        .connect(owner)
        .proposeGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(owner)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian2)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian3)
        .approveGuardianRemoval(vaultId, guardian1.address);

      await spooVault
        .connect(owner)
        .queueVaultReconfiguration(vaultId, guardian1.address, 0);

      // Fast forward 12 hours (less than 24 hours)
      await time.increase(12 * 60 * 60);

      await expect(
        spooVault
          .connect(owner)
          .executeVaultReconfiguration(vaultId, guardian1.address, 3)
      ).to.be.revertedWithCustomError(spooVault, "TimelockNotElapsed");
    });

    it("should execute guardian removal after 24-hour timelock delay has elapsed", async function () {
      await spooVault
        .connect(owner)
        .proposeGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(owner)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian2)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian3)
        .approveGuardianRemoval(vaultId, guardian1.address);

      await spooVault
        .connect(owner)
        .queueVaultReconfiguration(vaultId, guardian1.address, 0);

      // Fast forward 24 hours
      await time.increase(24 * 60 * 60);

      const tx = spooVault
        .connect(owner)
        .executeVaultReconfiguration(vaultId, guardian1.address, 3);

      await expect(tx)
        .to.emit(spooVault, "VaultReconfigurationExecuted")
        .to.emit(spooVault, "GuardianRemoved")
        .withArgs(vaultId, guardian1.address);

      expect(await spooVault.isGuardian(vaultId, guardian1.address)).to.equal(
        false
      );
    });

    it("should execute threshold update after 24-hour timelock delay has elapsed", async function () {
      const newThreshold = 2;
      await spooVault
        .connect(owner)
        .proposeThresholdUpdate(vaultId, newThreshold);
      await spooVault
        .connect(owner)
        .approveThresholdUpdate(vaultId, newThreshold);
      await spooVault
        .connect(guardian2)
        .approveThresholdUpdate(vaultId, newThreshold);
      await spooVault
        .connect(guardian3)
        .approveThresholdUpdate(vaultId, newThreshold);

      await spooVault
        .connect(owner)
        .queueVaultReconfiguration(vaultId, ethers.ZeroAddress, newThreshold);

      // Fast forward 24 hours
      await time.increase(24 * 60 * 60);

      const tx = spooVault
        .connect(owner)
        .executeVaultReconfiguration(
          vaultId,
          ethers.ZeroAddress,
          newThreshold
        );

      await expect(tx).to.emit(spooVault, "VaultReconfigurationExecuted");

      const vault = await spooVault.vaults(vaultId);
      expect(vault.approvalThreshold).to.equal(newThreshold);
    });
  });

  describe("Emergency Cancel / Veto by Vault Creator", function () {
    it("should allow vault creator to veto malicious reconfiguration proposal during timelock", async function () {
      await spooVault
        .connect(guardian1)
        .proposeGuardianRemoval(vaultId, owner.address);
      await spooVault
        .connect(guardian1)
        .approveGuardianRemoval(vaultId, owner.address);
      await spooVault
        .connect(guardian2)
        .approveGuardianRemoval(vaultId, owner.address);
      await spooVault
        .connect(guardian3)
        .approveGuardianRemoval(vaultId, owner.address);

      await spooVault
        .connect(guardian1)
        .queueVaultReconfiguration(vaultId, owner.address, 0);

      // Creator vetoes during timelock
      const tx = spooVault
        .connect(owner)
        .cancelVaultReconfiguration(vaultId, owner.address, 0);

      await expect(tx)
        .to.emit(spooVault, "VaultReconfigurationCanceled")
        .withArgs(vaultId, owner.address, 0, owner.address);

      // Fast forward past timelock
      await time.increase(24 * 60 * 60);

      // Execution attempt must revert
      await expect(
        spooVault
          .connect(guardian1)
          .executeVaultReconfiguration(vaultId, owner.address, 3)
      ).to.be.revertedWithCustomError(spooVault, "ProposalVetoed");
    });

    it("should revert if non-creator attempts to cancel/veto proposal", async function () {
      await spooVault
        .connect(owner)
        .proposeGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(owner)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian2)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian3)
        .approveGuardianRemoval(vaultId, guardian1.address);

      await spooVault
        .connect(owner)
        .queueVaultReconfiguration(vaultId, guardian1.address, 0);

      await expect(
        spooVault
          .connect(guardian1)
          .cancelVaultReconfiguration(vaultId, guardian1.address, 0)
      ).to.be.revertedWithCustomError(spooVault, "OnlyVaultCreator");
    });
  });

  describe("Atomic Reconfiguration", function () {
    it("should execute both removal and threshold update atomically through timelock", async function () {
      const newThreshold = 2;

      // Propose both changes
      await spooVault
        .connect(owner)
        .proposeGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(owner)
        .proposeThresholdUpdate(vaultId, newThreshold);

      // Approve removal (need 3 out of 4)
      await spooVault
        .connect(owner)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian2)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian3)
        .approveGuardianRemoval(vaultId, guardian1.address);

      // Approve threshold (need 3 out of 4)
      await spooVault
        .connect(owner)
        .approveThresholdUpdate(vaultId, newThreshold);
      await spooVault
        .connect(guardian2)
        .approveThresholdUpdate(vaultId, newThreshold);
      await spooVault
        .connect(guardian3)
        .approveThresholdUpdate(vaultId, newThreshold);

      // Queue both changes
      await spooVault
        .connect(owner)
        .queueVaultReconfiguration(vaultId, guardian1.address, newThreshold);

      // Fast forward past timelock
      await time.increase(24 * 60 * 60);

      // Execute both
      const tx = spooVault
        .connect(owner)
        .executeVaultReconfiguration(vaultId, guardian1.address, newThreshold);

      await expect(tx).to.emit(spooVault, "VaultReconfigurationExecuted");

      // Verify both changes applied
      const vault = await spooVault.vaults(vaultId);
      expect(vault.approvalThreshold).to.equal(newThreshold);
      expect(await spooVault.isGuardian(vaultId, guardian1.address)).to.equal(
        false
      );
    });

    it("should revert if new threshold exceeds remaining guardians after removal", async function () {
      await spooVault
        .connect(owner)
        .proposeGuardianRemoval(vaultId, guardian1.address);
      await spooVault.connect(owner).proposeThresholdUpdate(vaultId, 4);

      // Approve removal
      await spooVault
        .connect(owner)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian2)
        .approveGuardianRemoval(vaultId, guardian1.address);
      await spooVault
        .connect(guardian3)
        .approveGuardianRemoval(vaultId, guardian1.address);

      // Approve threshold
      await spooVault.connect(owner).approveThresholdUpdate(vaultId, 4);
      await spooVault.connect(guardian2).approveThresholdUpdate(vaultId, 4);
      await spooVault.connect(guardian3).approveThresholdUpdate(vaultId, 4);

      // Queue both
      await spooVault
        .connect(owner)
        .queueVaultReconfiguration(vaultId, guardian1.address, 4);

      // Fast forward past timelock
      await time.increase(24 * 60 * 60);

      // Execution should fail due to invalid threshold
      await expect(
        spooVault
          .connect(owner)
          .executeVaultReconfiguration(vaultId, guardian1.address, 4)
      ).to.be.revertedWithCustomError(spooVault, "InvalidNewThreshold");
    });
  });

  describe("Access Control", function () {
    it("should prevent non-guardian from proposing removal", async function () {
      await expect(
        spooVault
          .connect(beneficiary)
          .proposeGuardianRemoval(vaultId, guardian1.address)
      ).to.be.revertedWithCustomError(spooVault, "OnlyGuardian");
    });

    it("should prevent non-guardian from approving removal", async function () {
      await spooVault
        .connect(owner)
        .proposeGuardianRemoval(vaultId, guardian1.address);
      await expect(
        spooVault
          .connect(beneficiary)
          .approveGuardianRemoval(vaultId, guardian1.address)
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
