import { ethers } from "ethers";

/**
 * @title UserOperation
 * @notice Standard EIP-4337 UserOperation struct definition.
 */
export interface UserOperation {
  sender: string;
  nonce: bigint | string | number;
  initCode: string;
  callData: string;
  callGasLimit: bigint | string | number;
  verificationGasLimit: bigint | string | number;
  preVerificationGas: bigint | string | number;
  maxFeePerGas: bigint | string | number;
  maxPriorityFeePerGas: bigint | string | number;
  paymasterAndData: string;
  signature: string;
}

export interface UserOperationOverrides {
  nonce?: bigint | string | number;
  initCode?: string;
  callGasLimit?: bigint | string | number;
  verificationGasLimit?: bigint | string | number;
  preVerificationGas?: bigint | string | number;
  maxFeePerGas?: bigint | string | number;
  maxPriorityFeePerGas?: bigint | string | number;
  paymasterAndData?: string;
}

export interface GaslessApprovalConfig {
  entryPointAddress: string;
  paymasterAddress: string;
  spooVaultAddress: string;
  chainId: number | bigint;
  bundlerRpcUrl?: string;
}

// Canonical default gas limits for standard ERC-4337 operations on Avalanche / EVM
export const DEFAULT_VERIFICATION_GAS_LIMIT = 150000n;
export const DEFAULT_CALL_GAS_LIMIT = 200000n;
export const DEFAULT_PRE_VERIFICATION_GAS = 50000n;
export const DEFAULT_MAX_FEE_PER_GAS = 25000000000n; // 25 nAVAX / gwei
export const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = 1500000000n; // 1.5 nAVAX / gwei

const spooVaultInterface = new ethers.Interface([
  "function acceptGuardianInvite(uint256 vaultId) external",
  "function approveAccess(uint256 requestId) external",
  "function approveAccess(uint256 requestId, string encryptedShareForBeneficiary) external",
]);

const smartAccountInterface = new ethers.Interface([
  "function execute(address dest, uint256 value, bytes calldata func) external",
  "function executeCall(address target, uint256 value, bytes calldata data) external",
]);

/**
 * Builds the raw ABI-encoded calldata for calling `approveAccess` on SpooVault.
 */
export function buildApproveAccessCallData(
  requestId: number,
  encryptedShare?: string
): string {
  if (encryptedShare && encryptedShare.trim().length > 0) {
    return spooVaultInterface.encodeFunctionData("approveAccess(uint256,string)", [
      requestId,
      encryptedShare,
    ]);
  }
  return spooVaultInterface.encodeFunctionData("approveAccess(uint256)", [requestId]);
}

/**
 * Builds the raw ABI-encoded calldata for calling `acceptGuardianInvite` on SpooVault.
 */
export function buildAcceptGuardianInviteCallData(vaultId: number): string {
  return spooVaultInterface.encodeFunctionData("acceptGuardianInvite", [vaultId]);
}

/**
 * Wraps an inner contract invocation into standard account `execute(address,uint256,bytes)` calldata.
 */
export function buildAccountExecuteCallData(
  target: string,
  value: bigint | number = 0n,
  innerCallData: string
): string {
  return smartAccountInterface.encodeFunctionData("execute", [
    target,
    value,
    innerCallData,
  ]);
}

/**
 * Formats the paymasterAndData bytes (Paymaster address + optional encoded vaultId).
 */
export function buildPaymasterAndData(
  paymasterAddress: string,
  vaultId?: number
): string {
  const cleanAddress = ethers.getAddress(paymasterAddress);
  if (vaultId !== undefined && vaultId > 0) {
    const encodedVault = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [vaultId]);
    return ethers.concat([cleanAddress, encodedVault]);
  }
  return cleanAddress;
}

/**
 * Packs the UserOperation fields according to EIP-4337 specification.
 */
