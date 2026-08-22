const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SpooVault Proactive Secret Resharing (zero-sharing protocol)", function () {
  let spooVault;
  let owner;
  let guardian1;
  let guardian2;
  let guardian3;
  let outsider;
  let vaultId;
  let documentId;

  const RESHARE_DURATION = 2 * 24 * 60 * 60; // 2 days

  beforeEach(async function () {
    [owner, guardian1, guardian2, guardian3, outsider] = await ethers.getSigners();

    const SpooVault = await ethers.getContractFactory("SpooVault");
    spooVault = await SpooVault.deploy();
    await spooVault.waitForDeployment();

    const guardians = [guardian1.address, guardian2.address, guardian3.address];
    await spooVault.connect(owner).createVault(
      "PSS Test Vault",
      "Proactive secret resharing vault",
      guardians,
      2
    );
    vaultId = 1;

    await spooVault.connect(guardian1).acceptGuardianInvite(vaultId);
    await spooVault.connect(guardian2).acceptGuardianInvite(vaultId);
    await spooVault.connect(guardian3).acceptGuardianInvite(vaultId);

    // Owner uploads a document with per-guardian encrypted shares.
    const tx = await spooVault
      .connect(owner)
      .addDocument(
        vaultId,
        "encrypted-metadata",
        "QmPSSDocHash",
        0, // AccessLevel.READ
        [owner.address, guardian1.address, guardian2.address, guardian3.address],
        ["share-owner", "share-g1", "share-g2", "share-g3"]
      );
    await tx.wait();
    documentId = 1;
  });

  const fakeCommitment = (seed) => {
    return [
      ethers.ZeroHash, // h_i(0) = 0 - enforced by the contract
      ethers.id(`a1-${seed}`),
      ethers.id(`a2-${seed}`),
    ];
  };

  const submitAll = async () => {
    await spooVault.connect(owner).submitZeroShareCommitment(documentId, fakeCommitment("owner"));
    await spooVault.connect(guardian1).submitZeroShareCommitment(documentId, fakeCommitment("g1"));
    await spooVault.connect(guardian2).submitZeroShareCommitment(documentId, fakeCommitment("g2"));
    await spooVault.connect(guardian3).submitZeroShareCommitment(documentId, fakeCommitment("g3"));
  };

  describe("Session lifecycle", function () {
    it("should let a guardian start a reshare session with correct epoch and deadline", async function () {
      const tx = await spooVault.connect(guardian1).startShareRefresh(documentId, RESHARE_DURATION);
      await expect(tx)
        .to.emit(spooVault, "ShareRefreshStarted")
        .withArgs(documentId, 1, (await tx.getBlock()).timestamp + RESHARE_DURATION);

      const session = await spooVault.getReshareSession(documentId);
      expect(session.active).to.equal(true);
      expect(session.submittedCount).to.equal(0);
      expect(await spooVault.shareEpoch(documentId)).to.equal(0);
    });

    it("should revert if a non-guardian starts a session", async function () {
      await expect(
        spooVault.connect(outsider).startShareRefresh(documentId, RESHARE_DURATION)
      ).to.be.revertedWithCustomError(spooVault, "OnlyGuardian");
    });

    it("should revert for a non-existent document", async function () {
      await expect(
        spooVault.connect(owner).startShareRefresh(999, RESHARE_DURATION)
      ).to.be.revertedWithCustomError(spooVault, "DocumentNotExist");
    });

    it("should reject durations outside the 1 hour .. 7 days bounds", async function () {
      await expect(
        spooVault.connect(owner).startShareRefresh(documentId, 30 * 60)
      ).to.be.revertedWithCustomError(spooVault, "InvalidReshareDuration");
      await expect(
        spooVault.connect(owner).startShareRefresh(documentId, 8 * 24 * 60 * 60)
      ).to.be.revertedWithCustomError(spooVault, "InvalidReshareDuration");
    });

    it("should not allow two concurrent sessions", async function () {
      await spooVault.connect(owner).startShareRefresh(documentId, RESHARE_DURATION);
      await expect(
        spooVault.connect(guardian1).startShareRefresh(documentId, RESHARE_DURATION)
      ).to.be.revertedWithCustomError(spooVault, "ReshareSessionAlreadyActive");
    });
  });

  describe("Zero-share commitment submission", function () {
    beforeEach(async function () {
      await spooVault.connect(owner).startShareRefresh(documentId, RESHARE_DURATION);
    });

    it("should accept valid commitments and track submission count", async function () {
      const epoch = 1;
      const tx = await spooVault
        .connect(guardian2)
        .submitZeroShareCommitment(documentId, fakeCommitment("g2"));

      await expect(tx)
        .to.emit(spooVault, "ZeroShareCommitmentSubmitted")
        .withArgs(documentId, epoch, guardian2.address, 2);

      expect((await spooVault.getReshareSession(documentId)).submittedCount).to.equal(1);
      expect(await spooVault.hasSubmittedZeroShare(documentId, epoch, guardian2.address)).to.equal(true);
      expect(await spooVault.hasSubmittedZeroShare(documentId, epoch, guardian3.address)).to.equal(false);

      const stored = await spooVault.getZeroShareCommitments(documentId, epoch, guardian2.address);
      expect(stored.length).to.equal(3);
      expect(stored[0]).to.equal(ethers.ZeroHash);
    });

    it("should enforce h_i(0) == 0 (non-zero constant term reverts)", async function () {
      const bad = [ethers.id("nonzero"), ethers.id("a1"), ethers.id("a2")];
      await expect(
        spooVault.connect(guardian1).submitZeroShareCommitment(documentId, bad)
      ).to.be.revertedWithCustomError(spooVault, "InvalidZeroShareCommitment");
    });

    it("should reject degenerate commitments (fewer than 2 coefficients)", async function () {
      await expect(
        spooVault.connect(guardian1).submitZeroShareCommitment(documentId, [ethers.ZeroHash])
      ).to.be.revertedWithCustomError(spooVault, "InvalidZeroShareCommitment");
    });

    it("should allow each guardian to submit only once per epoch", async function () {
      await spooVault.connect(guardian1).submitZeroShareCommitment(documentId, fakeCommitment("g1-a"));
      await expect(
        spooVault.connect(guardian1).submitZeroShareCommitment(documentId, fakeCommitment("g1-b"))
      ).to.be.revertedWithCustomError(spooVault, "ZeroShareAlreadySubmitted");
    });

    it("should reject submissions from non-guardians", async function () {
      await expect(
        spooVault.connect(outsider).submitZeroShareCommitment(documentId, fakeCommitment("evil"))
      ).to.be.revertedWithCustomError(spooVault, "OnlyGuardian");
    });

    it("should reject submissions after the deadline (simulated network delay)", async function () {
      await time.increase(RESHARE_DURATION + 60);
      await expect(
        spooVault.connect(guardian1).submitZeroShareCommitment(documentId, fakeCommitment("late"))
      ).to.be.revertedWithCustomError(spooVault, "ReshareDeadlineExceeded");
    });

    it("should reject submissions when no session is active", async function () {
      // Complete the current session first.
      await submitAll();
      await spooVault.connect(owner).applyShareRefresh(
        documentId,
        [owner.address, guardian1.address, guardian2.address, guardian3.address],
        ["new-share-owner", "new-share-g1", "new-share-g2", "new-share-g3"]
      );

      await expect(
        spooVault.connect(guardian1).submitZeroShareCommitment(documentId, fakeCommitment("x"))
      ).to.be.revertedWithCustomError(spooVault, "ReshareSessionNotActive");
    });
  });

  describe("Applying the refresh", function () {
    const guardianList = null; // set in beforeEach scope below

    let list;
    let newShares;

    beforeEach(async function () {
      list = [owner.address, guardian1.address, guardian2.address, guardian3.address];
      newShares = ["ns-owner", "ns-g1", "ns-g2", "ns-g3"];
      await spooVault.connect(owner).startShareRefresh(documentId, RESHARE_DURATION);
    });

    it("should revert before all guardians submitted while window is open", async function () {
      await spooVault.connect(owner).submitZeroShareCommitment(documentId, fakeCommitment("owner"));
      await spooVault.connect(guardian1).submitZeroShareCommitment(documentId, fakeCommitment("g1"));

      await expect(
        spooVault.connect(owner).applyShareRefresh(documentId, list, newShares)
      ).to.be.revertedWithCustomError(spooVault, "ReshareDeadlineNotReached");
    });

    it("should report incomplete instead of applying after deadline with missing submissions", async function () {
      await spooVault.connect(owner).submitZeroShareCommitment(documentId, fakeCommitment("owner"));
      await time.increase(RESHARE_DURATION + 10);

      await expect(
        spooVault.connect(owner).applyShareRefresh(documentId, list, newShares)
      ).to.be.revertedWithCustomError(spooVault, "ReshareIncomplete");
    });

    it("should apply once every guardian submitted: bump epoch, store shares, close session", async function () {
      await submitAll();

      const tx = await spooVault.connect(guardian3).applyShareRefresh(documentId, list, newShares);
      await expect(tx).to.emit(spooVault, "SharesRefreshed").withArgs(documentId, 1);

      expect(await spooVault.shareEpoch(documentId)).to.equal(1);
      expect((await spooVault.getReshareSession(documentId)).active).to.equal(false);

      expect(await spooVault.getEncryptedGuardianShare(documentId, guardian1.address)).to.equal("ns-g1");
      expect(await spooVault.getEncryptedGuardianShare(documentId, guardian3.address)).to.equal("ns-g3");

      // Commitments remain auditable for the live epoch.
      const stored = await spooVault.getZeroShareCommitments(documentId, 1, guardian2.address);
      expect(stored[0]).to.equal(ethers.ZeroHash);
    });

    it("should validate the guardian list (wrong length, outsiders, duplicates)", async function () {
      await submitAll();

      await expect(
        spooVault.connect(owner).applyShareRefresh(
          documentId,
          [owner.address, guardian1.address, guardian2.address],
          ["a", "b", "c"]
        )
      ).to.be.revertedWithCustomError(spooVault, "InvalidShareRefreshInput");

      await expect(
        spooVault.connect(owner).applyShareRefresh(
          documentId,
          [owner.address, guardian1.address, guardian2.address, outsider.address],
          ["a", "b", "c", "d"]
        )
      ).to.be.revertedWithCustomError(spooVault, "InvalidShareRefreshInput");

      await expect(
        spooVault.connect(owner).applyShareRefresh(
          documentId,
          [owner.address, owner.address, guardian2.address, guardian3.address],
          ["a", "b", "c", "d"]
        )
      ).to.be.revertedWithCustomError(spooVault, "InvalidShareRefreshInput");
    });

    it("should require a guardian to trigger the finalization", async function () {
      await submitAll();
      await expect(
        spooVault.connect(outsider).applyShareRefresh(documentId, list, newShares)
      ).to.be.revertedWithCustomError(spooVault, "OnlyGuardian");
    });

    it("should support repeated refresh rounds with incrementing epochs", async function () {
      await submitAll();
      await spooVault.connect(owner).applyShareRefresh(documentId, list, newShares);
      expect(await spooVault.shareEpoch(documentId)).to.equal(1);

      // Round 2
      await spooVault.connect(guardian2).startShareRefresh(documentId, RESHARE_DURATION);
      await submitAll();
      const shares2 = ["n2-owner", "n2-g1", "n2-g2", "n2-g3"];
      await spooVault.connect(owner).applyShareRefresh(documentId, list, shares2);

      expect(await spooVault.shareEpoch(documentId)).to.equal(2);
      expect(await spooVault.getEncryptedGuardianShare(documentId, guardian2.address)).to.equal("n2-g2");
      // Epoch-1 submission flag must not leak into epoch 2.
      expect(await spooVault.hasSubmittedZeroShare(documentId, 2, guardian1.address)).to.equal(true);
      expect(await spooVault.hasSubmittedZeroShare(documentId, 3, guardian1.address)).to.equal(false);
    });
  });
});
