// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IEntryPoint.sol";
import "../interfaces/IPaymaster.sol";

/**
 * @title MockEntryPoint
 * @notice Realistic mock of the canonical EIP-4337 EntryPoint for unit testing Paymasters
 *         and Smart Accounts without external bundler infrastructure.
 */
contract MockEntryPoint is IEntryPoint, ReentrancyGuard {
    mapping(address => uint256) private _deposits;
    mapping(address => DepositInfo) private _stakes;

    event Deposited(address indexed account, uint256 totalDeposit);
    event Withdrawn(address indexed account, address withdrawAddress, uint256 amount);
    event UserOperationEvent(
        bytes32 indexed userOpHash,
        address indexed sender,
        address indexed paymaster,
        uint256 nonce,
        bool success,
        uint256 actualGasCost
    );

    error ZeroAddress();
    error NotStaked();
    error MustUnlockFirst();
    error StakeLocked();
    error InsufficientDeposit();
    error TransferFailed();
    error PaymasterDepositTooLow();
    error ValidationFailed();

    receive() external payable {
        depositTo(msg.sender);
    }

    function depositTo(address account) public payable override {
        if (account == address(0)) revert ZeroAddress();
        _deposits[account] += msg.value;
        emit Deposited(account, _deposits[account]);
    }

    function balanceOf(address account) external view override returns (uint256) {
        return _deposits[account];
    }

    function getDepositInfo(address account) external view override returns (DepositInfo memory) {
        return _stakes[account];
    }

    function addStake(uint32 unstakeDelaySec) external payable override {
        DepositInfo storage info = _stakes[msg.sender];
        info.stake += uint112(msg.value);
        info.unstakeDelaySec = unstakeDelaySec;
        info.staked = true;
    }

    function unlockStake() external override {
        DepositInfo storage info = _stakes[msg.sender];
        if (!info.staked) revert NotStaked();
        info.staked = false;
        info.withdrawTime = uint48(block.timestamp + info.unstakeDelaySec);
    }

    function withdrawStake(address payable withdrawAddress) external override nonReentrant {
        if (withdrawAddress == address(0)) revert ZeroAddress();
        DepositInfo storage info = _stakes[msg.sender];
        if (info.staked) revert MustUnlockFirst();
        if (block.timestamp < info.withdrawTime) revert StakeLocked();
        uint256 amount = info.stake;
        info.stake = 0;
        // slither-disable-next-line low-level-calls
        (bool s, ) = withdrawAddress.call{value: amount}("");
        if (!s) revert TransferFailed();
    }

    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external override nonReentrant {
        if (withdrawAddress == address(0)) revert ZeroAddress();
        if (_deposits[msg.sender] < withdrawAmount) revert InsufficientDeposit();
        _deposits[msg.sender] -= withdrawAmount;
        // slither-disable-next-line low-level-calls
        (bool s, ) = withdrawAddress.call{value: withdrawAmount}("");
        if (!s) revert TransferFailed();
        emit Withdrawn(msg.sender, withdrawAddress, withdrawAmount);
    }

    function getUserOpHash(UserOperation calldata userOp) public view override returns (bytes32) {
        bytes32 packedHash = keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.callGasLimit,
                userOp.verificationGasLimit,
                userOp.preVerificationGas,
                userOp.maxFeePerGas,
                userOp.maxPriorityFeePerGas,
                keccak256(userOp.paymasterAndData)
            )
        );
        return keccak256(abi.encode(packedHash, address(this), block.chainid));
    }

    function handleOps(UserOperation[] calldata ops, address payable beneficiary) external override nonReentrant {
        for (uint256 i = 0; i < ops.length; i++) {
            UserOperation calldata op = ops[i];
            bytes32 opHash = getUserOpHash(op);

            uint256 maxCost = (op.verificationGasLimit + op.callGasLimit + op.preVerificationGas) * op.maxFeePerGas;
            if (maxCost == 0) {
                maxCost = 100_000 * 1 gwei;
            }

            address paymasterAddress = address(0);
            bytes memory paymasterContext = "";

            if (op.paymasterAndData.length >= 20) {
                paymasterAddress = address(bytes20(op.paymasterAndData[:20]));
                if (_deposits[paymasterAddress] < maxCost) revert PaymasterDepositTooLow();

                uint256 validationData;
                (paymasterContext, validationData) = IPaymaster(paymasterAddress).validatePaymasterUserOp(
                    op,
                    opHash,
                    maxCost
                );
                if (validationData != 0) revert ValidationFailed();
            }

            // Estimate simulated gas cost
            uint256 actualGasCost = maxCost / 2;
            if (actualGasCost == 0) {
                actualGasCost = 50_000;
            }

            // Checks-Effects: Deduct gas from paymaster internal deposit before external execution
            if (paymasterAddress != address(0)) {
                if (_deposits[paymasterAddress] < actualGasCost) revert PaymasterDepositTooLow();
                _deposits[paymasterAddress] -= actualGasCost;
                if (beneficiary != address(0)) {
                    _deposits[beneficiary] += actualGasCost;
                }
            }

            // Execute the operation
            uint256 gasLimit = op.callGasLimit > 0 ? op.callGasLimit : 500_000;
            // slither-disable-next-line low-level-calls
            (bool success, ) = op.sender.call{gas: gasLimit}(op.callData);

            if (paymasterAddress != address(0)) {
                IPaymaster(paymasterAddress).postOp(
                    success ? IPaymaster.PostOpMode.opSucceeded : IPaymaster.PostOpMode.opReverted,
                    paymasterContext,
                    actualGasCost
                );
            }

            emit UserOperationEvent(opHash, op.sender, paymasterAddress, op.nonce, success, actualGasCost);
        }
    }
}
