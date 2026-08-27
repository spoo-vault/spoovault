// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @dev User Operation struct as defined in EIP-4337.
 */
struct UserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    uint256 callGasLimit;
    uint256 verificationGasLimit;
    uint256 preVerificationGas;
    uint256 maxFeePerGas;
    uint256 maxPriorityFeePerGas;
    bytes paymasterAndData;
    bytes signature;
}

/**
 * @dev Minimal EIP-4337 EntryPoint interface for Paymaster interactions.
 */
interface IEntryPoint {
    struct DepositInfo {
        uint112 deposit;
        bool staked;
        uint112 stake;
        uint32 unstakeDelaySec;
        uint48 withdrawTime;
    }

    function depositTo(address account) external payable;

    function addStake(uint32 unstakeDelaySec) external payable;

    function unlockStake() external;

    function withdrawStake(address payable withdrawAddress) external;

    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;

    function getDepositInfo(address account) external view returns (DepositInfo memory info);

    function balanceOf(address account) external view returns (uint256);

    function handleOps(UserOperation[] calldata ops, address payable beneficiary) external;

    function getUserOpHash(UserOperation calldata userOp) external view returns (bytes32);
}
