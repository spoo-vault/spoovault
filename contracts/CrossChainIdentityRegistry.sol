// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./libs/Ed25519.sol";
import "./libs/StrKey.sol";

/**
 * @title CrossChainIdentityRegistry
 * @notice On-chain registry that cryptographically binds an EVM address
 *         (0x...) to a Stellar address (G...) using a dual-signed identity
 *         payload.
 *
 * @dev Proof-of-ownership model
 *      ------------------------
 *      A user proves control of *both* keys before a binding is recorded:
 *
 *        payload     = "BindIdentity" || evmAddress(20) || stellarPublicKey(32) || timestamp(8, BE)
 *        messageHash = keccak256(payload)
 *
 *      - EVM signature: MetaMask `personal_sign(messageHash)` (EIP-191). The
 *        recovered signer must equal `evmAddress`.
 *      - Stellar signature: an Ed25519 signature over `messageHash` produced
 *        by Freighter (`signBlob`). Verified with the embedded {Ed25519}
 *        verifier against the 32-byte Ed25519 public key embedded in the
 *        payload.
 *
 *      Because `messageHash` commits to the addresses, public key and
 *      timestamp, a binding cannot be recorded with swapped or forged
 *      components. Invalid, stale or single-signed requests revert.
 *
 *      Lookups are exposed as `resolveEvmToStellar` / `resolveStellarToEvm`
 *      mirroring the Soroban `identity_registry` module so callers on either
 *      chain can resolve the same identity link.
 */
contract CrossChainIdentityRegistry {
    using ECDSA for bytes32;

    struct IdentityBinding {
        string stellarAddress;
        bytes32 stellarPublicKey;
        uint256 timestamp;
        bool bound;
    }

    error AlreadyBound();
    error InvalidTimestamp();
    error InvalidEvmSignature();
    error InvalidStellarSignature();
    error InvalidStellarAddress();
    error NotBound();

    event IdentityBound(address indexed evmAddress, string stellarAddress, bytes32 stellarPublicKey, uint256 timestamp);

    /// Bindings are valid for at most one day before they are considered stale.
    uint256 public constant MAX_BINDING_AGE = 1 days;
    /// Small forward drift allowance for clock skew between chains.
    uint256 public constant MAX_FUTURE_DRIFT = 5 minutes;

    mapping(address => IdentityBinding) public bindings;
    // keccak256(bytes(stellarAddress)) => evmAddress (strings cannot be mapping keys)
    mapping(bytes32 => address) private _stellarToEvm;

    /**
     * @notice Records a dual-signed EVM <-> Stellar identity binding.
     * @param evmAddress The EVM address (must be recovered from `evmSignature`).
     * @param stellarAddress The Stellar G-address (stored for lookup).
     * @param stellarPublicKey The 32-byte Ed25519 public key of `stellarAddress`.
     * @param timestamp Unix seconds embedded in the signed payload.
     * @param evmSignature 65-byte EIP-191 signature over `messageHash`.
     * @param stellarSignature 64-byte Ed25519 signature over `messageHash`.
     */
    function bindIdentity(
        address evmAddress,
        string calldata stellarAddress,
        bytes32 stellarPublicKey,
        uint256 timestamp,
        bytes calldata evmSignature,
        bytes calldata stellarSignature
    ) external {
        if (bindings[evmAddress].bound) revert AlreadyBound();
        if (bytes(stellarAddress).length == 0) revert InvalidStellarAddress();
        // The G-address string must decode to the Ed25519 public key that is
        // committed by the signed payload, otherwise a forged address could be
        // stored alongside an unrelated verified key.
        if (StrKey.decodeEd25519PublicKey(stellarAddress) != stellarPublicKey) {
            revert InvalidStellarAddress();
        }

        bytes32 stellarHash = keccak256(bytes(stellarAddress));
        if (_stellarToEvm[stellarHash] != address(0)) revert AlreadyBound();

        if (timestamp < block.timestamp - MAX_BINDING_AGE || timestamp > block.timestamp + MAX_FUTURE_DRIFT) {
            revert InvalidTimestamp();
        }

        bytes32 messageHash = keccak256(
            abi.encodePacked(
                "BindIdentity", block.chainid, address(this), evmAddress, stellarPublicKey, uint64(timestamp)
            )
        );

        // ---- EVM signature (MetaMask personal_sign) -------------------------
        if (evmSignature.length != 65) revert InvalidEvmSignature();
        bytes32 evmDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        if (evmDigest.recover(evmSignature) != evmAddress) revert InvalidEvmSignature();

        // ---- Stellar signature (Freighter signBlob / Ed25519) ---------------
        if (!Ed25519.verify(stellarSignature, abi.encodePacked(stellarPublicKey), abi.encodePacked(messageHash))) {
            revert InvalidStellarSignature();
        }

        bindings[evmAddress] = IdentityBinding({
            stellarAddress: stellarAddress, stellarPublicKey: stellarPublicKey, timestamp: timestamp, bound: true
        });
        _stellarToEvm[stellarHash] = evmAddress;

        emit IdentityBound(evmAddress, stellarAddress, stellarPublicKey, timestamp);
    }

    /**
     * @notice Resolves an EVM address to its bound Stellar address.
     */
    function resolveEvmToStellar(address evmAddress) external view returns (string memory) {
        IdentityBinding storage b = bindings[evmAddress];
        if (!b.bound) revert NotBound();
        return b.stellarAddress;
    }

    /**
     * @notice Resolves a Stellar address to its bound EVM address.
     */
    function resolveStellarToEvm(string calldata stellarAddress) external view returns (address) {
        address evm = _stellarToEvm[keccak256(bytes(stellarAddress))];
        if (evm == address(0)) revert NotBound();
        return evm;
    }

    /**
     * @notice Returns whether an EVM address has a recorded binding.
     */
    function isBound(address evmAddress) external view returns (bool) {
        return bindings[evmAddress].bound;
    }

    /**
     * @notice Returns the full binding record for an EVM address.
     */
    function getBinding(address evmAddress)
        external
        view
        returns (string memory stellarAddress, bytes32 stellarPublicKey, uint256 timestamp)
    {
        IdentityBinding storage b = bindings[evmAddress];
        if (!b.bound) revert NotBound();
        return (b.stellarAddress, b.stellarPublicKey, b.timestamp);
    }
}
