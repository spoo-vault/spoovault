const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SpooVault ERC-6551 Integration Tests", function () {
  let spooVault;
  let registry;
  let tbaImplementation;
  let owner;
  let guardian1;
  let otherAccount;

  beforeEach(async function () {
    [owner, guardian1, otherAccount] = await ethers.getSigners();

    // Deploy SpooVault
    const SpooVault = await ethers.getContractFactory("SpooVault");
    spooVault = await SpooVault.deploy();
    await spooVault.waitForDeployment();

    // Deploy ERC6551Registry
    const Registry = await ethers.getContractFactory("ERC6551Registry");
    registry = await Registry.deploy();
    await registry.waitForDeployment();

    // Deploy SpooAccountImplementation
    const TBAImpl = await ethers.getContractFactory("SpooAccountImplementation");
    tbaImplementation = await TBAImpl.deploy();
    await tbaImplementation.waitForDeployment();

    // Initialize SpooVault with ERC6551 settings
    await spooVault.initializeERC6551(
      await registry.getAddress(),
      await tbaImplementation.getAddress()
    );
  });

  describe("Token Bound Account Creation and Address Computation", function () {
    let vaultId = 1;
    let tokenId;

    beforeEach(async function () {
      // Create a vault
      await spooVault.connect(owner).createVault(
        "TBA Vault",
        "Testing ERC6551",
        [guardian1.address],
        1
      );

      // Mint NFT Access Token
      const tx = await spooVault.connect(owner).mintAccessToken(vaultId, owner.address, "ipfs://test");
      const receipt = await tx.wait();
      
      const event = receipt.logs.find(
        (log) => log.fragment && log.fragment.name === "NFTMinted"
      );
      tokenId = event.args[0];
    });

    it("should compute the correct TBA address", async function () {
      const computedAddress = await spooVault.computeVaultAccount(tokenId);
      
      const registryAddress = await registry.account(
        await tbaImplementation.getAddress(),
        ethers.ZeroHash,
        (await ethers.provider.getNetwork()).chainId,
        await spooVault.getAddress(),
        tokenId
      );

      expect(computedAddress).to.equal(registryAddress);
    });

    it("should allow the registry to deploy the TBA", async function () {
      const computedAddress = await spooVault.computeVaultAccount(tokenId);

      // Check that code is empty before deployment
      let code = await ethers.provider.getCode(computedAddress);
      expect(code).to.equal("0x");

      // Deploy the TBA
      await expect(
        registry.createAccount(
          await tbaImplementation.getAddress(),
          ethers.ZeroHash,
          (await ethers.provider.getNetwork()).chainId,
          await spooVault.getAddress(),
          tokenId
        )
      ).to.emit(registry, "ERC6551AccountCreated");

      // Check that code exists after deployment
      code = await ethers.provider.getCode(computedAddress);
      expect(code).to.not.equal("0x");

      // Check that the token() function returns correct data
      const tba = await ethers.getContractAt("SpooAccountImplementation", computedAddress);
      const [chainId, tokenContract, retTokenId] = await tba.token();
      
      expect(chainId).to.equal((await ethers.provider.getNetwork()).chainId);
      expect(tokenContract).to.equal(await spooVault.getAddress());
      expect(retTokenId).to.equal(tokenId);
      
      // Check owner is correctly resolved
      expect(await tba.owner()).to.equal(owner.address);
    });
  });

  describe("TBA Asset Holding and Execution", function () {
    let vaultId = 1;
    let tokenId;
    let tbaAddress;
    let tba;

    beforeEach(async function () {
      await spooVault.connect(owner).createVault("TBA Vault 2", "Test", [guardian1.address], 1);
      
      const tx = await spooVault.connect(owner).mintAccessToken(vaultId, owner.address, "ipfs://test");
      const receipt = await tx.wait();
      const event = receipt.logs.find(log => log.fragment && log.fragment.name === "NFTMinted");
      tokenId = event.args[0];

      await registry.createAccount(
        await tbaImplementation.getAddress(),
        ethers.ZeroHash,
        (await ethers.provider.getNetwork()).chainId,
        await spooVault.getAddress(),
        tokenId
      );

      tbaAddress = await spooVault.computeVaultAccount(tokenId);
      tba = await ethers.getContractAt("SpooAccountImplementation", tbaAddress);
    });

    it("should receive ETH", async function () {
      const amount = ethers.parseEther("1.0");
      await owner.sendTransaction({
        to: tbaAddress,
        value: amount
      });

      const balance = await ethers.provider.getBalance(tbaAddress);
      expect(balance).to.equal(amount);
    });

    it("should allow NFT owner to execute calls", async function () {
      const amount = ethers.parseEther("1.0");
      await owner.sendTransaction({
        to: tbaAddress,
        value: amount
      });

      const startBalance = await ethers.provider.getBalance(otherAccount.address);
      
      // Transfer 0.5 ETH from TBA to otherAccount
      const transferAmount = ethers.parseEther("0.5");
      await tba.connect(owner).executeCall(otherAccount.address, transferAmount, "0x");

      const endBalance = await ethers.provider.getBalance(otherAccount.address);
      expect(endBalance - startBalance).to.equal(transferAmount);

      // State should increment
      expect(await tba.state()).to.equal(1);
    });

    it("should revert if non-owner tries to execute calls", async function () {
      const amount = ethers.parseEther("1.0");
      await tba.connect(otherAccount).executeCall(otherAccount.address, amount, "0x").catch(e => {
        expect(e.message).to.include("NotAuthorized"); // Using include since custom error might be formatted differently in ethers v6 if not decoded properly, but let's test it strictly.
      });
      // A better way to test custom error:
      await expect(
        tba.connect(otherAccount).executeCall(otherAccount.address, amount, "0x")
      ).to.be.revertedWithCustomError(tba, "NotAuthorized");
    });

    it("should delegate access when NFT is transferred", async function () {
      // Transfer NFT to guardian1
      await spooVault.connect(owner).transferFrom(owner.address, guardian1.address, tokenId);

      // New owner should be guardian1
      expect(await tba.owner()).to.equal(guardian1.address);

      // Old owner should not be able to execute calls
      await expect(
        tba.connect(owner).executeCall(otherAccount.address, 0, "0x")
      ).to.be.revertedWithCustomError(tba, "NotAuthorized");

      // New owner should be able to execute calls
      await expect(
        tba.connect(guardian1).executeCall(otherAccount.address, 0, "0x")
      ).to.not.be.reverted;
    });
  });
});
