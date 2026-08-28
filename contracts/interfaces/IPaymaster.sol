// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IEntryPoint.sol";

/**
 * @dev Paymaster interface for EIP-4337.
 */
interface IPaymaster {
    enum PostOpMode {
        opSucceeded, // UserOp succeeded
        opReverted,  // UserOp reverted (paymaster still pays)
        postOpReverted // never passed to postOp
    }

    /**
     * @notice Validate paymaster user operation.
     * @param userOp The user operation.
     * @param userOpHash Hash of the user operation.
     * @param maxCost Maximum cost of this user operation.
     * @return context Context to be passed to postOp.
     * @return validationData Packed validation data (0 on success).
     */
    function validatePaymasterUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external returns (bytes memory context, uint256 validationData);

    /**
     * @notice Post-operation handler.
     * @param mode Post-operation mode.
     * @param context Context returned by validatePaymasterUserOp.
     * @param actualGasCost Actual gas cost incurred by the UserOperation.
     */
    function postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost
    ) external;
}