export function packUserOp(userOp: UserOperation): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(
    [
      "address",
      "uint256",
      "bytes32",
      "bytes32",
      "uint256",
      "uint256",
      "uint256",
      "uint256",
      "uint256",
      "bytes32",
    ],
    [
      ethers.getAddress(userOp.sender),
      BigInt(userOp.nonce),
      ethers.keccak256(userOp.initCode || "0x"),
      ethers.keccak256(userOp.callData || "0x"),
      BigInt(userOp.callGasLimit),
      BigInt(userOp.verificationGasLimit),
      BigInt(userOp.preVerificationGas),
      BigInt(userOp.maxFeePerGas),
      BigInt(userOp.maxPriorityFeePerGas),
      ethers.keccak256(userOp.paymasterAndData || "0x"),
    ]
  );
}

/**
 * Calculates the canonical EIP-4337 UserOperation hash:
 * keccak256(abi.encode(keccak256(packUserOp(userOp)), entryPoint, chainId))
 */
export function getUserOpHash(
  userOp: UserOperation,
  entryPointAddress: string,
  chainId: number | bigint
): string {
  const packed = packUserOp(userOp);
  const packedHash = ethers.keccak256(packed);
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    abiCoder.encode(
      ["bytes32", "address", "uint256"],
      [packedHash, ethers.getAddress(entryPointAddress), BigInt(chainId)]
    )
  );
}

/**
 * Signs the userOpHash with an ethers.Signer and attaches the signature.
 */
export async function signUserOp(
  userOp: UserOperation,
  signer: ethers.Signer,
  entryPointAddress: string,
  chainId: number | bigint
): Promise<UserOperation> {
  const hash = getUserOpHash(userOp, entryPointAddress, chainId);
  const signature = await signer.signMessage(ethers.getBytes(hash));
  return {
    ...userOp,
    signature,
  };
}

/**
 * Creates an unsigned UserOperation for a gasless action sponsored by SpooPaymaster.
 */
export function buildGaslessUserOp(params: {
  sender: string;
  target: string;
  innerCallData: string;
  paymasterAddress: string;
  vaultId?: number;
  nonce?: bigint | string | number;
  overrides?: UserOperationOverrides;
}): UserOperation {
  const callData = buildAccountExecuteCallData(
    params.target,
    0n,
    params.innerCallData
  );
  const paymasterAndData = buildPaymasterAndData(
    params.paymasterAddress,
    params.vaultId
  );

  return {
    sender: ethers.getAddress(params.sender),
    nonce: params.nonce !== undefined ? params.nonce : 0n,
    initCode: params.overrides?.initCode || "0x",
    callData,
    callGasLimit: params.overrides?.callGasLimit || DEFAULT_CALL_GAS_LIMIT,
    verificationGasLimit:
      params.overrides?.verificationGasLimit || DEFAULT_VERIFICATION_GAS_LIMIT,
    preVerificationGas:
      params.overrides?.preVerificationGas || DEFAULT_PRE_VERIFICATION_GAS,
    maxFeePerGas: params.overrides?.maxFeePerGas || DEFAULT_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas:
      params.overrides?.maxPriorityFeePerGas || DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
    paymasterAndData: params.overrides?.paymasterAndData || paymasterAndData,
    signature: "0x",
  };
}

/**
 * High-level builder: Creates and signs a gasless `approveAccess` UserOperation.
 */
export async function buildGaslessApproveAccess(params: {
  guardianAccount: string;
  requestId: number;
  encryptedShare?: string;
  paymasterAddress: string;
  spooVaultAddress: string;
  entryPointAddress: string;
  chainId: number | bigint;
  signer: ethers.Signer;
  vaultId?: number;
  nonce?: bigint | string | number;
  overrides?: UserOperationOverrides;
}): Promise<UserOperation> {
  const innerCallData = buildApproveAccessCallData(
    params.requestId,
    params.encryptedShare
  );
  const unsignedOp = buildGaslessUserOp({
    sender: params.guardianAccount,
    target: params.spooVaultAddress,
    innerCallData,
    paymasterAddress: params.paymasterAddress,
    vaultId: params.vaultId,
    nonce: params.nonce,
    overrides: params.overrides,
  });

  return signUserOp(
    unsignedOp,
    params.signer,
    params.entryPointAddress,
    params.chainId
  );
}

/**
 * High-level builder: Creates and signs a gasless `acceptGuardianInvite` UserOperation.
 */
