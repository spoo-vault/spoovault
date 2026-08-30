// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @title ISpooVault
 * @dev Standardized cross-contract access delegation interface for SpooVault.
 * Allows external DApps, DAOs, and inheritance protocols to programmatically
 * query document access permissions and vault state without hardcoding contract ABIs.
 */
interface ISpooVault is IERC165 {
    enum RequestStatus {
        PENDING,
        APPROVED,
        REJECTED,
        EXPIRED
    }

    enum AccessLevel {
        READ,
        READ_WRITE,
        ADMIN
    }

    enum ReleaseCondition {
        ANYTIME,
        LIVE_ONLY,
        EMERGENCY_ONLY,
        POST_DEATH_ONLY
    }

    enum AccessCheckResult {
        GRANTED,
        DOCUMENT_NOT_EXIST,
        NO_ACCESS,
        RELEASE_CONDITION_LOCKED
    }

    struct Vault {
        uint256 id;
        address creator;
        string name;
        string description;
        address[] guardians;
        uint256 approvalThreshold;
        bool isActive;
        uint256 createdAt;
    }

    struct Document {
        uint256 id;
        uint256 vaultId;
        string encryptedMetadata;
        string ipfsHash;
        address uploadedBy;
        uint256 uploadedAt;
        AccessLevel requiredAccess;
    }

    struct AccessRequest {
        uint256 requestId;
        uint256 documentId;
        address requester;
        address[] approvedBy;
        RequestStatus status;
        uint256 expiresAt;
        uint256 createdAt;
    }

    struct GuardianInvite {
        address guardian;
        uint256 vaultId;
        bool accepted;
        uint256 expiresAt;
    }

    struct VaultReleaseState {
        bool emergencyMode;
        uint256 inactivityPeriod;
        uint256 lastProofOfLife;
    }

    event VaultCreated(uint256 indexed vaultId, address indexed creator, string name);
    event GuardianAdded(uint256 indexed vaultId, address indexed guardian);
    event GuardianRemoved(uint256 indexed vaultId, address indexed guardian);
    event DocumentAdded(uint256 indexed documentId, uint256 indexed vaultId, string ipfsHash);
    event AccessRequested(uint256 indexed requestId, uint256 indexed documentId, address indexed requester);
    event AccessApproved(uint256 indexed requestId, address indexed approver);
    event AccessGranted(uint256 indexed requestId, uint256 indexed documentId, address indexed requester);
    event NFTMinted(uint256 indexed tokenId, address indexed to, uint256 indexed vaultId);
    event NFTBurned(uint256 indexed tokenId);
    event AccessRevoked(uint256 indexed documentId, address indexed user);
    event RevokeAccess(bytes32 indexed vaultGID, uint256 indexed documentId, address indexed targetUser, uint256 nonce);
    event VaultReleaseConfigured(uint256 indexed vaultId, uint256 inactivityPeriod);
    event ProofOfLifeRecorded(uint256 indexed vaultId, address indexed owner, uint256 timestamp);
    event EmergencyModeUpdated(uint256 indexed vaultId, bool enabled);
    event DocumentReleaseConditionSet(uint256 indexed documentId, ReleaseCondition condition);
    event PublicKeyRegistered(address indexed user, string publicKey);
    event GuardianSharesSaved(uint256 indexed documentId);
    event ShareSubmittedForBeneficiary(uint256 indexed requestId, address indexed guardian, string encryptedShare);
    event FheGuardianSharesSaved(uint256 indexed documentId, uint256 count);
    event FheShareSubmitted(uint256 indexed requestId, address indexed guardian);
    event FheSharesAggregated(uint256 indexed requestId, uint256 indexed documentId, address indexed requester, bytes aggregateCiphertext);

    /**
     * @notice Register ECIES public key for an address.
     * @param publicKey The public key string.
     */
    function registerPublicKey(string calldata publicKey) external;

    /**
     * @notice Check standardized document access permission for a user/contract.
     * @param documentId The ID of the document to query.
     * @param user The address of the user or contract inquiring about access.
     * @return status 0 = GRANTED, 1 = DOCUMENT_NOT_EXIST, 2 = NO_ACCESS, 3 = RELEASE_CONDITION_LOCKED.
     */
    function checkAccess(uint256 documentId, address user) external view returns (uint8 status);

