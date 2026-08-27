/**
 * SpooPaymaster.test.cjs
 *
 * Hardhat tests for Issue #78:
 * [EVM/AA] EIP-4337 Account Abstraction Paymaster for Gasless Guardian Approvals.
 *
 * Covers:
 * - Paymaster deployment and initial configuration
 * - Sponsorship deposits (vault-level and creator-level)
 * - Sponsorship withdrawals and access control
 * - Gasless approveAccess execution by a guardian with 0 AVAX balance
 * - Gasless acceptGuardianInvite execution by a guardian with 0 AVAX balance
 * - Validation of vault creator sponsorship balance before approving UserOp
 * - Gas refund and postOp gas accounting
 * - Per-guardian and per-vault rate limiting enforcement
 * - Protection against unauthorized target contracts and disallowed methods
 * - Direct invocation protection for validatePaymasterUserOp and postOp
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SpooPaymaster - EIP-4337 Gasless Guardian Approvals", function () {
  let spooVault;
  let entryPoint;
  let paymaster;
  let guardianAccount;

  let owner;
  let vaultCreator;
  let guardianSigner;
  let beneficiary;
  let bundler;
  let other;

  const VAULT_ID = 1;
  const DOCUMENT_ID = 1;
  const ONE_AVAX = ethers.parseEther("1.0");

  beforeEach(async function () {
    [owner, vaultCreator, guardianSigner, beneficiary, bundler, other] =
      await ethers.getSigners();

    // 1. Deploy SpooVault
    const SpooVault = await ethers.getContractFactory("SpooVault");
    spooVault = await SpooVault.deploy();
    await spooVault.waitForDeployment();

    // 2. Deploy Mock EntryPoint
    const MockEntryPoint = await ethers.getContractFactory("MockEntryPoint");
    entryPoint = await MockEntryPoint.deploy();
    await entryPoint.waitForDeployment();

    // 3. Deploy SpooPaymaster
    const SpooPaymaster = await ethers.getContractFactory("SpooPaymaster");
    paymaster = await SpooPaymaster.deploy(
      await entryPoint.getAddress(),
      await spooVault.getAddress(),
      owner.address
    );
    await paymaster.waitForDeployment();

    // 4. Deploy MockSmartAccount for guardian
    const MockSmartAccount = await ethers.getContractFactory("MockSmartAccount");
    guardianAccount = await MockSmartAccount.deploy(
      await entryPoint.getAddress(),
      guardianSigner.address
    );
    await guardianAccount.waitForDeployment();

    // Drain guardianAccount balance to ensure it has 0 AVAX
    const initialAccBal = await ethers.provider.getBalance(
      await guardianAccount.getAddress()
    );
    if (initialAccBal > 0n) {
      await guardianAccount
        .connect(guardianSigner)
        .execute(other.address, initialAccBal, "0x");
    }
  });

  describe("Deployment and Initial Setup", function () {
    it("should set entryPoint, spooVault, and owner correctly", async function () {
      expect(await paymaster.entryPoint()).to.equal(await entryPoint.getAddress());
      expect(await paymaster.spooVault()).to.equal(await spooVault.getAddress());
      expect(await paymaster.owner()).to.equal(owner.address);
    });

    it("should have expected default rate limits", async function () {
      expect(await paymaster.maxOpsPerWindow()).to.equal(10n);
      expect(await paymaster.rateLimitWindow()).to.equal(3600n);
      expect(await paymaster.maxVaultOpsPerWindow()).to.equal(50n);
    });

    it("allows owner to update rate limits and spooVault address", async function () {
      await paymaster.connect(owner).setRateLimits(20, 7200, 100);
      expect(await paymaster.maxOpsPerWindow()).to.equal(20n);
      expect(await paymaster.rateLimitWindow()).to.equal(7200n);
      expect(await paymaster.maxVaultOpsPerWindow()).to.equal(100n);

      await paymaster.connect(owner).setSpooVault(other.address);
      expect(await paymaster.spooVault()).to.equal(other.address);
    });

    it("reverts if non-owner attempts to update configuration", async function () {
      await expect(
        paymaster.connect(other).setRateLimits(5, 60, 10)
      ).to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");

      await expect(
        paymaster.connect(other).setSpooVault(other.address)
      ).to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
    });
  });

  describe("Sponsorship Deposits and Withdrawals", function () {
    it("allows vault creator to deposit funds for a specific vault", async function () {
      await paymaster
        .connect(vaultCreator)
        .depositForVault(VAULT_ID, { value: ONE_AVAX });

      expect(await paymaster.vaultSponsorBalances(VAULT_ID)).to.equal(ONE_AVAX);
      expect(await paymaster.getVaultDeposit(VAULT_ID)).to.equal(ONE_AVAX);
      expect(await entryPoint.balanceOf(await paymaster.getAddress())).to.equal(
        ONE_AVAX
      );
    });

    it("allows creator to deposit general sponsorship funds", async function () {
      await paymaster
        .connect(vaultCreator)
        .depositForCreator(vaultCreator.address, { value: ONE_AVAX });

      expect(
        await paymaster.creatorSponsorBalances(vaultCreator.address)
      ).to.equal(ONE_AVAX);
      expect(
        await paymaster.getCreatorDeposit(vaultCreator.address)
      ).to.equal(ONE_AVAX);
      expect(await entryPoint.balanceOf(await paymaster.getAddress())).to.equal(
        ONE_AVAX
      );
    });

    it("accepts direct deposits via deposit() and receive()", async function () {
      await paymaster.connect(vaultCreator).deposit({ value: ethers.parseEther("0.5") });
      expect(
        await paymaster.creatorSponsorBalances(vaultCreator.address)
      ).to.equal(ethers.parseEther("0.5"));

      await vaultCreator.sendTransaction({
        to: await paymaster.getAddress(),
        value: ethers.parseEther("0.25"),
      });
      expect(
        await paymaster.creatorSponsorBalances(vaultCreator.address)
      ).to.equal(ethers.parseEther("0.75"));
    });

    it("reverts zero deposit attempts", async function () {
      await expect(
        paymaster.connect(vaultCreator).depositForVault(VAULT_ID, { value: 0 })
      ).to.be.revertedWithCustomError(paymaster, "ZeroDeposit");

      await expect(
        paymaster
          .connect(vaultCreator)
          .depositForCreator(vaultCreator.address, { value: 0 })
      ).to.be.revertedWithCustomError(paymaster, "ZeroDeposit");
    });

    it("allows creator to withdraw unused creator deposit", async function () {
      await paymaster
        .connect(vaultCreator)
        .depositForCreator(vaultCreator.address, { value: ONE_AVAX });

      const balBefore = await ethers.provider.getBalance(vaultCreator.address);
      const tx = await paymaster
        .connect(vaultCreator)
        .withdrawCreatorDeposit(ethers.parseEther("0.4"));
      const receipt = await tx.wait();
      const gasSpent = receipt.gasUsed * receipt.gasPrice;

      const balAfter = await ethers.provider.getBalance(vaultCreator.address);
      expect(balAfter).to.equal(balBefore + ethers.parseEther("0.4") - gasSpent);

      expect(
        await paymaster.creatorSponsorBalances(vaultCreator.address)
      ).to.equal(ethers.parseEther("0.6"));
    });

    it("reverts creator withdrawal exceeding deposited balance", async function () {
      await paymaster
        .connect(vaultCreator)
        .depositForCreator(vaultCreator.address, { value: ethers.parseEther("0.1") });

      await expect(
        paymaster
          .connect(vaultCreator)
          .withdrawCreatorDeposit(ethers.parseEther("0.5"))
      ).to.be.revertedWithCustomError(paymaster, "InsufficientBalance");
    });
  });

  describe("Gasless Guardian Approvals via UserOperation", function () {
    let requestId;

    beforeEach(async function () {
      const guardianAccAddr = await guardianAccount.getAddress();

      // 1. Vault creator creates vault with guardianAccount as initial guardian
      await spooVault
        .connect(vaultCreator)
        .createVault(
          "Personal Records",
          "Test Vault",
          [guardianAccAddr],
          1
        );

      // 2. Guardian accepts invitation directly
      await spooVault.connect(guardianSigner);
      await guardianAccount
        .connect(guardianSigner)
        .execute(
          await spooVault.getAddress(),
          0n,
          spooVault.interface.encodeFunctionData("acceptGuardianInvite", [VAULT_ID])
        );

      // 3. Vault creator adds document
      await spooVault
        .connect(vaultCreator)
        .addDocument(VAULT_ID, "meta", "ipfs-hash", 0);

      // 4. Guardian mints access token NFT to beneficiary
      await guardianAccount
        .connect(guardianSigner)
        .execute(
          await spooVault.getAddress(),
          0n,
          spooVault.interface.encodeFunctionData("mintAccessToken", [
            VAULT_ID,
            beneficiary.address,
            "uri",
          ])
        );

      // 5. Vault creator deposits sponsorship funds in SpooPaymaster
      await paymaster
        .connect(vaultCreator)
        .depositForVault(VAULT_ID, { value: ONE_AVAX });

      // 6. Beneficiary requests access to the document
      const reqTx = await spooVault
        .connect(beneficiary)
        .requestAccess(DOCUMENT_ID);
      const reqRc = await reqTx.wait();
      const event = reqRc.logs.find(
        (l) => spooVault.interface.parseLog(l)?.name === "AccessRequested"
      );
      const parsed = spooVault.interface.parseLog(event);
      requestId = parsed.args.requestId;
    });

    it("executes approveAccess gaslessly for guardian with 0 AVAX", async function () {
      const guardianAccAddr = await guardianAccount.getAddress();
      const guardianBalance = await ethers.provider.getBalance(guardianAccAddr);
      expect(guardianBalance).to.equal(0n);

      // Encode approveAccess callData
      const approveInnerData = spooVault.interface.encodeFunctionData(
        "approveAccess(uint256)",
        [requestId]
      );
      const accountCallData = guardianAccount.interface.encodeFunctionData(
        "execute",
        [await spooVault.getAddress(), 0n, approveInnerData]
      );

      const paymasterAddress = await paymaster.getAddress();
      const paymasterAndData = ethers.concat([
        paymasterAddress,
        ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [VAULT_ID]),
      ]);

      const userOp = {
        sender: guardianAccAddr,
        nonce: 0n,
        initCode: "0x",
        callData: accountCallData,
        callGasLimit: 200000n,
        verificationGasLimit: 150000n,
        preVerificationGas: 50000n,
        maxFeePerGas: 1000000000n, // 1 gwei
        maxPriorityFeePerGas: 1000000000n,
        paymasterAndData,
        signature: "0x",
      };

      // Sign the UserOperation with guardianSigner EOA
      const userOpHash = await entryPoint.getUserOpHash(userOp);
      userOp.signature = await guardianSigner.signMessage(
        ethers.getBytes(userOpHash)
      );

      const sponsorBalBefore = await paymaster.vaultSponsorBalances(VAULT_ID);

      // Bundler submits UserOp to EntryPoint
      await entryPoint.connect(bundler).handleOps([userOp], bundler.address);

      // Guardian spent 0 gas
      const guardianBalanceAfter = await ethers.provider.getBalance(
        guardianAccAddr
      );
      expect(guardianBalanceAfter).to.equal(0n);

      // SpooVault recorded the approval
      expect(await spooVault.hasApprovedRequest(requestId, guardianAccAddr)).to.equal(
        true
      );
      const req = await spooVault.accessRequests(requestId);
      expect(req.status).to.equal(1); // APPROVED

      // Paymaster deducted actual gas cost from vault sponsor balance
      const sponsorBalAfter = await paymaster.vaultSponsorBalances(VAULT_ID);
      expect(sponsorBalAfter).to.be.lessThan(sponsorBalBefore);
      expect(sponsorBalAfter).to.be.greaterThan(0n);
    });

    it("executes approveAccess with encryptedShare payload gaslessly", async function () {
      const guardianAccAddr = await guardianAccount.getAddress();

      const encryptedShare = "ENCRYPTED_SHARE_FOR_BENEFICIARY";
      const approveInnerData = spooVault.interface.encodeFunctionData(
        "approveAccess(uint256,string)",
        [requestId, encryptedShare]
      );
      const accountCallData = guardianAccount.interface.encodeFunctionData(
        "execute",
        [await spooVault.getAddress(), 0n, approveInnerData]
      );

      const paymasterAddress = await paymaster.getAddress();
      const paymasterAndData = ethers.concat([
        paymasterAddress,
        ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [VAULT_ID]),
      ]);
      const userOp = {
        sender: guardianAccAddr,
        nonce: 0n,
        initCode: "0x",
        callData: accountCallData,
        callGasLimit: 500000n,
        verificationGasLimit: 150000n,
        preVerificationGas: 50000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
        paymasterAndData,
        signature: "0x",
      };

      const userOpHash = await entryPoint.getUserOpHash(userOp);
      userOp.signature = await guardianSigner.signMessage(
        ethers.getBytes(userOpHash)
      );

      await entryPoint.connect(bundler).handleOps([userOp], bundler.address);

      expect(await spooVault.hasApprovedRequest(requestId, guardianAccAddr)).to.equal(
        true
      );
      expect(
        await spooVault.beneficiaryKeyShares(requestId, guardianAccAddr)
      ).to.equal(encryptedShare);
    });

    it("executes acceptGuardianInvite gaslessly for invited guardian", async function () {
      // Deploy a second smart account for new guardian
      const MockSmartAccount = await ethers.getContractFactory("MockSmartAccount");
      const newGuardianAccount = await MockSmartAccount.deploy(
        await entryPoint.getAddress(),
        other.address
      );
      await newGuardianAccount.waitForDeployment();
      const newGuardianAddr = await newGuardianAccount.getAddress();

      // Creator creates a vault with newGuardianAddr invited
      const createTx = await spooVault
        .connect(vaultCreator)
        .createVault(
          "Invite Vault",
          "Testing gasless invite acceptance",
          [newGuardianAddr],
          1
        );
      const createRc = await createTx.wait();
      const createEvent = createRc.logs.find(
        (l) => spooVault.interface.parseLog(l)?.name === "VaultCreated"
      );
      const inviteVaultId = spooVault.interface.parseLog(createEvent).args.vaultId;

      // Creator deposits sponsorship for inviteVaultId
      await paymaster
        .connect(vaultCreator)
        .depositForVault(inviteVaultId, { value: ONE_AVAX });

      // Encode acceptGuardianInvite callData
      const acceptInnerData = spooVault.interface.encodeFunctionData(
        "acceptGuardianInvite",
        [inviteVaultId]
      );
      const accountCallData = newGuardianAccount.interface.encodeFunctionData(
        "execute",
        [await spooVault.getAddress(), 0n, acceptInnerData]
      );

      const paymasterAddress = await paymaster.getAddress();
      const userOp = {
        sender: newGuardianAddr,
        nonce: 0n,
        initCode: "0x",
        callData: accountCallData,
        callGasLimit: 200000n,
        verificationGasLimit: 150000n,
        preVerificationGas: 50000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
        paymasterAndData: paymasterAddress,
        signature: "0x",
      };

      const userOpHash = await entryPoint.getUserOpHash(userOp);
      userOp.signature = await other.signMessage(ethers.getBytes(userOpHash));

      await entryPoint.connect(bundler).handleOps([userOp], bundler.address);

      expect(await spooVault.isGuardian(inviteVaultId, newGuardianAddr)).to.equal(
        true
      );
    });

    it("reverts UserOp if vault sponsor balance is 0", async function () {
      // Deploy new vault with 0 deposit
      const tx = await spooVault
        .connect(vaultCreator)
        .createVault(
          "Unfunded Vault",
          "No sponsorship",
          [await guardianAccount.getAddress()],
          1
        );
      const rc = await tx.wait();
      const event = rc.logs.find(
        (l) => spooVault.interface.parseLog(l)?.name === "VaultCreated"
      );
      const unfundedVaultId = spooVault.interface.parseLog(event).args.vaultId;

      const acceptInnerData = spooVault.interface.encodeFunctionData(
        "acceptGuardianInvite",
        [unfundedVaultId]
      );
      const accountCallData = guardianAccount.interface.encodeFunctionData(
        "execute",
        [await spooVault.getAddress(), 0n, acceptInnerData]
      );

      const paymasterAddress = await paymaster.getAddress();
      const userOp = {
        sender: await guardianAccount.getAddress(),
        nonce: 2n,
        initCode: "0x",
        callData: accountCallData,
        callGasLimit: 200000n,
        verificationGasLimit: 150000n,
        preVerificationGas: 50000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
        paymasterAndData: paymasterAddress,
        signature: "0x",
      };

      const userOpHash = await entryPoint.getUserOpHash(userOp);
      userOp.signature = await guardianSigner.signMessage(
        ethers.getBytes(userOpHash)
      );

      await expect(
        entryPoint.connect(bundler).handleOps([userOp], bundler.address)
      ).to.be.revertedWithCustomError(paymaster, "InsufficientSponsorBalance");
    });
  });

  describe("Rate Limiting Enforcement", function () {
    let requestId;

    beforeEach(async function () {
      const guardianAccAddr = await guardianAccount.getAddress();
      await spooVault
        .connect(vaultCreator)
        .createVault("Rate Limited Vault", "Desc", [guardianAccAddr], 1);

      await guardianAccount
        .connect(guardianSigner)
        .execute(
          await spooVault.getAddress(),
          0n,
          spooVault.interface.encodeFunctionData("acceptGuardianInvite", [VAULT_ID])
        );

      await spooVault
        .connect(vaultCreator)
        .addDocument(VAULT_ID, "meta", "ipfs", 0);

      await guardianAccount
        .connect(guardianSigner)
        .execute(
          await spooVault.getAddress(),
          0n,
          spooVault.interface.encodeFunctionData("mintAccessToken", [
            VAULT_ID,
            beneficiary.address,
            "uri",
          ])
        );

      await paymaster
        .connect(vaultCreator)
        .depositForVault(VAULT_ID, { value: ONE_AVAX });

      const reqTx = await spooVault.connect(beneficiary).requestAccess(DOCUMENT_ID);
      const reqRc = await reqTx.wait();
      const event = reqRc.logs.find(
        (l) => spooVault.interface.parseLog(l)?.name === "AccessRequested"
      );
      requestId = spooVault.interface.parseLog(event).args.requestId;

      // Set strict rate limit: max 2 ops per window
      await paymaster.connect(owner).setRateLimits(2, 3600, 50);
    });

    it("reverts when guardian exceeds maxOpsPerWindow", async function () {
      const guardianAccAddr = await guardianAccount.getAddress();
      const paymasterAddress = await paymaster.getAddress();

      const buildOp = async (nonce) => {
        const inner = spooVault.interface.encodeFunctionData(
          "acceptGuardianInvite",
          [VAULT_ID]
        );
        const callData = guardianAccount.interface.encodeFunctionData("execute", [
          await spooVault.getAddress(),
          0n,
          inner,
        ]);
        const op = {
          sender: guardianAccAddr,
          nonce: BigInt(nonce),
          initCode: "0x",
          callData,
          callGasLimit: 100000n,
          verificationGasLimit: 100000n,
          preVerificationGas: 50000n,
          maxFeePerGas: 1000000000n,
          maxPriorityFeePerGas: 1000000000n,
          paymasterAndData: paymasterAddress,
          signature: "0x",
        };
        const hash = await entryPoint.getUserOpHash(op);
        op.signature = await guardianSigner.signMessage(ethers.getBytes(hash));
        return op;
      };

      // 1st op passes
      await entryPoint.connect(bundler).handleOps([await buildOp(1)], bundler.address);
      // 2nd op passes
      await entryPoint.connect(bundler).handleOps([await buildOp(2)], bundler.address);

      // 3rd op exceeds guardian rate limit
      await expect(
        entryPoint.connect(bundler).handleOps([await buildOp(3)], bundler.address)
      ).to.be.revertedWithCustomError(paymaster, "RateLimitExceeded");

      // Advance time beyond window
      await time.increase(3601);

      // 4th op passes after window reset
      await entryPoint.connect(bundler).handleOps([await buildOp(4)], bundler.address);
    });
  });

  describe("Security and Access Controls", function () {
    beforeEach(async function () {
      await paymaster
        .connect(vaultCreator)
        .depositForVault(VAULT_ID, { value: ONE_AVAX });
    });

    it("reverts if target contract is not SpooVault", async function () {
      const guardianAccAddr = await guardianAccount.getAddress();
      const unauthorizedInner = "0x12345678";
      // Target is `other` address instead of `spooVault`
      const callData = guardianAccount.interface.encodeFunctionData("execute", [
        other.address,
        0n,
        unauthorizedInner,
      ]);

      const userOp = {
        sender: guardianAccAddr,
        nonce: 0n,
        initCode: "0x",
        callData,
        callGasLimit: 100000n,
        verificationGasLimit: 100000n,
        preVerificationGas: 50000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
        paymasterAndData: await paymaster.getAddress(),
        signature: "0x",
      };

      const userOpHash = await entryPoint.getUserOpHash(userOp);
      userOp.signature = await guardianSigner.signMessage(
        ethers.getBytes(userOpHash)
      );

      await expect(
        entryPoint.connect(bundler).handleOps([userOp], bundler.address)
      ).to.be.revertedWithCustomError(paymaster, "InvalidTarget");
    });

    it("reverts if inner function selector is not an allowed guardian action", async function () {
      const guardianAccAddr = await guardianAccount.getAddress();
      // Calling mintAccessToken instead of approveAccess
      const unauthorizedInner = spooVault.interface.encodeFunctionData(
        "mintAccessToken",
        [VAULT_ID, guardianAccAddr, "uri"]
      );
      const callData = guardianAccount.interface.encodeFunctionData("execute", [
        await spooVault.getAddress(),
        0n,
        unauthorizedInner,
      ]);

      const userOp = {
        sender: guardianAccAddr,
        nonce: 0n,
        initCode: "0x",
        callData,
        callGasLimit: 100000n,
        verificationGasLimit: 100000n,
        preVerificationGas: 50000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
        paymasterAndData: await paymaster.getAddress(),
        signature: "0x",
      };

      const userOpHash = await entryPoint.getUserOpHash(userOp);
      userOp.signature = await guardianSigner.signMessage(
        ethers.getBytes(userOpHash)
      );

      await expect(
        entryPoint.connect(bundler).handleOps([userOp], bundler.address)
      ).to.be.revertedWithCustomError(paymaster, "UnauthorizedMethod");
    });

    it("reverts when validatePaymasterUserOp or postOp is called directly", async function () {
      const dummyOp = {
        sender: other.address,
        nonce: 0n,
        initCode: "0x",
        callData: "0x",
        callGasLimit: 0n,
        verificationGasLimit: 0n,
        preVerificationGas: 0n,
        maxFeePerGas: 0n,
        maxPriorityFeePerGas: 0n,
        paymasterAndData: "0x",
        signature: "0x",
      };

      await expect(
        paymaster.connect(other).validatePaymasterUserOp(dummyOp, ethers.ZeroHash, 1000n)
      ).to.be.revertedWithCustomError(paymaster, "OnlyEntryPoint");

      await expect(
        paymaster.connect(other).postOp(0, "0x", 1000n)
      ).to.be.revertedWithCustomError(paymaster, "OnlyEntryPoint");
    });
  });
});
