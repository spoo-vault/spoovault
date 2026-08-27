import { describe, it, expect, vi } from "vitest";
import { ethers } from "ethers";
import {
  userOpService,
  buildApproveAccessCallData,
  buildAcceptGuardianInviteCallData,
  buildAccountExecuteCallData,
  buildPaymasterAndData,
  packUserOp,
  getUserOpHash,
  signUserOp,
  buildGaslessUserOp,
  buildGaslessApproveAccess,
  buildGaslessAcceptInvite,
  formatUserOpForRpc,
  sendUserOpToBundler,
  getUserOperationReceipt,
  createPaymasterClient,
  UserOperation,
} from "../services/userOp.service";

describe("userOp.service", () => {
  const sampleWallet = ethers.Wallet.createRandom();
  const entryPointAddress = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
  const paymasterAddress = "0x0000000000000000000000000000000000001234";
  const spooVaultAddress = "0x0000000000000000000000000000000000005678";
  const chainId = 43113; // Fuji testnet

  it("exports userOpService namespace with all expected methods", () => {
    expect(userOpService.buildGaslessApproveAccess).toBeDefined();
    expect(userOpService.buildGaslessAcceptInvite).toBeDefined();
    expect(userOpService.getUserOpHash).toBeDefined();
    expect(userOpService.createPaymasterClient).toBeDefined();
  });

  describe("CallData Encoders", () => {
    it("encodes approveAccess(uint256) correctly", () => {
      const callData = buildApproveAccessCallData(42);
      expect(callData.startsWith("0x568497bb")).toBe(true);

      const iface = new ethers.Interface([
        "function approveAccess(uint256 requestId) external",
      ]);
      const decoded = iface.decodeFunctionData("approveAccess", callData);
      expect(decoded.requestId).toBe(42n);
    });

    it("encodes approveAccess(uint256,string) correctly", () => {
      const callData = buildApproveAccessCallData(42, "MY_ENCRYPTED_SHARE");
      expect(callData.startsWith("0xc050099e")).toBe(true);

      const iface = new ethers.Interface([
        "function approveAccess(uint256 requestId, string encryptedShareForBeneficiary) external",
      ]);
      const decoded = iface.decodeFunctionData(
        "approveAccess(uint256,string)",
        callData
      );
      expect(decoded.requestId).toBe(42n);
      expect(decoded.encryptedShareForBeneficiary).toBe("MY_ENCRYPTED_SHARE");
    });

    it("encodes acceptGuardianInvite(uint256) correctly", () => {
      const callData = buildAcceptGuardianInviteCallData(7);
      expect(callData.startsWith("0x0f576ff1")).toBe(true);

      const iface = new ethers.Interface([
        "function acceptGuardianInvite(uint256 vaultId) external",
      ]);
      const decoded = iface.decodeFunctionData("acceptGuardianInvite", callData);
      expect(decoded.vaultId).toBe(7n);
    });

    it("wraps inner calls into account execute(address,uint256,bytes)", () => {
      const inner = "0x12345678";
      const callData = buildAccountExecuteCallData(spooVaultAddress, 0n, inner);
      expect(callData.startsWith("0xb61d27f6")).toBe(true);

      const iface = new ethers.Interface([
        "function execute(address dest, uint256 value, bytes calldata func) external",
      ]);
      const decoded = iface.decodeFunctionData("execute", callData);
      expect(decoded.dest.toLowerCase()).toBe(spooVaultAddress.toLowerCase());
      expect(decoded.value).toBe(0n);
      expect(decoded.func).toBe(inner);
    });
  });

  describe("Paymaster Data Builder", () => {
    it("returns clean checksummed address when no vaultId is supplied", () => {
      const data = buildPaymasterAndData(paymasterAddress);
      expect(data).toBe(ethers.getAddress(paymasterAddress));
    });

    it("concatenates 32-byte encoded vaultId when provided", () => {
      const data = buildPaymasterAndData(paymasterAddress, 1);
      const expectedPrefix = ethers.getAddress(paymasterAddress);
      expect(data.startsWith(expectedPrefix)).toBe(true);
      expect(data.length).toBe(expectedPrefix.length + 64); // 42 + 64 = 106 hex chars (with 0x)
    });
  });

  describe("UserOperation Packaging & Hashing", () => {
    const baseUserOp: UserOperation = {
      sender: "0x1111111111111111111111111111111111111111",
      nonce: 0n,
      initCode: "0x",
      callData: "0xabcdef",
      callGasLimit: 200000n,
      verificationGasLimit: 150000n,
      preVerificationGas: 50000n,
      maxFeePerGas: 25000000000n,
      maxPriorityFeePerGas: 1500000000n,
      paymasterAndData: paymasterAddress,
      signature: "0x",
    };

    it("packs UserOperation deterministically", () => {
      const packed1 = packUserOp(baseUserOp);
      const packed2 = packUserOp({ ...baseUserOp });
      expect(packed1).toBe(packed2);
      expect(packed1.startsWith("0x")).toBe(true);
    });

    it("computes standard EIP-4337 userOpHash", () => {
      const hash1 = getUserOpHash(baseUserOp, entryPointAddress, chainId);
      const hash2 = getUserOpHash(baseUserOp, entryPointAddress, chainId);
      expect(hash1).toBe(hash2);
      expect(ethers.isHexString(hash1, 32)).toBe(true);

      // Changing nonce changes the hash
      const hashDifferentNonce = getUserOpHash(
        { ...baseUserOp, nonce: 1n },
        entryPointAddress,
        chainId
      );
      expect(hashDifferentNonce).not.toBe(hash1);
    });

    it("signs UserOp and verifies recoverable signer address", async () => {
      const signedOp = await signUserOp(
        baseUserOp,
        sampleWallet,
        entryPointAddress,
        chainId
      );
      expect(signedOp.signature).not.toBe("0x");

      const hash = getUserOpHash(baseUserOp, entryPointAddress, chainId);
      const recovered = ethers.recoverAddress(
        ethers.hashMessage(ethers.getBytes(hash)),
        signedOp.signature
      );
      expect(recovered.toLowerCase()).toBe(sampleWallet.address.toLowerCase());
    });
  });

  describe("High-Level Gasless Builders", () => {
    it("builds gasless approveAccess UserOp with valid defaults and signature", async () => {
      const op = await buildGaslessApproveAccess({
        guardianAccount: sampleWallet.address,
        requestId: 10,
        paymasterAddress,
        spooVaultAddress,
        entryPointAddress,
        chainId,
        signer: sampleWallet,
        vaultId: 1,
      });

      expect(op.sender.toLowerCase()).toBe(sampleWallet.address.toLowerCase());
      expect(op.callData.startsWith("0xb61d27f6")).toBe(true);
      expect(op.paymasterAndData.startsWith(ethers.getAddress(paymasterAddress))).toBe(
        true
      );
      expect(op.signature).not.toBe("0x");
      expect(op.callGasLimit).toBeGreaterThan(0n);
    });

    it("builds gasless acceptGuardianInvite UserOp with valid defaults and signature", async () => {
      const op = await buildGaslessAcceptInvite({
        guardianAccount: sampleWallet.address,
        vaultId: 5,
        paymasterAddress,
        spooVaultAddress,
        entryPointAddress,
        chainId,
        signer: sampleWallet,
      });

      expect(op.sender.toLowerCase()).toBe(sampleWallet.address.toLowerCase());
      expect(op.callData.startsWith("0xb61d27f6")).toBe(true);
      expect(op.paymasterAndData.toLowerCase().startsWith(paymasterAddress.toLowerCase())).toBe(true);
      expect(op.signature).not.toBe("0x");
    });
  });

  describe("RPC Formatting & Bundler Client", () => {
    it("formats UserOp as hex strings for JSON-RPC", () => {
      const userOp = buildGaslessUserOp({
        sender: sampleWallet.address,
        target: spooVaultAddress,
        innerCallData: "0x1234",
        paymasterAddress,
        nonce: 0n,
      });

      const rpcFormatted = formatUserOpForRpc(userOp);
      expect(rpcFormatted.sender).toBe(ethers.getAddress(sampleWallet.address));
      expect(rpcFormatted.nonce).toBe("0x0");
      expect(rpcFormatted.callGasLimit.startsWith("0x")).toBe(true);
      expect(rpcFormatted.verificationGasLimit.startsWith("0x")).toBe(true);
      expect(rpcFormatted.maxFeePerGas.startsWith("0x")).toBe(true);
    });

    it("submits UserOp via eth_sendUserOperation to bundler RPC", async () => {
      const mockUserOp = buildGaslessUserOp({
        sender: sampleWallet.address,
        target: spooVaultAddress,
        innerCallData: "0x1234",
        paymasterAddress,
      });

      const expectedTxHash = "0xabcdef1234567890";
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: expectedTxHash }),
      } as any);

      const txHash = await sendUserOpToBundler(
        mockUserOp,
        entryPointAddress,
        "https://bundler.fuji.example.com"
      );

      expect(txHash).toBe(expectedTxHash);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://bundler.fuji.example.com",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      );
    });

    it("throws when bundler returns an RPC error", async () => {
      const mockUserOp = buildGaslessUserOp({
        sender: sampleWallet.address,
        target: spooVaultAddress,
        innerCallData: "0x1234",
        paymasterAddress,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          error: { code: -32500, message: "AA31 paymaster deposit too low" },
        }),
      } as any);

      await expect(
        sendUserOpToBundler(
          mockUserOp,
          entryPointAddress,
          "https://bundler.fuji.example.com"
        )
      ).rejects.toThrow("AA31 paymaster deposit too low");
    });

    it("fetches UserOperation receipt from bundler", async () => {
      const mockReceipt = { success: true, actualGasCost: "0x1234" };
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: mockReceipt }),
      } as any);

      const receipt = await getUserOperationReceipt(
        "0xuserophash",
        "https://bundler.fuji.example.com"
      );
      expect(receipt).toEqual(mockReceipt);
    });
  });

  describe("Permissionless / Biconomy Adapter Helper", () => {
    it("creates a paymaster client matching SDK specifications", async () => {
      const client = createPaymasterClient({
        entryPointAddress,
        paymasterAddress,
        spooVaultAddress,
        chainId,
      });

      const stubData = await client.getPaymasterStubData({}, 1);
      expect(stubData.paymasterAndData.startsWith(ethers.getAddress(paymasterAddress))).toBe(
        true
      );
      expect(stubData.callGasLimit).toBeGreaterThan(0n);
      expect(stubData.verificationGasLimit).toBeGreaterThan(0n);
    });
  });
});
