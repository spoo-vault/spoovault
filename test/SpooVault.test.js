import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";

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
      const threshold = 2;

      const tx = await spooVault.connect(owner).createVault(
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
        spooVault.connect(owner).createVault("Invalid Threshold Vault", "Desc", guardians, 0)
      ).to.be.revertedWithCustomError(spooVault, "InvalidApprovalThreshold");

      await expect(
        spooVault.connect(owner).createVault("Over Threshold Vault", "Desc", guardians, 5)
      ).to.be.revertedWithCustomError(spooVault, "InvalidApprovalThreshold");
    });
  });

  describe("Vault Release State & Proof of Life", function () {
    it("should allow vault creator to record proof of life", async function () {
      const guardians = [guardian1.address];
      await spooVault.connect(owner).createVault("Inheritance Vault", "Desc", guardians, 1);

      await expect(spooVault.connect(owner).proveLife(1))
        .to.emit(spooVault, "ProofOfLifeRecorded");
    });

    it("should allow vault creator to toggle emergency mode", async function () {
      const guardians = [guardian1.address];
      await spooVault.connect(owner).createVault("Emergency Vault", "Desc", guardians, 1);

      await expect(spooVault.connect(owner).setEmergencyMode(1, true))
        .to.emit(spooVault, "EmergencyModeUpdated")
        .withArgs(1, true);
    });
  });

  describe("Guardian Invites", function () {
    it("should allow a guardian to accept an invite and become an active guardian", async function () {
      await spooVault.connect(owner).createVault("Vault A", "Desc", [guardian1.address], 1);

      const pendingBefore = await spooVault.getPendingInvites(guardian1.address);
      expect(pendingBefore.length).to.equal(1);
      expect(pendingBefore[0].vaultId).to.equal(1);
      expect(pendingBefore[0].accepted).to.equal(false);

      await expect(spooVault.connect(guardian1).acceptGuardianInvite(1))
        .to.emit(spooVault, "GuardianAdded")
        .withArgs(1, guardian1.address);

      const pendingAfter = await spooVault.getPendingInvites(guardian1.address);
      expect(pendingAfter.length).to.equal(0);

      const isGuardian = await spooVault.isGuardian(1, guardian1.address);
      expect(isGuardian).to.be.true;
    });

    it("should revert acceptGuardianInvite for non-existent invite", async function () {
      await spooVault.connect(owner).createVault("Vault A", "Desc", [guardian2.address], 1);

      await expect(
        spooVault.connect(guardian1).acceptGuardianInvite(1)
      ).to.be.revertedWithCustomError(spooVault, "NoValidInvite");
    });

    it("should return pending invites for a user across multiple vaults", async function () {
      await spooVault.connect(owner).createVault("Vault A", "Desc", [guardian1.address], 1);
      await spooVault.connect(owner).createVault("Vault B", "Desc", [guardian1.address], 1);

      const pending = await spooVault.getPendingInvites(guardian1.address);
      expect(pending.length).to.equal(2);
      const vaultIds = pending.map((inv) => Number(inv.vaultId)).sort();
      expect(vaultIds).to.deep.equal([1, 2]);
    });

    it("should not include accepted invites in getPendingInvites", async function () {
      await spooVault.connect(owner).createVault("Vault A", "Desc", [guardian1.address], 1);
      await spooVault.connect(guardian1).acceptGuardianInvite(1);

      const pending = await spooVault.getPendingInvites(guardian1.address);
      expect(pending.length).to.equal(0);
    });

    it("should revert acceptGuardianInvite for expired invite", async function () {
      await spooVault.connect(owner).createVault("Vault A", "Desc", [guardian1.address], 1);

      await time.increase(7 * 24 * 60 * 60 + 1);

      await expect(
        spooVault.connect(guardian1).acceptGuardianInvite(1)
      ).to.be.revertedWithCustomError(spooVault, "InviteExpired");
    });

    it("should exclude expired invites from getPendingInvites", async function () {
      await spooVault.connect(owner).createVault("Vault A", "Desc", [guardian1.address], 1);

      await time.increase(7 * 24 * 60 * 60 + 1);

      const pending = await spooVault.getPendingInvites(guardian1.address);
      expect(pending.length).to.equal(0);
    });
  });

  describe("Post-Death Release: timestamp + block confirmation", function () {
    it("should NOT unlock post-death release from timestamp manipulation alone without block progression", async function () {
      const guardians = [guardian1.address];
      await spooVault.connect(owner).createVault("Inheritance Vault", "Desc", guardians, 1);
      await spooVault.connect(owner).configureVaultRelease(1, 1 * 24 * 60 * 60); // 1 day

      // Simulate a manipulated/skewed timestamp far in the future while only
      // a single block has actually been mined since the last proof of life.
      await time.increase(2 * 24 * 60 * 60);
      await mine(1);

      const state = await spooVault.getVaultReleaseState(1);
      expect(state.postDeathUnlocked).to.equal(false);
    });

    it("should unlock post-death release once both the timestamp threshold and minimum block delta have elapsed", async function () {
      const guardians = [guardian1.address];
      await spooVault.connect(owner).createVault("Inheritance Vault", "Desc", guardians, 1);
      await spooVault.connect(owner).configureVaultRelease(1, 1 * 24 * 60 * 60); // 1 day

      await time.increase(2 * 24 * 60 * 60);
      const minBlockDelta = await spooVault.MIN_POST_DEATH_BLOCK_DELTA();
      await mine(minBlockDelta);

      const state = await spooVault.getVaultReleaseState(1);
      expect(state.postDeathUnlocked).to.equal(true);
    });
  });
});
