// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ISpooVault
 * @dev Standardized, consumer-facing interface for the SpooVault document-access
 *      protocol. Third-party DeFi protocols, inheritance platforms, DAOs and
 *      general DApps can integrate with SpooVault without hardcoding
 *      implementation-specific ABI details by depending only on this interface.
 *
 *      The interface is ERC-165 discoverable: a contract/wallet can call
 *      `supportsInterface(type(ISpooVault).interfaceId)` to confirm that a
 *      candidate address implements the SpooVault access protocol before
 *      issuing cross-contract calls.
 *
 *      All functions in this interface are `view`/`pure` so that consumers can
 *      perform gas-free, read-only access delegation checks.
 */
interface ISpooVault {
    /**
     * @dev Emitted when a guardian registers their BLS12-381 public key and Proof of Possession.
     */
    event GuardianBLSKeyRegistered(uint256 indexed vaultId, address indexed guardian, bytes blsPublicKey);

    /**
     * @dev Emitted when an access request is approved via threshold BLS signature aggregation.
     */
    event BLSAccessApproved(uint256 indexed requestId, uint256 indexed vaultId, uint256 guardianCount, bytes aggregatedSignature);

    /**
     * @dev Emitted when a guardian revokes an off-chain delegation nonce.
     */
    event DelegationRevoked(address indexed guardian, uint256 indexed nonce);

    /**
     * @dev Emitted when a document's Feldmann VSS polynomial commitments are updated.
     */
    event VSSCommitmentsUpdated(uint256 indexed documentId, uint256 indexed epoch, bytes32[] commitments);

    /**
     * @dev Emitted when a delegate submits an approval on behalf of a guardian.
     */
    event DelegatedApprovalSubmitted(uint256 indexed requestId, address indexed guardian, address indexed delegate);

    /**
     * @dev Emitted when vault document access is revoked across multi-chain instances.
     *      Payload: RevokeAccess(vaultGID, documentId, targetUser, nonce).
     */
    event RevokeAccess(bytes32 indexed vaultGID, uint256 indexed documentId, address indexed targetUser, uint256 nonce);

    /**
     * @dev Returns true if `interfaceId` is supported by the implementing
     *      contract (ERC-165). Implementations MUST return true for
     *      `type(ISpooVault).interfaceId` and for the standard ERC-165
     *      (`0x01ffc9a7`) and ERC-721 (`0x80ac58cd`) identifiers.
     * @param interfaceId The 4-byte interface identifier being queried.
     * @return bool True if the interface is supported.
     */
    function supportsInterface(bytes4 interfaceId) external view returns (bool);

    /**
     * @dev Returns true if `user` currently holds *active* access to
     *      `documentId`. Active access factors in both the granted access
     *      record and live ownership of a vault access NFT.
     * @param documentId The identifier of the document.
     * @param user The address being checked.
     * @return bool True if `user` has active access.
     */
    function hasActiveAccess(uint256 documentId, address user) external view returns (bool);

    /**
     * @dev Standardized, machine-readable access check returning a status code
     *      instead of reverting. Intended for cross-contract callers that need
     *      to branch on access state without catching reverts.
     * @param documentId The identifier of the document.
     * @param user The address being checked.
     * @return code The access status:
     *         - 0 = DOCUMENT_NOT_FOUND (no document with this id exists)
     *         - 1 = ACCESS_DENIED (document exists, `user` lacks active access)
     *         - 2 = ACCESS_GRANTED (`user` holds active access)
     */
    function checkAccess(uint256 documentId, address user) external view returns (uint8);

    /**
     * @dev Returns true if `user` is a guardian of `vaultId`.
     * @param vaultId The identifier of the vault.
     * @param user The address being checked.
     * @return bool True if `user` is a guardian.
     */
    function isGuardian(uint256 vaultId, address user) external view returns (bool);

    /**
     * @dev Returns the creator/owner address of `vaultId`.
     * @param vaultId The identifier of the vault.
     * @return creator The address that created the vault.
     */
    function getVaultCreator(uint256 vaultId) external view returns (address);

    /**
     * @dev Returns the number of guardian approvals required to release a
     *      document access request for `vaultId`.
     * @param vaultId The identifier of the vault.
     * @return threshold The approval threshold.
     */
    function getApprovalThreshold(uint256 vaultId) external view returns (uint256);

    /**
     * @dev Registers a BLS12-381 G1 public key and Proof of Possession for a vault guardian.
     * @param vaultId Identifier of the vault.
     * @param blsPublicKey 48-byte compressed G1 public key.
     * @param proofOfPossession 96-byte compressed G2 Proof of Possession signature.
     */
    function registerGuardianBLSKey(
        uint256 vaultId,
        bytes calldata blsPublicKey,
        bytes calldata proofOfPossession
    ) external;

    /**
     * @dev Returns the registered BLS key information for a guardian.
     */
    function getGuardianBLSKey(
        uint256 vaultId,
        address guardian
    ) external view returns (bytes memory blsPublicKey, bytes memory proofOfPossession, bool isRegistered);

    /**
     * @dev Approves an access request via off-chain aggregated BLS threshold signature in a single transaction.
     * @param requestId The access request identifier.
     * @param guardianAddresses Array of distinct active guardians who participated.
     * @param aggregatedSignature 96-byte compressed G2 aggregated BLS signature.
     * @param aggregatedPublicKey 48-byte compressed G1 aggregated BLS public key.
     * @param encryptedSharesForBeneficiary Encrypted key shares submitted by each guardian for beneficiary.
     */
    function approveAccessBLS(
        uint256 requestId,
        address[] calldata guardianAddresses,
        bytes calldata aggregatedSignature,
        bytes calldata aggregatedPublicKey,
        string[] calldata encryptedSharesForBeneficiary
    ) external;

    /**
     * @dev Verifies an EIP-712 typed data guardian delegation signature.
     */
    function verifyDelegation(
        address guardian,
        address delegate,
        uint256 vaultId,
        uint256 validUntil,
        uint256 nonce,
        bytes calldata signature
    ) external view returns (bool);

    /**
     * @dev Instantly revokes an off-chain EIP-712 delegation nonce for the caller.
     */
    function revokeDelegation(uint256 nonce) external;

    /**
     * @dev Returns the current active Feldmann VSS polynomial coefficient commitments for a document.
     * @param documentId The identifier of the document.
     * @return commitments The array of coefficient commitments [C_0, C_1, ..., C_{k-1}].
     */
    function getDocumentVSSCommitments(uint256 documentId) external view returns (bytes32[] memory);
}
