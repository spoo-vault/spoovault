// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAxelarGateway {
    function callContract(string calldata destinationChain, string calldata destinationAddress, bytes calldata payload)
        external;
}

abstract contract AxelarExecutable {
    IAxelarGateway public immutable gateway;

    error NotAxelarGateway();

    constructor(address gateway_) {
        gateway = IAxelarGateway(gateway_);
    }

    modifier onlyGateway() {
        if (msg.sender != address(gateway)) {
            revert NotAxelarGateway();
        }
        _;
    }

    function execute(string calldata sourceChain, string calldata sourceAddress, bytes calldata payload)
        external
        onlyGateway
    {
        bytes32 commandId = keccak256(abi.encode(sourceChain, sourceAddress, payload));
        _execute(commandId, sourceChain, sourceAddress, payload);
    }

    function _execute(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) internal virtual;
}

contract SpooVaultAxelarBridge is AxelarExecutable {
    address public immutable admin;
    mapping(bytes32 => bool) public processedMessages;
    mapping(bytes32 => bytes32) public trustedSourceAddressHash;

    event TrustedSourceSet(string indexed sourceChain, string sourceAddress);
    event CrossChainApprovalSent(
        bytes32 indexed vaultGID,
        address indexed guardian,
        uint8 approvalType,
        uint256 nonce,
        string destinationChain
    );
    event CrossChainApprovalReceived(
        bytes32 indexed vaultGID,
        address indexed guardian,
        uint8 approvalType,
        uint256 nonce,
        string sourceChain
    );

    error NotAdmin();
    error UntrustedSource();
    error MessageAlreadyProcessed();

    constructor(address gateway_) AxelarExecutable(gateway_) {
        admin = msg.sender;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) {
            revert NotAdmin();
        }
        _;
    }

    function setTrustedSource(string calldata sourceChain, string calldata sourceAddress) external onlyAdmin {
        trustedSourceAddressHash[keccak256(bytes(sourceChain))] = keccak256(bytes(sourceAddress));
        emit TrustedSourceSet(sourceChain, sourceAddress);
    }

    function sendApproval(
        string calldata destinationChain,
        string calldata destinationAddress,
        bytes32 vaultGID,
        address guardian,
        uint8 approvalType,
        uint256 nonce
    ) external {
        bytes memory payload = abi.encode(vaultGID, guardian, approvalType, nonce, block.timestamp);
        gateway.callContract(destinationChain, destinationAddress, payload);

        emit CrossChainApprovalSent(vaultGID, guardian, approvalType, nonce, destinationChain);
    }

    function _execute(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) internal override {
        bytes32 sourceChainKey = keccak256(bytes(sourceChain));
        if (trustedSourceAddressHash[sourceChainKey] != keccak256(bytes(sourceAddress))) {
            revert UntrustedSource();
        }

        bytes32 messageHash = keccak256(abi.encode(commandId, sourceChain, sourceAddress, payload));
        if (processedMessages[messageHash]) {
            revert MessageAlreadyProcessed();
        }
        processedMessages[messageHash] = true;

        (bytes32 vaultGID, address guardian, uint8 approvalType, uint256 nonce,) =
            abi.decode(payload, (bytes32, address, uint8, uint256, uint256));

        emit CrossChainApprovalReceived(vaultGID, guardian, approvalType, nonce, sourceChain);
    }
}
