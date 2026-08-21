// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IVRFCoordinatorV2Plus.sol";

/**
 * @dev Test-only mock of the Chainlink VRF v2.5 coordinator.
 * Records consumer requests and lets tests deliver deterministic
 * random words through {fulfillRandomWords}, mirroring the production
 * fulfillment path (consumer.rawFulfillRandomWords).
 */
contract MockVRFCoordinator is IVRFCoordinatorV2Plus {
    uint256 private _requestCounter;
    mapping(uint256 => address) public requestConsumer;
    mapping(uint256 => bool) public fulfilled;

    function requestRandomWords(
        bytes32 /* keyHash */,
        uint256 /* subscriptionId */,
        uint16 /* minimumRequestConfirmations */,
        uint32 /* callbackGasLimit */,
        uint32 numWords,
        bytes calldata /* extraArgs */
    ) external override returns (uint256 requestId) {
        require(numWords == 1, "MockVRFCoordinator: only 1 word supported");
        _requestCounter += 1;
        requestId = _requestCounter;
        requestConsumer[requestId] = msg.sender;
        return requestId;
    }

    /**
     * @dev Delivers a random word to the consumer, exactly like the real
     * coordinator calls back into VRFConsumerBaseV2Plus consumers.
     */
    function fulfill(uint256 requestId, uint256 randomWord) external {
        require(!fulfilled[requestId], "MockVRFCoordinator: already fulfilled");
        address consumer = requestConsumer[requestId];
        require(consumer != address(0), "MockVRFCoordinator: unknown request");
        fulfilled[requestId] = true;

        uint256[] memory words = new uint256[](1);
        words[0] = randomWord;
        IVRFConsumer(consumer).rawFulfillRandomWords(requestId, words);
    }
}

interface IVRFConsumer {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}
