const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SpooVault Cross-Contract Access Delegation (ISpooVault / ERC-165)", function () {
  let spooVault;
  let consumer;
  let owner;
  let guardian1;
  let beneficiary;

  // Standard ERC-165 and ERC-721 interface identifiers.
  const ERC165_INTERFACE_ID = "0x01ffc9a7";
  const ERC721_INTERFACE_ID = "0x80ac58cd";

  beforeEach(async function () {
    [owner, guardian1, beneficiary] = await ethers.getSigners();

    const SpooVault = await ethers.getContractFactory("SpooVault");
    spooVault = await SpooVault.deploy();
    await spooVault.waitForDeployment();

    const SpooVaultConsumer = await ethers.getContractFactory(
      "SpooVaultConsumer"
    );
    consumer = await SpooVaultConsumer.deploy();
    await consumer.waitForDeployment();
  });

  describe("ERC-165 interface discovery", function () {
    it("exposes a non-zero ISpooVault interface id", async function () {
      const id = await consumer.SPOOVAULT_INTERFACE_ID();
      expect(id).to.not.equal("0x00000000");
    });

    it("SpooVault reports support for ISpooVault via supportsInterface", async function () {
      const id = await consumer.SPOOVAULT_INTERFACE_ID();
      expect(await spooVault.supportsInterface(id)).to.equal(true);
    });

    it("SpooVault still supports the base ERC-165 and ERC-721 interfaces", async function () {
      expect(await spooVault.supportsInterface(ERC165_INTERFACE_ID)).to.equal(
        true
      );
      expect(await spooVault.supportsInterface(ERC721_INTERFACE_ID)).to.equal(
        true
      );
    });

    it("third-party consumer detects SpooVault through isSpooVault()", async function () {
      expect(await consumer.isSpooVault(await spooVault.getAddress())).to.equal(
        true
      );
    });

    it("isSpooVault() returns false for an EOA / non-SpooVault address", async function () {
      const eoa = beneficiary.address; // an EOA, not a SpooVault deployment
      expect(await consumer.isSpooVault(eoa)).to.equal(false);
    });
  });

  describe("Standardized checkAccess hook", function () {
    beforeEach(async function () {
      const guardians = [guardian1.address];
      await spooVault
        .connect(owner)
        .createVault("Delegation Vault", "Desc", guardians, 1);
      await spooVault.connect(owner).addDocument(1, "meta", "QmTestHash", 0);
    });

    it("returns 2 (ACCESS_GRANTED) for a guardian/owner", async function () {
      expect(await spooVault.checkAccess(1, owner.address)).to.equal(2);
      expect(
        await consumer.delegatedAccessCheck(
          await spooVault.getAddress(),
          1,
          owner.address
        )
      ).to.equal(2);
    });

    it("returns 1 (ACCESS_DENIED) for a user with no access", async function () {
      expect(await spooVault.checkAccess(1, beneficiary.address)).to.equal(1);
      expect(
        await consumer.delegatedAccessCheck(
          await spooVault.getAddress(),
          1,
          beneficiary.address
        )
      ).to.equal(1);
    });

    it("returns 0 (DOCUMENT_NOT_FOUND) for a non-existent document", async function () {
      expect(await spooVault.checkAccess(999, owner.address)).to.equal(0);
      expect(
        await consumer.delegatedAccessCheck(
          await spooVault.getAddress(),
          999,
          owner.address
        )
      ).to.equal(0);
    });

    it("hasActiveAccess agrees with checkAccess()", async function () {
      expect(await spooVault.hasActiveAccess(1, owner.address)).to.equal(true);
      expect(await spooVault.hasActiveAccess(1, beneficiary.address)).to.equal(
        false
      );
    });
  });

  describe("Consumer delegation helpers", function () {
    beforeEach(async function () {
      const guardians = [guardian1.address];
      await spooVault
        .connect(owner)
        .createVault("Delegation Vault", "Desc", guardians, 1);
    });

    it("isGuardianOf reflects guardian membership", async function () {
      expect(
        await consumer.isGuardianOf(
          await spooVault.getAddress(),
          1,
          owner.address
        )
      ).to.equal(true);
      expect(
        await consumer.isGuardianOf(
          await spooVault.getAddress(),
          1,
          beneficiary.address
        )
      ).to.equal(false);
    });

    it("resolveVaultCreator returns the vault creator", async function () {
      expect(
        await consumer.resolveVaultCreator(await spooVault.getAddress(), 1)
      ).to.equal(owner.address);
    });

    it("getVaultCreator / getApprovalThreshold are callable directly", async function () {
      expect(await spooVault.getVaultCreator(1)).to.equal(owner.address);
      expect(await spooVault.getApprovalThreshold(1)).to.equal(1);
    });
  });
});