    /**
     * @notice Query whether a user currently has active document access (valid NFT + approved grant + condition satisfied).
     * @param documentId The ID of the document.
     * @param user The address of the user.
     * @return True if the user has active access, false otherwise.
     */
    function hasActiveAccess(uint256 documentId, address user) external view returns (bool);

    /**
     * @notice Query whether a user holds a valid access token NFT for a specified vault.
     * @param user The address of the user.
     * @param vaultId The ID of the target vault.
     * @return True if the user holds an active token for the vault.
     */
    function hasVaultToken(address user, uint256 vaultId) external view returns (bool);

    /**
     * @notice Get the vault ID associated with an access token NFT.
     * @param tokenId The ID of the access token NFT.
     * @return The associated vault ID (0 if invalid/burned).
     */
    function getTokenVault(uint256 tokenId) external view returns (uint256);

    /**
     * @notice Fetch vault configuration and detail metadata.
     * @param vaultId The ID of the vault.
     */
    function getVault(uint256 vaultId) external view returns (
        uint256 id,
        address creator,
        string memory name,
        string memory description,
        address[] memory guardians,
        uint256 approvalThreshold,
        bool isActive,
        uint256 createdAt
    );

    /**
     * @notice Fetch vault release policy state summary.
     * @param vaultId The ID of the vault.
     */
    function getVaultReleaseState(uint256 vaultId) external view returns (
        bool emergencyMode,
        uint256 inactivityPeriod,
        uint256 lastProofOfLife,
        bool postDeathUnlocked
    );

    /**
     * @notice Request access to a document. Requires vault access token NFT.
     * @param documentId The ID of the target document.
     * @return requestId The generated access request ID.
     */
    function requestAccess(uint256 documentId) external returns (uint256 requestId);

    /**
     * @notice Approve a pending access request (Guardian only).
     * @param requestId The ID of the pending access request.
     */
    function approveAccess(uint256 requestId) external;

    /**
     * @notice Approve a pending access request and provide beneficiary key share (Guardian only).
     * @param requestId The ID of the pending access request.
     * @param encryptedShareForBeneficiary ECIES encrypted key share for the requester.
     */
    function approveAccess(uint256 requestId, string calldata encryptedShareForBeneficiary) external;

    /**
     * @notice Revoke user access to a specific document (Guardian only).
     * @param documentId The ID of the target document.
     * @param user The address of the user whose access is revoked.
     */
    function revokeAccess(uint256 documentId, address user) external;

    /**
     * @notice Mint a vault access token NFT to a beneficiary (Guardian only).
     * @param vaultId The ID of the vault.
     * @param to Target address receiving the NFT.
     * @param tokenURIValue Metadata URI for the token.
     * @return tokenId The newly minted token ID.
     */
    function mintAccessToken(uint256 vaultId, address to, string memory tokenURIValue) external returns (uint256 tokenId);

    /**
     * @notice Burn a vault access token NFT and immediately invalidate prior grants in O(1).
     * @param tokenId The ID of the token to burn.
     */
    function burnAccessToken(uint256 tokenId) external;

    /**
     * @notice Save FHE-encrypted shares for guardians for a document.
     * @param documentId The ID of the document.
     * @param guardians Array of guardian addresses.
     * @param sharesFHE Array of FHE ciphertext bytes for each guardian.
     */
    function saveGuardianSharesFHE(
        uint256 documentId,
        address[] calldata guardians,
        bytes[] calldata sharesFHE
    ) external;

    /**
     * @notice Approve access request using FHE encrypted share payload.
     * @param requestId The ID of the pending access request.
     * @param fheSharePayload FHE encrypted share payload submitted by the guardian.
     */
    function approveAccessFHE(uint256 requestId, bytes calldata fheSharePayload) external;

    /**
     * @notice Returns the on-chain aggregated FHE ciphertext for an approved access request.
     * @param requestId The ID of the access request.
     * @return Aggregate ciphertext bytes.
     */
    function getFheAggregate(uint256 requestId) external view returns (bytes memory);

    /**
     * @notice Returns the FHE-encrypted share stored for a document/guardian pair.
     * @param documentId The ID of the document.
     * @param guardian The guardian address.
     * @return The FHE encrypted share bytes.
     */
    function getFheGuardianShare(uint256 documentId, address guardian) external view returns (bytes memory);
}