export async function buildGaslessAcceptInvite(params: {
  guardianAccount: string;
  vaultId: number;
  paymasterAddress: string;
  spooVaultAddress: string;
  entryPointAddress: string;
  chainId: number | bigint;
  signer: ethers.Signer;
  nonce?: bigint | string | number;
  overrides?: UserOperationOverrides;
}): Promise<UserOperation> {
  const innerCallData = buildAcceptGuardianInviteCallData(params.vaultId);
  const unsignedOp = buildGaslessUserOp({
    sender: params.guardianAccount,
    target: params.spooVaultAddress,
    innerCallData,
    paymasterAddress: params.paymasterAddress,
    vaultId: params.vaultId,
    nonce: params.nonce,
    overrides: params.overrides,
  });

  return signUserOp(
    unsignedOp,
    params.signer,
    params.entryPointAddress,
    params.chainId
  );
}

/**
 * Converts a UserOperation into JSON-RPC compatible hex-formatted parameters.
 */
export function formatUserOpForRpc(userOp: UserOperation): Record<string, string> {
  return {
    sender: ethers.getAddress(userOp.sender),
    nonce: ethers.toQuantity(userOp.nonce),
    initCode: userOp.initCode || "0x",
    callData: userOp.callData || "0x",
    callGasLimit: ethers.toQuantity(userOp.callGasLimit),
    verificationGasLimit: ethers.toQuantity(userOp.verificationGasLimit),
    preVerificationGas: ethers.toQuantity(userOp.preVerificationGas),
    maxFeePerGas: ethers.toQuantity(userOp.maxFeePerGas),
    maxPriorityFeePerGas: ethers.toQuantity(userOp.maxPriorityFeePerGas),
    paymasterAndData: userOp.paymasterAndData || "0x",
    signature: userOp.signature || "0x",
  };
}

/**
 * Dispatches a UserOperation to an EIP-4337 Bundler JSON-RPC endpoint.
 */
export async function sendUserOpToBundler(
  userOp: UserOperation,
  entryPointAddress: string,
  bundlerUrl: string
): Promise<string> {
  const rpcUserOp = formatUserOpForRpc(userOp);
  const payload = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "eth_sendUserOperation",
    params: [rpcUserOp, ethers.getAddress(entryPointAddress)],
  };

  const response = await fetch(bundlerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Bundler HTTP request failed with status ${response.status}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(`Bundler RPC error: ${json.error.message || JSON.stringify(json.error)}`);
  }

  return json.result as string;
}

/**
 * Retrieves the transaction receipt for a submitted UserOperation from the Bundler.
 */
export async function getUserOperationReceipt(
  userOpHash: string,
  bundlerUrl: string
): Promise<any> {
  const payload = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "eth_getUserOperationReceipt",
    params: [userOpHash],
  };

  const response = await fetch(bundlerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Bundler HTTP request failed with status ${response.status}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(`Bundler RPC error: ${json.error.message || JSON.stringify(json.error)}`);
  }

  return json.result;
}

/**
 * Compatibility adapter for Permissionless.js / Biconomy Paymaster Client integrations.
 */
export function createPaymasterClient(config: GaslessApprovalConfig) {
  return {
    async getPaymasterData(userOp: Partial<UserOperation>, vaultId?: number) {
      return {
        paymasterAndData: buildPaymasterAndData(config.paymasterAddress, vaultId),
        preVerificationGas: userOp.preVerificationGas || DEFAULT_PRE_VERIFICATION_GAS,
        verificationGasLimit: userOp.verificationGasLimit || DEFAULT_VERIFICATION_GAS_LIMIT,
        callGasLimit: userOp.callGasLimit || DEFAULT_CALL_GAS_LIMIT,
      };
    },
    async getPaymasterStubData(userOp: Partial<UserOperation>, vaultId?: number) {
      return {
        paymasterAndData: buildPaymasterAndData(config.paymasterAddress, vaultId),
        preVerificationGas: userOp.preVerificationGas || DEFAULT_PRE_VERIFICATION_GAS,
        verificationGasLimit: userOp.verificationGasLimit || DEFAULT_VERIFICATION_GAS_LIMIT,
        callGasLimit: userOp.callGasLimit || DEFAULT_CALL_GAS_LIMIT,
      };
    },
  };
}

export const userOpService = {
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
};
