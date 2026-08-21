const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("SpooVault Web3 Keeper Heartbeat Relay", function () {
  let spooVault;
  let owner;
  let guardian1;
  let keeper;
  let otherKeeper;
  let relayer;
  let vaultId;
  let domain;

  const KEEPER_AUTHORIZATION_TYPES = {
    KeeperAuthorization: [
      { name: "vaultId", type: "uint256" },
      { name: "keeper", type: "address" },
      { name: "expiresAt", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };

  async function signAuthorization(signer, { vaultIdValue, keeperAddress, expiresAt, nonce }) {
    return signer.signTypedData(domain, KEEPER_AUTHORIZATION_TYPES, {
      vaultId: vaultIdValue,
      keeper: keeperAddress,
      expiresAt,
      nonce,
    });
  }

  beforeEach(async function () {
    [owner, guardian1, keeper, otherKeeper, relayer] = await ethers.getSigners();

    const SpooVault = await ethers.getContractFactory("SpooVault");
    spooVault = await SpooVault.deploy();
    await spooVault.waitForDeployment();

    await spooVault.connect(owner).createVault("Automated Vault", "Desc", [guardian1.address], 1);
    vaultId = 1;

    const { chainId } = await ethers.provider.getNetwork();
    domain = {
      name: "SpooVault",
      version: "1",
      chainId,
      verifyingContract: await spooVault.getAddress(),
    };
  });

  it("lets anyone relay an EIP-712 signed keeper authorization, then the keeper heartbeats without a fresh signature", async function () {
    const expiresAt = (await time.latest()) + 30 * 24 * 60 * 60;
    const signature = await signAuthorization(owner, {
      vaultIdValue: vaultId,
      keeperAddress: keeper.address,
      expiresAt,
      nonce: 0,
    });

    await expect(
      spooVault.connect(relayer).authorizeKeeperBySig(vaultId, keeper.address, expiresAt, signature)
    )
      .to.emit(spooVault, "KeeperAuthorized")
      .withArgs(vaultId, owner.address, keeper.address, expiresAt);

    const authorization = await spooVault.keeperAuthorizations(vaultId);
    expect(authorization.keeper).to.equal(keeper.address);
    expect(authorization.expiresAt).to.equal(expiresAt);

    await expect(spooVault.connect(keeper).proveLifeByKeeper(vaultId))
      .to.emit(spooVault, "ProofOfLifeRelayed")
      .withArgs(vaultId, owner.address, keeper.address, anyValue);

    // The keeper can heartbeat again later with no further owner signature required.
    await time.increase(60 * 60);
    await expect(spooVault.connect(keeper).proveLifeByKeeper(vaultId)).to.not.be.reverted;
  });

  it("reverts proveLifeByKeeper for an address with no keeper authorization", async function () {
    await expect(
      spooVault.connect(keeper).proveLifeByKeeper(vaultId)
    ).to.be.revertedWithCustomError(spooVault, "KeeperNotAuthorized");
  });

  it("reverts proveLifeByKeeper for a keeper that isn't the one authorized", async function () {
    const expiresAt = (await time.latest()) + 30 * 24 * 60 * 60;
    const signature = await signAuthorization(owner, {
      vaultIdValue: vaultId,
      keeperAddress: keeper.address,
      expiresAt,
      nonce: 0,
    });
    await spooVault.connect(relayer).authorizeKeeperBySig(vaultId, keeper.address, expiresAt, signature);

    await expect(
      spooVault.connect(otherKeeper).proveLifeByKeeper(vaultId)
    ).to.be.revertedWithCustomError(spooVault, "KeeperNotAuthorized");
  });

  it("reverts proveLifeByKeeper once the authorization has expired", async function () {
    const expiresAt = (await time.latest()) + 60 * 60;
    const signature = await signAuthorization(owner, {
      vaultIdValue: vaultId,
      keeperAddress: keeper.address,
      expiresAt,
      nonce: 0,
    });
    await spooVault.connect(relayer).authorizeKeeperBySig(vaultId, keeper.address, expiresAt, signature);

    await time.increaseTo(expiresAt + 1);

    await expect(
      spooVault.connect(keeper).proveLifeByKeeper(vaultId)
    ).to.be.revertedWithCustomError(spooVault, "KeeperAuthorizationExpired");
  });

  it("reverts authorizeKeeperBySig when the signature was not produced by the vault creator", async function () {
    const expiresAt = (await time.latest()) + 30 * 24 * 60 * 60;
    const signature = await signAuthorization(guardian1, {
      vaultIdValue: vaultId,
      keeperAddress: keeper.address,
      expiresAt,
      nonce: 0,
    });

    await expect(
      spooVault.connect(relayer).authorizeKeeperBySig(vaultId, keeper.address, expiresAt, signature)
    ).to.be.revertedWithCustomError(spooVault, "InvalidSigner");
  });

  it("reverts authorizeKeeperBySig with an expiry already in the past", async function () {
    const expiresAt = (await time.latest()) - 1;
    const signature = await signAuthorization(owner, {
      vaultIdValue: vaultId,
      keeperAddress: keeper.address,
      expiresAt,
      nonce: 0,
    });

    await expect(
      spooVault.connect(relayer).authorizeKeeperBySig(vaultId, keeper.address, expiresAt, signature)
    ).to.be.revertedWithCustomError(spooVault, "KeeperExpiryInPast");
  });

  it("rejects replaying a stale signature after the vault's keeper-auth nonce has moved on", async function () {
    const expiresAt = (await time.latest()) + 30 * 24 * 60 * 60;
    const signature = await signAuthorization(owner, {
      vaultIdValue: vaultId,
      keeperAddress: keeper.address,
      expiresAt,
      nonce: 0,
    });
    await spooVault.connect(relayer).authorizeKeeperBySig(vaultId, keeper.address, expiresAt, signature);
    expect(await spooVault.keeperAuthNonces(vaultId)).to.equal(1);

    // Replaying the exact same (now stale) signature must fail: it was signed against nonce 0.
    await expect(
      spooVault.connect(relayer).authorizeKeeperBySig(vaultId, keeper.address, expiresAt, signature)
    ).to.be.revertedWithCustomError(spooVault, "InvalidSigner");
  });

  it("lets the owner revoke an active keeper authorization", async function () {
    const expiresAt = (await time.latest()) + 30 * 24 * 60 * 60;
    const signature = await signAuthorization(owner, {
      vaultIdValue: vaultId,
      keeperAddress: keeper.address,
      expiresAt,
      nonce: 0,
    });
    await spooVault.connect(relayer).authorizeKeeperBySig(vaultId, keeper.address, expiresAt, signature);

    await expect(spooVault.connect(owner).revokeKeeper(vaultId))
      .to.emit(spooVault, "KeeperRevoked")
      .withArgs(vaultId, owner.address);

    await expect(
      spooVault.connect(keeper).proveLifeByKeeper(vaultId)
    ).to.be.revertedWithCustomError(spooVault, "KeeperNotAuthorized");
  });

  it("reverts revokeKeeper when called by anyone other than the vault creator", async function () {
    await expect(
      spooVault.connect(guardian1).revokeKeeper(vaultId)
    ).to.be.revertedWithCustomError(spooVault, "OnlyVaultCreator");
  });

  it("reverts authorizeKeeperBySig and proveLifeByKeeper for a non-existent vault", async function () {
    const expiresAt = (await time.latest()) + 30 * 24 * 60 * 60;
    const signature = await signAuthorization(owner, {
      vaultIdValue: 999,
      keeperAddress: keeper.address,
      expiresAt,
      nonce: 0,
    });

    await expect(
      spooVault.connect(relayer).authorizeKeeperBySig(999, keeper.address, expiresAt, signature)
    ).to.be.revertedWithCustomError(spooVault, "VaultNotExist");

    await expect(
      spooVault.connect(keeper).proveLifeByKeeper(999)
    ).to.be.revertedWithCustomError(spooVault, "VaultNotExist");
  });

  it("still lets the owner heartbeat directly via proveLife regardless of keeper delegation", async function () {
    const expiresAt = (await time.latest()) + 30 * 24 * 60 * 60;
    const signature = await signAuthorization(owner, {
      vaultIdValue: vaultId,
      keeperAddress: keeper.address,
      expiresAt,
      nonce: 0,
    });
    await spooVault.connect(relayer).authorizeKeeperBySig(vaultId, keeper.address, expiresAt, signature);

    await expect(spooVault.connect(owner).proveLife(vaultId)).to.emit(spooVault, "ProofOfLifeRecorded");
  });
});
