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
}
