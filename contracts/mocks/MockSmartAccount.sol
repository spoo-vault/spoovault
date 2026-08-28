// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IEntryPoint.sol";

/**
 * @title MockSmartAccount
 * @notice Minimal ERC-4337 smart contract account representing a guardian with 0 AVAX balance.
 */
contract MockSmartAccount is ReentrancyGuard {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    address public immutable owner;
    IEntryPoint public immutable entryPoint;

    event Executed(address indexed target, uint256 value, bytes data);

    error UnauthorizedCaller();
    error ExecutionFailed();
    error ZeroAddress();

    modifier onlyEntryPointOrOwner() {
        if (msg.sender != address(entryPoint) && msg.sender != owner) {
            revert UnauthorizedCaller();
        }
        _;
    }

    constructor(IEntryPoint _entryPoint, address _owner) {
        if (address(_entryPoint) == address(0) || _owner == address(0)) {
            revert ZeroAddress();
        }
        entryPoint = _entryPoint;
        owner = _owner;
    }

    receive() external payable {}

    function execute(
        address dest,
        uint256 value,
        bytes calldata func
    ) external onlyEntryPointOrOwner nonReentrant returns (bytes memory result) {
        if (dest == address(0)) revert ZeroAddress();
        emit Executed(dest, value, func);

        bool success;
        // slither-disable-next-line low-level-calls
        (success, result) = dest.call{value: value}(func);
        if (!success) {
            revert ExecutionFailed();
        }
    }

    function validateUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData) {
        if (msg.sender != address(entryPoint)) revert UnauthorizedCaller();

        bytes32 ethHash = userOpHash.toEthSignedMessageHash();
        address recovered = ethHash.recover(userOp.signature);
        if (recovered != owner) {
            return 1; // signature failure
        }

        if (missingAccountFunds > 0) {
            // slither-disable-next-line low-level-calls
            (bool success, ) = payable(msg.sender).call{value: missingAccountFunds}("");
            require(success, "funds transfer failed");
        }

        return 0; // success
    }
}
