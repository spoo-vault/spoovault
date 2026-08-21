// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @dev Minimal subset of the Chainlink VRF v2.5 coordinator interface
 * (IVRFCoordinatorV2Plus) required by SpooVault. Declared locally so the
 * protocol does not need the full chainlink contracts package.
 * Signature-compatible with Chainlink VRF v2.5 deployments.
 */
interface IVRFCoordinatorV2Plus {
    function requestRandomWords(
        bytes32 keyHash,
        uint256 subscriptionId,
        uint16 minimumRequestConfirmations,
        uint32 callbackGasLimit,
        uint32 numWords,
        bytes calldata extraArgs
    ) external returns (uint256 requestId);
}
