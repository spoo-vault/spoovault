// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./ISpooVault.sol";
import "./IERC6551Registry.sol";
import "./interfaces/IVRFCoordinatorV2Plus.sol";
import "./libs/FHEEngine.sol";
import "./libs/BLSVerifier.sol";

/// @title ReentrancyGuardTransient — Universal storage re-entrancy lock with view protection
/// @notice Provides nonReentrant mutative protection and nonReentrantView read-only protection.
abstract contract ReentrancyGuardTransient {
    uint256 private _reentrancyStatus;
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    modifier nonReentrant() {
        require(_reentrancyStatus != ENTERED, "ReentrancyGuard: reentrant call");
        _reentrancyStatus = ENTERED;
        _;
        _reentrancyStatus = NOT_ENTERED;
    }

    modifier nonReentrantView() {
        require(_reentrancyStatus != ENTERED, "ReentrancyGuard: reentrant view call");
        _;
    }
}

/**
 * @title SpooVault
 * @dev NFT-powered multi-signature encrypted document vault.
 *      Implements {ISpooVault} so third-party DApps can discover and query
 *      document access delegations through a standardized, ERC-165 discoverable
 *      interface.
 */
contract SpooVault is ERC721, ISpooVault, ReentrancyGuardTransient, EIP712 {
    using Strings for uint256;
    uint256 private _tokenIdCounter;
    uint256 private _vaultIdCounter;
    uint256 private _documentIdCounter;
    uint256 private _requestIdCounter;

    address public erc6551Registry;
    address public tbaImplementation;

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

    // Field order below is chosen for storage-slot packing: adjacent fields
    // that together fit in 32 bytes share a single slot. `creator`+`id`+
    // `isActive` pack into slot 0, `approvalThreshold`+`createdAt` into one
    // slot; `name`/`description`/`guardians` are dynamic and always take
    // their own slot regardless of position. This is a pure storage-layout
    // change - `getVault` (below) still returns the same
    // (id, creator, name, description, guardians, approvalThreshold,
    // isActive, createdAt) order and widens every narrowed field back to its
    // original external type, so callers observe no ABI change.
    struct Vault {
        address creator;
        uint64 id;
        bool isActive;
        string name;
        string description;
        address[] guardians;
        uint96 approvalThreshold;
        uint40 createdAt;
    }

    // Field order is unchanged from before (this struct's field order is
    // externally observable via the `documents` public-mapping getter), only
    // widths are narrowed: `id`+`vaultId` pack into one slot, and
    // `uploadedBy`+`uploadedAt`+`requiredAccess` (already adjacent) pack
    // into another. ABI-encoded width per field is always 32 bytes
    // regardless of the Solidity type's bit-width, so this is not a
    // breaking change for callers.
    struct Document {
        uint64 id;
        uint64 vaultId;
        string encryptedMetadata;
        string ipfsHash;
        address uploadedBy;
        uint40 uploadedAt;
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

    // Field order unchanged (externally observable via `getPendingInvites`,
    // which returns this struct directly); `guardian`+`vaultId` pack into
    // one slot and `accepted`+`expiresAt` (already adjacent) into another.
    struct GuardianInvite {
        address guardian;
        uint64 vaultId;
        bool accepted;
        uint40 expiresAt;
    }

    // Never returned as a raw struct externally (`getVaultReleaseState`
    // manually rebuilds its own return tuple), so free to reorder: all four
    // fields pack into a single slot. `targetBlocks` occupies its own slot.
    struct VaultReleaseState {
        bool emergencyMode;
        uint40 inactivityPeriod;
        uint40 lastProofOfLife;
        uint40 lastProofOfLifeBlock;
        uint256 targetBlocks;
    }

    struct KeeperAuthorization {
        address keeper;
        uint256 expiresAt;
    }

    struct GuardianRemovalProposal {
        uint256 vaultId;
        address guardianToRemove;
        address proposedBy;
        address[] approvedBy;
        bool executed;
        uint256 createdAt;
        uint256 expiresAt;
    }

    struct ThresholdUpdateProposal {
        uint256 vaultId;
        uint256 newThreshold;
        address proposedBy;
        address[] approvedBy;
        bool executed;
        uint256 createdAt;
        uint256 expiresAt;
    }

    error OnlyVrfCoordinator();
    error VrfNotConfigured();
    error VrfRequestAlreadyPending();
    error VrfUnknownRequestId();
    error VrfAlreadyFulfilled();
    error InvalidJitterWindow();

    /// @dev Minimum number of blocks that must elapse since the last proof of
    /// life before post-death conditions can unlock, in addition to the
    /// timestamp threshold. Guards against miners/validators nudging
    /// `block.timestamp` within their permitted drift window to trigger an
    /// early release without real block progression having occurred.
    uint256 public constant MIN_POST_DEATH_BLOCK_DELTA = 256;

    error AtLeastOneGuardian();
    error InvalidApprovalThreshold();
    error VaultNotActive();
    error OnlyGuardian();
    error IPFSHashRequired();
    error DocumentNotExist();
    error AlreadyHasAccess();
    error NFTRequired();
    error RequestNotExist();
    error RequestNotPending();
    error RequestExpired();
    error RequestAlreadyPending();
    error AlreadyApproved();
    error NoValidInvite();
    error InviteExpired();
    error NotOwnerOrApproved();
    error ZeroAddressGuardian();
    error DuplicateGuardian();
    error AlreadyGuardian();
    error OnlyVaultCreator();
    error InvalidInactivityPeriod();
    error VaultNotExist();
    error ReleaseConditionLocked();
    error GuardianNotExists();
    error ProposalNotExist();
    error InsufficientApprovalsForExecution();
    error InvalidNewThreshold();
    error ProposalExpired();
    error CannotRemoveOnlyGuardian();
    error ProposalAlreadyExecuted();
    error ApprovalAlreadyGiven();
    error CannotSelfApproveAccess();
    error ZeroAddressBeneficiary();
    error BeneficiaryAlreadySet();
    error InvalidNewPublicKey();
    error KeyOwnershipProofFailed();
    error KeyAlreadyRevoked();
    error RevokedPublicKey();
    error InvalidSigner();
    error KeeperExpiryInPast();
    error KeeperNotAuthorized();
    error KeeperAuthorizationExpired();
    error ReshareSessionAlreadyActive();
    error ReshareSessionNotActive();
    error ReshareDeadlineNotReached();
    error ReshareDeadlineExceeded();
    error ReshareIncomplete();
    error InvalidZeroShareCommitment();
    error ZeroShareAlreadySubmitted();
    error InvalidShareRefreshInput();
    error InvalidReshareDuration();
    error InvalidShareCommitment();
    error InvalidBLSKeyLength();
    error InvalidProofOfPossession();
    error GuardianBLSKeyNotRegistered();
    error ThresholdNotMetBLS();
    error DuplicateGuardianBLS();
    error DelegationInvalidOrExpired();

    bytes32 public constant GUARDIAN_DELEGATION_TYPEHASH = keccak256(
        "GuardianDelegation(address guardian,address delegate,uint256 vaultId,uint256 validUntil,uint256 nonce)"
    );

    struct GuardianDelegation {
        address guardian;
        address delegate;
        uint256 vaultId;
        uint256 validUntil;
        uint256 nonce;
    }

    // guardian => nonce => isRevoked
    mapping(address => mapping(uint256 => bool)) public revokedNonces;

    struct GuardianBLSKeyInfo {
        bytes publicKey;
        bytes proofOfPossession;
        bool registered;
        uint256 registeredAt;
    }

    // vaultId => guardianAddress => GuardianBLSKeyInfo
    mapping(uint256 => mapping(address => GuardianBLSKeyInfo)) public guardianBLSKeys;

    mapping(uint256 => Vault) public vaults;
    mapping(uint256 => Document) public documents;
    mapping(uint256 => AccessRequest) public accessRequests;
    mapping(uint256 => mapping(address => bool)) public isGuardian;
    mapping(uint256 => mapping(address => bool)) public hasAccess;
    mapping(uint256 => mapping(address => AccessLevel)) public userAccessLevel;
    mapping(address => mapping(uint256 => GuardianInvite)) public guardianInvites;
    mapping(address => uint256[]) public userInviteVaultIds;
    mapping(uint256 => mapping(address => bool)) public hasApprovedRequest;
    mapping(uint256 => mapping(address => uint256)) public latestRequestId;
    mapping(uint256 => string) public tokenURIs;
    mapping(uint256 => uint256) private tokenVaultMapping;
    mapping(address => mapping(uint256 => uint256)) private _ownedVaultTokenBalance;
    uint256 private _activeTokenSupply;
    mapping(uint256 => ReleaseCondition) public documentReleaseCondition;

    // ECIES and SSS specific mappings
    mapping(address => string) public userPublicKeys;
    // documentId => guardianAddress => encryptedShare
    mapping(uint256 => mapping(address => string)) public encryptedGuardianShares;
    // requestId => guardianAddress => encryptedShareForBeneficiary
    mapping(uint256 => mapping(address => string)) public beneficiaryKeyShares;
    // documentId => guardianAddress => shareCommitment (keccak256 hash)
    mapping(uint256 => mapping(address => bytes32)) public guardianShareCommitments;

    // FHE-encrypted shares and accumulator mappings
    // documentId => guardianAddress => fheCiphertext
    mapping(uint256 => mapping(address => bytes)) public fheGuardianShares;
    // requestId => guardianAddress => fheCiphertextForBeneficiary
    mapping(uint256 => mapping(address => bytes)) public fheBeneficiaryShares;
    // requestId => aggregated FHE ciphertext payload
    mapping(uint256 => bytes) public fheRequestAccumulator;
    // requestId => count of aggregated FHE shares
    mapping(uint256 => uint256) public fheAccumulatorCount;

    // Compromised key rotation and revocation registry (issue #156)
    // keccak256(publicKey) => revoked flag; blacklisted keys can never be re-registered
    mapping(bytes32 => bool) private _revokedKeyHashes;
    // Number of times an account has rotated its encryption key
    mapping(address => uint256) public keyRotationCount;

    // Access versions let us invalidate all prior document grants for a user+vault in O(1).
    mapping(uint256 => mapping(address => uint256)) private _vaultAccessVersion;
    mapping(uint256 => mapping(address => uint256)) private _documentAccessVersion;

    // Strictly-increasing per (documentId, user) nonce for cross-chain revocation
    // broadcasts. Lets a relayed message be replay-protected on the receiving
    // chain independent of any chain-specific block/ledger sequencing.
    mapping(uint256 => mapping(address => uint256)) public documentRevocationNonce;

    // Opt-in per vault: most vaults are single-chain and should not pay the
    // extra SSTORE/event gas cost of cross-chain revocation broadcasting on
    // every revokeAccess call. Only vaults linked to a Soroban counterpart
    // (via link_cross_chain_vault) need this enabled.
    mapping(uint256 => bool) public crossChainRevocationEnabled;
    mapping(uint256 => VaultReleaseState) private _vaultReleaseStates;

    // ------------------------------------------------------------------
    // Cumulative block-weighted time tracking (issue #86).
    //
    // A ring buffer of recent block timestamps lets us compute a median
    // block interval that is resistant to single-block timestamp spoofing
    // (miners may nudge block.timestamp by +/- 15s). That median interval
    // converts the configured inactivity period into a target block count,
    // so post-death unlock requires BOTH a real timestamp threshold AND a
    // proportional number of blocks to have been mined.
    // ------------------------------------------------------------------
    uint256 public constant BLOCK_HISTORY_SIZE = 256;
    uint256 private _blockHistoryHead;
    uint256[BLOCK_HISTORY_SIZE] private _blockTimestamps;
    uint256 private _blockHistoryCount;

    /// @dev Default assumed block interval (seconds) used before the ring
    /// buffer has accumulated enough samples to compute a median.
    uint256 private constant DEFAULT_BLOCK_INTERVAL = 12;
    mapping(uint256 => address) private _vaultBeneficiary;

    // ------------------------------------------------------------------
    // VRF-backed emergency unlock delay (issue #93).
    //
    // When VRF is configured, enabling emergency mode requests verifiable
    // randomness from a Chainlink VRF v2.5 coordinator. The fulfillment
    // derives an unpredictable jitter offset that is added to the base
    // unlock delay, so neither miners, guardians nor the vault owner can
    // predict or manipulate the exact block at which emergency documents
    // become releasable (anti front-running / sandwich protection).
    // ------------------------------------------------------------------
    uint256 public constant EMERGENCY_UNLOCK_BASE_DELAY = 10 minutes;
    uint256 public constant DEFAULT_EMERGENCY_JITTER_WINDOW = 1 hours;
    uint256 public constant MIN_JITTER_WINDOW = 5 minutes;
    uint256 public constant MAX_JITTER_WINDOW = 7 days;

    struct VrfConfig {
        address coordinator; // address(0) => VRF gating disabled (legacy behavior)
        bytes32 keyHash;
        uint256 subscriptionId;
        uint32 callbackGasLimit;
        uint16 minimumRequestConfirmations;
    }

    VrfConfig private _vrfConfig;
    address private immutable _vrfDeployer;

    // vaultId => scheduled emergency unlock timestamp (0 = not scheduled)
    mapping(uint256 => uint256) public emergencyUnlockAt;
    // vaultId => latest VRF request id
    mapping(uint256 => uint256) public vrfRequestIdByVault;
    // requestId => vaultId (reverse lookup for fulfillment)
    mapping(uint256 => uint256) private _vaultIdByRequestId;
    // vaultId => jitter window applied to the VRF offset
    mapping(uint256 => uint256) public emergencyJitterWindow;

    // Guardian rotation and threshold adjustment governance
    mapping(uint256 => mapping(address => GuardianRemovalProposal)) public guardianRemovalProposals;
    mapping(uint256 => mapping(uint256 => ThresholdUpdateProposal)) public thresholdUpdateProposals;
    mapping(uint256 => mapping(address => mapping(address => bool))) public hasApprovedRemoval;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public hasApprovedThreshold;

    event EmergencyUnlockDelayRequested(uint256 indexed vaultId, uint256 indexed requestId);
    event EmergencyUnlockScheduled(uint256 indexed vaultId, uint256 indexed unlockAt, uint256 jitterSeconds);
    event VrfConfigured(address indexed coordinator, bytes32 keyHash, uint256 subscriptionId);
    event EmergencyJitterWindowSet(uint256 indexed vaultId, uint256 jitterWindow);

    // Web3 Keeper (Chainlink Automation / Gelato) proof-of-life relay delegation
    bytes32 private constant KEEPER_AUTHORIZATION_TYPEHASH =
        keccak256("KeeperAuthorization(uint256 vaultId,address keeper,uint256 expiresAt,uint256 nonce)");
    mapping(uint256 => KeeperAuthorization) public keeperAuthorizations;
    mapping(uint256 => uint256) public keeperAuthNonces;

    // ------------------------------------------------------------------
    // Proactive Secret Sharing (PSS) state.
    //
    // Guardians refresh their Shamir shares of a document's master key via
    // the zero-sharing protocol: each guardian i publishes Feldman-style
    // commitments to a zero-polynomial h_i(x) with h_i(0) = 0, every
    // guardian then updates S_j' = S_j + sum_i h_i(j). The master secret
    // S(0) is preserved while all old shares become useless.
    // ------------------------------------------------------------------
    struct ReshareSession {
        uint256 startedAt;
        uint256 deadline;
        uint256 submittedCount;
        bool active;
    }

    // documentId => active reshare session
    mapping(uint256 => ReshareSession) public reshareSessions;
    // documentId => current share epoch (increments on every successful refresh)
    mapping(uint256 => uint256) public shareEpoch;
    // documentId => epoch => guardian => commitments[0..degree] where
    // commitments[k] represents the coefficient commitment of h_i(x).
    // commitments[0] is always bytes32(0) because h_i(0) = 0.
    mapping(uint256 => mapping(uint256 => mapping(address => bytes32[]))) public zeroShareCommitments;
    // documentId => epoch => guardian => whether the zero-share was submitted
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) private _zeroShareSubmitted;

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
    event CrossChainRevocationBroadcast(
        bytes32 indexed vaultGID, uint256 indexed documentId, address indexed targetUser, uint256 nonce
    );
    event VaultReleaseConfigured(uint256 indexed vaultId, uint256 inactivityPeriod);
    event ProofOfLifeRecorded(
        uint256 indexed vaultId,
        address indexed owner,
        uint256 timestamp,
        string vaultGid
    );
    event EmergencyModeUpdated(uint256 indexed vaultId, bool enabled);
    event BeneficiarySet(uint256 indexed vaultId, address indexed beneficiary);
    event DocumentReleaseConditionSet(uint256 indexed documentId, ReleaseCondition condition);
    event PublicKeyRegistered(address indexed user, string publicKey);
    event KeyRevoked(address indexed user, string oldPublicKey, string newPublicKey, uint256 rotationCount);
    event GuardianSharesSaved(uint256 indexed documentId);
    event ShareSubmittedForBeneficiary(uint256 indexed requestId, address indexed guardian, string encryptedShare);
    event ShareValidated(uint256 indexed requestId, address indexed guardian, bytes32 commitment);
    event FheGuardianSharesSaved(uint256 indexed documentId, uint256 count);
    event FheShareSubmitted(uint256 indexed requestId, address indexed guardian);
    event FheSharesAggregated(uint256 indexed requestId, uint256 indexed documentId, address indexed requester, bytes aggregateCiphertext);
    event GuardianRemovalProposed(uint256 indexed vaultId, address indexed guardian, address indexed proposedBy);
    event GuardianRemovalApproved(uint256 indexed vaultId, address indexed guardian, address indexed approver);
    event ThresholdUpdateProposed(uint256 indexed vaultId, uint256 newThreshold, address indexed proposedBy);
    event ThresholdUpdateApproved(uint256 indexed vaultId, uint256 newThreshold, address indexed approver);
    event VaultReconfigurationExecuted(uint256 indexed vaultId, address indexed guardianRemoved, uint256 newThreshold);
    event KeeperAuthorized(uint256 indexed vaultId, address indexed owner, address indexed keeper, uint256 expiresAt);
    event KeeperRevoked(uint256 indexed vaultId, address indexed owner);
    event ProofOfLifeRelayed(uint256 indexed vaultId, address indexed owner, address indexed keeper, uint256 timestamp);
    event ShareRefreshStarted(uint256 indexed documentId, uint256 indexed epoch, uint256 deadline);
    event ZeroShareCommitmentSubmitted(uint256 indexed documentId, uint256 indexed epoch, address indexed guardian, uint256 degree);
    event SharesRefreshed(uint256 indexed documentId, uint256 indexed epoch);

    /// @notice Registers the caller's ECIES/X25519 encryption public key.
    /// @param publicKey The public key string to store for `msg.sender`.
    /// @dev Reverts with `RevokedPublicKey` if the key was previously revoked as compromised.
    function registerPublicKey(string calldata publicKey) external {
        if (_revokedKeyHashes[keccak256(bytes(publicKey))]) revert RevokedPublicKey();
        userPublicKeys[msg.sender] = publicKey;
        emit PublicKeyRegistered(msg.sender, publicKey);
    }

    /// @notice Revokes a compromised public key and atomically rotates to a new one.
    /// @param oldPublicKey The compromised public key currently registered to `msg.sender`.
    /// @param newPublicKey The fresh replacement public key.
    /// @dev Proof of possession: only the account whose registered key equals `oldPublicKey`
    ///      may revoke it. The old key is permanently blacklisted: it can never be
    ///      re-registered and any contract call path that submits key material using it
    ///      is rejected while it remains the caller's registered key.
    function revokeKey(string calldata oldPublicKey, string calldata newPublicKey) external nonReentrant {
        bytes32 oldHash = keccak256(bytes(oldPublicKey));
        bytes32 newHash = keccak256(bytes(newPublicKey));

        if (bytes(newPublicKey).length == 0) revert InvalidNewPublicKey();
        if (oldHash == newHash) revert InvalidNewPublicKey();
        if (_revokedKeyHashes[newHash]) revert RevokedPublicKey();

        string memory currentKey = userPublicKeys[msg.sender];
        if (bytes(currentKey).length == 0 || keccak256(bytes(currentKey)) != oldHash) {
            revert KeyOwnershipProofFailed();
        }
        if (_revokedKeyHashes[oldHash]) revert KeyAlreadyRevoked();

        _revokedKeyHashes[oldHash] = true;
        userPublicKeys[msg.sender] = newPublicKey;
        unchecked {
            keyRotationCount[msg.sender] += 1;
        }

        emit KeyRevoked(msg.sender, oldPublicKey, newPublicKey, keyRotationCount[msg.sender]);
    }

    /// @notice Returns true if the given public key has been revoked as compromised.
    function isKeyRevoked(string calldata publicKey) external view returns (bool) {
        return _revokedKeyHashes[keccak256(bytes(publicKey))];
    }

    /// @notice Returns the encrypted guardian share stored for a document/guardian pair.
    /// @param documentId The identifier of the document.
    /// @param guardian The guardian address whose share is requested.
    /// @return The encrypted share string.
    function getEncryptedGuardianShare(uint256 documentId, address guardian) external view returns (string memory) {
        return encryptedGuardianShares[documentId][guardian];
    }

    /// @notice Returns the encrypted beneficiary key share submitted by a guardian for an access request.
    /// @param requestId The identifier of the access request.
    /// @param guardian The guardian address whose share is requested.
    /// @return The encrypted share string.
    function getBeneficiaryKeyShare(uint256 requestId, address guardian) external view returns (string memory) {
        return beneficiaryKeyShares[requestId][guardian];
    }

    /// @notice Returns the on-chain aggregated FHE ciphertext for an access request.
    /// @param requestId The identifier of the access request.
    /// @return The aggregate FHE ciphertext bytes.
    function getFheAggregate(uint256 requestId) external view returns (bytes memory) {
        return fheRequestAccumulator[requestId];
    }

    /// @notice Returns the FHE-encrypted share stored for a document/guardian pair.
    /// @param documentId The identifier of the document.
    /// @param guardian The guardian address whose share is requested.
    /// @return The FHE encrypted share bytes.
    function getFheGuardianShare(uint256 documentId, address guardian) external view returns (bytes memory) {
        return fheGuardianShares[documentId][guardian];
    }

    /// @notice Returns the FHE-encrypted share submitted by a guardian for an access request.
    /// @param requestId The identifier of the access request.
    /// @param guardian The guardian address whose share is requested.
    /// @return The FHE encrypted share bytes.
    function getFheBeneficiaryShare(uint256 requestId, address guardian) external view returns (bytes memory) {
        return fheBeneficiaryShares[requestId][guardian];
    }

    constructor() ERC721("SpooVault Access Token", "SPVT") EIP712("SpooVault", "1") {
        _vrfDeployer = msg.sender;
    }

    /**
     * @dev Initialize ERC-6551 Token Bound Account support.
     * Can only be called once to set the registry and implementation addresses.
     */
    function initializeERC6551(address registry, address implementation) external {
        if (erc6551Registry != address(0)) revert("ERC6551 already initialized");
        erc6551Registry = registry;
        tbaImplementation = implementation;
    }

    /**
     * @dev Computes the deterministic Token Bound Account address for a given vault NFT.
     */
    function computeVaultAccount(uint256 tokenId) external view returns (address) {
        if (erc6551Registry == address(0) || tbaImplementation == address(0)) {
            revert("ERC6551 not initialized");
        }
        return IERC6551Registry(erc6551Registry).account(
            tbaImplementation,
            block.chainid,
            address(this),
            tokenId,
            0
        );
    }

    /**
     * @dev Create a new vault with guardian invites.
     * msg.sender becomes the first active guardian.
     */
    function createVault(
        string memory name,
        string memory description,
        address[] calldata guardians,
        uint256 approvalThreshold
    ) external nonReentrant returns (uint256) {
        uint256 externalGuardianCount = _validateAndCountExternalGuardians(guardians, msg.sender);

        if (externalGuardianCount == 0) revert AtLeastOneGuardian();

        uint256 totalGuardianCount = externalGuardianCount + 1;
        if (approvalThreshold == 0 || approvalThreshold > totalGuardianCount) {
            revert InvalidApprovalThreshold();
        }

        _vaultIdCounter += 1;
        uint256 vaultId = _vaultIdCounter;

        Vault storage newVault = vaults[vaultId];
        newVault.id = uint64(vaultId);
        newVault.creator = msg.sender;
        newVault.name = name;
        newVault.description = description;
        newVault.approvalThreshold = uint96(approvalThreshold);
        newVault.isActive = true;
        newVault.createdAt = uint40(block.timestamp);

        _vaultReleaseStates[vaultId] = VaultReleaseState({
            emergencyMode: false,
            inactivityPeriod: 30 days,
            lastProofOfLife: uint40(block.timestamp),
            lastProofOfLifeBlock: uint40(block.number),
            targetBlocks: 30 days / getMedianBlockInterval()
        });

        newVault.guardians.push(msg.sender);
        isGuardian[vaultId][msg.sender] = true;

        for (uint256 i = 0; i < guardians.length; i++) {
            address guardian = guardians[i];
            if (guardian == msg.sender) {
                continue;
            }

            if (guardianInvites[guardian][vaultId].expiresAt == 0) {
                userInviteVaultIds[guardian].push(vaultId);
            }
            guardianInvites[guardian][vaultId] = GuardianInvite({
                guardian: guardian,
                vaultId: uint64(vaultId),
                accepted: false,
                expiresAt: uint40(block.timestamp + 7 days)
            });

        }

        emit VaultCreated(vaultId, msg.sender, name);
        return vaultId;
    }

    /**
     * @dev Validates a candidate guardian list (no zero address, no
     *      duplicates) and returns the count of guardians distinct from
     *      `sender`. The O(n^2) duplicate scan runs directly over calldata
     *      in Yul, since Solidity's own bounds-checking on every
     *      `guardians[j]` access is redundant here (`j < i < guardians.length`
     *      is already an invariant of the loop). Reverts are still ordinary
     *      Solidity custom errors decided from a status code the assembly
     *      block computes, so the revert encoding itself is left entirely to
     *      the compiler rather than hand-assembled here.
     */
    function _validateAndCountExternalGuardians(
        address[] calldata guardians,
        address sender
    ) internal pure returns (uint256 externalCount) {
        uint256 len = guardians.length;
        uint256 failureCode;
        assembly {
            let base := guardians.offset
            let extCount := 0
            let code := 0
            for { let i := 0 } lt(i, len) { i := add(i, 1) } {
                let guardian := and(
                    calldataload(add(base, mul(i, 0x20))),
                    0xffffffffffffffffffffffffffffffffffffffff
                )
                if iszero(guardian) {
                    code := 1
                    break
                }

                for { let j := 0 } lt(j, i) { j := add(j, 1) } {
                    let other := and(
                        calldataload(add(base, mul(j, 0x20))),
                        0xffffffffffffffffffffffffffffffffffffffff
                    )
                    if eq(other, guardian) {
                        code := 2
                        break
                    }
                }
                if gt(code, 0) { break }

                if iszero(eq(guardian, sender)) {
                    extCount := add(extCount, 1)
                }
            }
            externalCount := extCount
            failureCode := code
        }

        if (failureCode == 1) revert ZeroAddressGuardian();
        if (failureCode == 2) revert DuplicateGuardian();
    }

    /**
     * @dev Accept a guardian invitation. Guardian power is granted only after acceptance.
     */
    function acceptGuardianInvite(uint256 vaultId) external nonReentrant {
        if (!vaults[vaultId].isActive) revert VaultNotActive();
        if (isGuardian[vaultId][msg.sender]) revert AlreadyGuardian();

        GuardianInvite storage invite = guardianInvites[msg.sender][vaultId];

        if (invite.guardian == address(0)) revert NoValidInvite();
        if (invite.accepted) revert NoValidInvite();
        if (invite.expiresAt <= block.timestamp) revert InviteExpired();

        invite.accepted = true;
        isGuardian[vaultId][msg.sender] = true;
        vaults[vaultId].guardians.push(msg.sender);

        emit GuardianAdded(vaultId, msg.sender);
    }

    /**
     * @dev Add document metadata and encrypted content reference.
     */
    function addDocument(
        uint256 vaultId,
        string memory encryptedMetadata,
        string memory ipfsHash,
        AccessLevel requiredAccess
    ) external nonReentrant returns (uint256) {
        address[] memory emptyGuardians;
        string[] memory emptyShares;
        return _addDocument(
            vaultId,
            encryptedMetadata,
            ipfsHash,
            requiredAccess,
            ReleaseCondition.ANYTIME,
            emptyGuardians,
            emptyShares
        );
    }

    /**
     * @dev Add document with explicit release condition policy.
     */
    function addDocumentWithReleaseCondition(
        uint256 vaultId,
        string memory encryptedMetadata,
        string memory ipfsHash,
        AccessLevel requiredAccess,
        ReleaseCondition releaseCondition
    ) external nonReentrant returns (uint256) {
        address[] memory emptyGuardians;
        string[] memory emptyShares;
        return _addDocument(
            vaultId,
            encryptedMetadata,
            ipfsHash,
            requiredAccess,
            releaseCondition,
            emptyGuardians,
            emptyShares
        );
    }

    /**
     * @dev Add document with ECIES-encrypted guardian shares.
     */
    function addDocument(
        uint256 vaultId,
        string memory encryptedMetadata,
        string memory ipfsHash,
        AccessLevel requiredAccess,
        address[] calldata guardiansList,
        string[] calldata shares
    ) external nonReentrant returns (uint256) {
        return _addDocument(
            vaultId,
            encryptedMetadata,
            ipfsHash,
            requiredAccess,
            ReleaseCondition.ANYTIME,
            guardiansList,
            shares
        );
    }

    /**
     * @dev Add document with release condition policy and ECIES-encrypted guardian shares.
     */
    function addDocumentWithReleaseCondition(
        uint256 vaultId,
        string memory encryptedMetadata,
        string memory ipfsHash,
        AccessLevel requiredAccess,
        ReleaseCondition releaseCondition,
        address[] calldata guardiansList,
        string[] calldata shares
    ) external nonReentrant returns (uint256) {
        return _addDocument(
            vaultId,
            encryptedMetadata,
            ipfsHash,
            requiredAccess,
            releaseCondition,
            guardiansList,
            shares
        );
    }

    /**
     * @dev Configure how long owner inactivity unlocks post-death mode.
     *      Also computes the target block count from the inactivity period
     *      and the current median block interval, so the block-delta gate
     *      scales proportionally to the configured inactivity window.
     */
    function configureVaultRelease(uint256 vaultId, uint256 inactivityPeriod) external nonReentrant {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (vaults[vaultId].creator != msg.sender) revert OnlyVaultCreator();
        if (!vaults[vaultId].isActive) revert VaultNotActive();
        if (inactivityPeriod < 1 days || inactivityPeriod > 365 days) {
            revert InvalidInactivityPeriod();
        }

        uint256 medianInterval = getMedianBlockInterval();
        uint256 targetBlocks = inactivityPeriod / medianInterval;

        VaultReleaseState storage state = _vaultReleaseStates[vaultId];
        state.lastProofOfLife = uint40(block.timestamp);
        state.lastProofOfLifeBlock = uint40(block.number);
        state.inactivityPeriod = uint40(inactivityPeriod);
        state.targetBlocks = targetBlocks;

        emit VaultReleaseConfigured(vaultId, inactivityPeriod);
    }

    /**
     * @dev Owner heartbeat to keep vault in live mode.
     */
    function proveLife(uint256 vaultId) external nonReentrant {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (vaults[vaultId].creator != msg.sender) revert OnlyVaultCreator();
        if (!vaults[vaultId].isActive) revert VaultNotActive();

        _recordProofOfLife(vaultId);
    }

    /**
     * @dev Register a Web3 Keeper (Chainlink Automation / Gelato) to relay proof-of-life
     *      heartbeats on behalf of `vaults[vaultId].creator` until `expiresAt`, using an
     *      EIP-712 typed signature produced off-chain by the vault creator. Anyone (typically
     *      the keeper itself) can submit this signed grant on-chain; the signature alone
     *      proves the creator's consent, so this never needs to be sent from the creator's
     *      own wallet. Superseding an active grant via a fresh signature or {revokeKeeper}
     *      immediately invalidates the previous one.
     */
    function authorizeKeeperBySig(
        uint256 vaultId,
        address keeper,
        uint256 expiresAt,
        bytes calldata signature
    ) external {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (!vaults[vaultId].isActive) revert VaultNotActive();
        if (expiresAt <= block.timestamp) revert KeeperExpiryInPast();

        uint256 nonce = keeperAuthNonces[vaultId];
        bytes32 structHash = keccak256(
            abi.encode(KEEPER_AUTHORIZATION_TYPEHASH, vaultId, keeper, expiresAt, nonce)
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer != vaults[vaultId].creator) revert InvalidSigner();

        keeperAuthNonces[vaultId] = nonce + 1;
        keeperAuthorizations[vaultId] = KeeperAuthorization({keeper: keeper, expiresAt: expiresAt});

        emit KeeperAuthorized(vaultId, signer, keeper, expiresAt);
    }

    /**
     * @dev Owner revokes any active keeper authorization for their vault.
     */
    function revokeKeeper(uint256 vaultId) external {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (vaults[vaultId].creator != msg.sender) revert OnlyVaultCreator();

        delete keeperAuthorizations[vaultId];
        emit KeeperRevoked(vaultId, msg.sender);
    }

    /**
     * @dev Web3 Keeper relay of a proof-of-life heartbeat, gated on a previously
     *      registered {authorizeKeeperBySig} grant instead of the creator's own tx.
     *      Prevents a keeper outage or an owner who simply prefers automation from
     *      triggering a false emergency unlock.
     */
    function proveLifeByKeeper(uint256 vaultId) external {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (!vaults[vaultId].isActive) revert VaultNotActive();

        KeeperAuthorization storage authorization = keeperAuthorizations[vaultId];
        if (authorization.keeper != msg.sender) revert KeeperNotAuthorized();
        if (block.timestamp >= authorization.expiresAt) revert KeeperAuthorizationExpired();

        _recordProofOfLife(vaultId);
        emit ProofOfLifeRelayed(vaultId, vaults[vaultId].creator, msg.sender, block.timestamp);
    }

    /**
     * @dev Shared proof-of-life state update used by both the direct owner path and
     *      the keeper-relayed path.
     */
    function _recordProofOfLife(uint256 vaultId) internal {
        _vaultReleaseStates[vaultId].lastProofOfLife = uint40(block.timestamp);
        _vaultReleaseStates[vaultId].lastProofOfLifeBlock = uint40(block.number);
        _recordBlockTimestamp();
        emit ProofOfLifeRecorded(vaultId, vaults[vaultId].creator, block.timestamp, getVaultGID(vaultId));
    }

    /**
     * @dev Appends the current block.timestamp into the ring buffer used for
     *      median block-interval estimation. Called on every proof-of-life so
     *      the buffer samples real block progression over the vault's lifetime.
     */
    function _recordBlockTimestamp() internal {
        _blockTimestamps[_blockHistoryHead] = block.timestamp;
        _blockHistoryHead = (_blockHistoryHead + 1) % BLOCK_HISTORY_SIZE;
        if (_blockHistoryCount < BLOCK_HISTORY_SIZE) {
            _blockHistoryCount++;
        }
    }

    /**
     * @notice Returns the median block interval (seconds) derived from the
     *         ring buffer of recent block timestamps. Resistant to single-block
     *         timestamp spoofing because one manipulated sample is diluted by
     *         the surrounding honest samples in the median.
     * @return medianInterval The median interval in seconds (minimum 1).
     */
    function getMedianBlockInterval() public view returns (uint256 medianInterval) {
        if (_blockHistoryCount < 2) {
            return DEFAULT_BLOCK_INTERVAL;
        }

        // Copy timestamps into a memory array for sorting.
        uint256[] memory timestamps = new uint256[](_blockHistoryCount);
        uint256 start = (_blockHistoryHead + BLOCK_HISTORY_SIZE - _blockHistoryCount) % BLOCK_HISTORY_SIZE;
        for (uint256 i = 0; i < _blockHistoryCount; i++) {
            timestamps[i] = _blockTimestamps[(start + i) % BLOCK_HISTORY_SIZE];
        }

        // Insertion sort (buffer is small; O(n^2) is acceptable here).
        for (uint256 i = 1; i < _blockHistoryCount; i++) {
            uint256 key = timestamps[i];
            uint256 j = i;
            while (j > 0 && timestamps[j - 1] > key) {
                timestamps[j] = timestamps[j - 1];
                j--;
            }
            timestamps[j] = key;
        }

        // Compute consecutive intervals and median over those. Using the
        // median of intervals (rather than the mean) discards outlier gaps
        // caused by chain reorganizations or transient manipulation.
        uint256 intervalCount = _blockHistoryCount - 1;
        uint256[] memory intervals = new uint256[](intervalCount);
        for (uint256 i = 1; i < _blockHistoryCount; i++) {
            intervals[i - 1] = timestamps[i] - timestamps[i - 1];
        }

        for (uint256 i = 1; i < intervalCount; i++) {
            uint256 key = intervals[i];
            uint256 j = i;
            while (j > 0 && intervals[j - 1] > key) {
                intervals[j] = intervals[j - 1];
                j--;
            }
            intervals[j] = key;
        }

        if (intervalCount % 2 == 0) {
            uint256 a = intervals[(intervalCount / 2) - 1];
            uint256 b = intervals[intervalCount / 2];
            medianInterval = (a + b) / 2;
        } else {
            medianInterval = intervals[intervalCount / 2];
        }

        if (medianInterval == 0) {
            medianInterval = 1;
        }
    }

    /**
     * @notice Returns the target block count required for post-death unlock
     *         of `vaultId`, computed as inactivityPeriod / medianBlockInterval.
     *         This scales the block-delta requirement proportionally to the
     *         configured inactivity period instead of using a fixed constant.
     */
    function getTargetBlocks(uint256 vaultId) public view returns (uint256) {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        return _vaultReleaseStates[vaultId].targetBlocks;
    }

    /// @notice Returns the stable cross-chain identifier for an EVM vault.
    function getVaultGID(uint256 vaultId) public view returns (string memory) {
        return string.concat(
            block.chainid.toString(),
            ":",
            Strings.toHexString(address(this)),
            ":",
            vaultId.toString()
        );
    }

    /**
     * @dev Owner can toggle emergency mode for rapid release workflows.
     * When VRF is configured, enabling emergency mode additionally requests
     * verifiable randomness; EMERGENCY_ONLY documents stay locked until the
     * VRF-derived unlock time is reached (see {rawFulfillRandomWords}).
     */
    function setEmergencyMode(uint256 vaultId, bool enabled) external nonReentrant {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (vaults[vaultId].creator != msg.sender) revert OnlyVaultCreator();
        if (!vaults[vaultId].isActive) revert VaultNotActive();

        _vaultReleaseStates[vaultId].emergencyMode = enabled;

        if (_vrfConfig.coordinator != address(0)) {
            if (enabled) {
                if (vrfRequestIdByVault[vaultId] != 0 && !vrfRequestFulfilled(vaultId)) {
                    revert VrfRequestAlreadyPending();
                }
                // Fresh episode: clear any previous schedule before re-rolling.
                emergencyUnlockAt[vaultId] = 0;

                uint256 requestId = IVRFCoordinatorV2Plus(_vrfConfig.coordinator).requestRandomWords(
                    _vrfConfig.keyHash,
                    _vrfConfig.subscriptionId,
                    _vrfConfig.minimumRequestConfirmations,
                    _vrfConfig.callbackGasLimit,
                    1,
                    ""
                );
                vrfRequestIdByVault[vaultId] = requestId;
                _vaultIdByRequestId[requestId] = vaultId;
                emit EmergencyUnlockDelayRequested(vaultId, requestId);
            } else {
                // Disabling emergency mode resets the schedule entirely.
                delete vrfRequestIdByVault[vaultId];
                emergencyUnlockAt[vaultId] = 0;
            }
        }

        emit EmergencyModeUpdated(vaultId, enabled);
    }

    /**
     * @dev Owner-supplied beneficiary wallet address used to route emergency/post-death
     * notifications. Settable once per vault; there is no update path by design.
     */
    function setBeneficiary(uint256 vaultId, address beneficiary) external nonReentrant {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (vaults[vaultId].creator != msg.sender) revert OnlyVaultCreator();
        if (!vaults[vaultId].isActive) revert VaultNotActive();
        if (beneficiary == address(0)) revert ZeroAddressBeneficiary();
        if (_vaultBeneficiary[vaultId] != address(0)) revert BeneficiaryAlreadySet();

        _vaultBeneficiary[vaultId] = beneficiary;
        emit BeneficiarySet(vaultId, beneficiary);
    }

    /// @notice Returns the beneficiary wallet address configured for `vaultId`, or the zero address if unset.
    function getBeneficiary(uint256 vaultId) external view nonReentrantView returns (address) {
        return _vaultBeneficiary[vaultId];
    }

    /**
     * @dev Deployer configures the Chainlink VRF v2.5 coordinator. Passing
     * the zero address disables VRF gating and restores legacy behavior
     * (emergency access immediately available once mode is enabled).
     */
    function configureVrf(
        address coordinator,
        bytes32 keyHash,
        uint256 subscriptionId,
        uint32 callbackGasLimit,
        uint16 minimumRequestConfirmations
    ) external {
        if (msg.sender != _vrfDeployer) revert OnlyVrfCoordinator();
        _vrfConfig = VrfConfig({
            coordinator: coordinator,
            keyHash: keyHash,
            subscriptionId: subscriptionId,
            callbackGasLimit: callbackGasLimit,
            minimumRequestConfirmations: minimumRequestConfirmations
        });
        emit VrfConfigured(coordinator, keyHash, subscriptionId);
    }

    /**
     * @dev Vault creator tunes the jitter window Delta_T used to scale the
     * VRF offset: T_random = VRF() mod Delta_T.
     */
    function setEmergencyJitterWindow(uint256 vaultId, uint256 jitterWindow) external {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (vaults[vaultId].creator != msg.sender) revert OnlyVaultCreator();
        if (jitterWindow < MIN_JITTER_WINDOW || jitterWindow > MAX_JITTER_WINDOW) {
            revert InvalidJitterWindow();
        }

        emergencyJitterWindow[vaultId] = jitterWindow;
        emit EmergencyJitterWindowSet(vaultId, jitterWindow);
    }

    /**
     * @dev Entry point called by the VRF coordinator with verified randomness.
     * Only the configured coordinator may call this; the request id must
     * match the latest one issued for the vault and can only be fulfilled
     * once, so neither miners nor guardians can influence or replay the
     * resulting unlock schedule.
     */
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (_vrfConfig.coordinator == address(0) || msg.sender != _vrfConfig.coordinator) {
            revert OnlyVrfCoordinator();
        }
        if (randomWords.length == 0) revert VrfUnknownRequestId();

        uint256 vaultId = _vaultIdByRequestId[requestId];
        if (vaultId == 0) revert VrfUnknownRequestId();
        if (emergencyUnlockAt[vaultId] != 0) revert VrfAlreadyFulfilled();

        uint256 window = emergencyJitterWindow[vaultId] != 0
            ? emergencyJitterWindow[vaultId]
            : DEFAULT_EMERGENCY_JITTER_WINDOW;
        uint256 jitter = randomWords[0] % window;
        uint256 unlockAt = block.timestamp + EMERGENCY_UNLOCK_BASE_DELAY + jitter;

        emergencyUnlockAt[vaultId] = unlockAt;
        emit EmergencyUnlockScheduled(vaultId, unlockAt, jitter);
    }

    /**
     * @dev Returns whether the latest VRF request for a vault has been
     * fulfilled (a schedule exists).
     */
    function vrfRequestFulfilled(uint256 vaultId) public view returns (bool) {
        return emergencyUnlockAt[vaultId] != 0;
    }

    /**
     * @dev Returns the current VRF configuration.
     */
    function getVrfConfig() external view returns (
        address coordinator,
        bytes32 keyHash,
        uint256 subscriptionId,
        uint32 callbackGasLimit,
        uint16 minimumRequestConfirmations
    ) {
        VrfConfig memory cfg = _vrfConfig;
        return (
            cfg.coordinator,
            cfg.keyHash,
            cfg.subscriptionId,
            cfg.callbackGasLimit,
            cfg.minimumRequestConfirmations
        );
    }

    /**
     * @dev Returns the scheduled emergency unlock summary for a vault.
     */
    function getEmergencyUnlockSchedule(uint256 vaultId) external view returns (
        bool requested,
        bool fulfilled,
        uint256 unlockAt
    ) {
        uint256 requestId = vrfRequestIdByVault[vaultId];
        return (requestId != 0, emergencyUnlockAt[vaultId] != 0, emergencyUnlockAt[vaultId]);
    }

    /**
     * @dev Guardians can update an existing document release condition.
     */
    function setDocumentReleaseCondition(
        uint256 documentId,
        ReleaseCondition condition
    ) external nonReentrant {
        if (documents[documentId].id == 0) revert DocumentNotExist();
        uint256 vaultId = documents[documentId].vaultId;
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();

        documentReleaseCondition[documentId] = condition;
        emit DocumentReleaseConditionSet(documentId, condition);
    }

    /**
     * @dev Fetch vault release state summary.
     */
    function getVaultReleaseState(uint256 vaultId) external view nonReentrantView returns (
        bool emergencyMode,
        uint256 inactivityPeriod,
        uint256 lastProofOfLife,
        bool postDeathUnlocked
    ) {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        VaultReleaseState storage state = _vaultReleaseStates[vaultId];
        bool unlocked = _isPostDeathUnlocked(vaultId);
        return (
            state.emergencyMode,
            state.inactivityPeriod,
            state.lastProofOfLife,
            unlocked
        );
    }

    /**
     * @dev Propose removal of a guardian from the vault.
     * Requires majority consensus (>50%) of guardians to approve before execution.
     */
    function proposeGuardianRemoval(uint256 vaultId, address guardianToRemove) external nonReentrant {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();
        if (!isGuardian[vaultId][guardianToRemove]) revert GuardianNotExists();
        if (vaults[vaultId].guardians.length <= 1) revert CannotRemoveOnlyGuardian();

        GuardianRemovalProposal storage proposal = guardianRemovalProposals[vaultId][guardianToRemove];
        
        if (proposal.createdAt != 0 && proposal.expiresAt > block.timestamp && !proposal.executed) {
            revert ProposalNotExist();
        }

        uint256 expiresAt = block.timestamp + 7 days;
        guardianRemovalProposals[vaultId][guardianToRemove] = GuardianRemovalProposal({
            vaultId: vaultId,
            guardianToRemove: guardianToRemove,
            proposedBy: msg.sender,
            approvedBy: new address[](0),
            executed: false,
            createdAt: block.timestamp,
            expiresAt: expiresAt
        });

        emit GuardianRemovalProposed(vaultId, guardianToRemove, msg.sender);
    }

    /**
     * @dev Approve a guardian removal proposal.
     * Once >50% of guardians approve, the proposal is ready for execution.
     */
    function approveGuardianRemoval(uint256 vaultId, address guardianToRemove) external nonReentrant {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();

        GuardianRemovalProposal storage proposal = guardianRemovalProposals[vaultId][guardianToRemove];
        if (proposal.createdAt == 0) revert ProposalNotExist();
        if (proposal.expiresAt <= block.timestamp) revert ProposalExpired();
        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (hasApprovedRemoval[vaultId][guardianToRemove][msg.sender]) revert ApprovalAlreadyGiven();

        hasApprovedRemoval[vaultId][guardianToRemove][msg.sender] = true;
        proposal.approvedBy.push(msg.sender);

        emit GuardianRemovalApproved(vaultId, guardianToRemove, msg.sender);
    }

    /**
     * @dev Propose an update to the vault's approval threshold.
     * Requires majority consensus (>50%) of guardians to approve before execution.
     */
    function proposeThresholdUpdate(uint256 vaultId, uint256 newThreshold) external nonReentrant {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();
        if (newThreshold == 0 || newThreshold > vaults[vaultId].guardians.length) {
            revert InvalidNewThreshold();
        }

        ThresholdUpdateProposal storage proposal = thresholdUpdateProposals[vaultId][newThreshold];
        
        if (proposal.createdAt != 0 && proposal.expiresAt > block.timestamp && !proposal.executed) {
            revert ProposalNotExist();
        }

        uint256 expiresAt = block.timestamp + 7 days;
        thresholdUpdateProposals[vaultId][newThreshold] = ThresholdUpdateProposal({
            vaultId: vaultId,
            newThreshold: newThreshold,
            proposedBy: msg.sender,
            approvedBy: new address[](0),
            executed: false,
            createdAt: block.timestamp,
            expiresAt: expiresAt
        });

        emit ThresholdUpdateProposed(vaultId, newThreshold, msg.sender);
    }

    /**
     * @dev Approve a threshold update proposal.
     * Once >50% of guardians approve, the proposal is ready for execution.
     */
    function approveThresholdUpdate(uint256 vaultId, uint256 newThreshold) external nonReentrant {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();

        ThresholdUpdateProposal storage proposal = thresholdUpdateProposals[vaultId][newThreshold];
        if (proposal.createdAt == 0) revert ProposalNotExist();
        if (proposal.expiresAt <= block.timestamp) revert ProposalExpired();
        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (hasApprovedThreshold[vaultId][newThreshold][msg.sender]) revert ApprovalAlreadyGiven();

        hasApprovedThreshold[vaultId][newThreshold][msg.sender] = true;
        proposal.approvedBy.push(msg.sender);

        emit ThresholdUpdateApproved(vaultId, newThreshold, msg.sender);
    }

    /**
     * @dev Execute vault reconfiguration after guardian removal and/or threshold update approvals.
     * Both proposals (if pending) must have >50% guardian consensus to execute.
     * Execution is atomic: both changes are applied together or not at all.
     */
    function executeVaultReconfiguration(
        uint256 vaultId,
        address guardianToRemove,
        uint256 newThreshold
    ) external nonReentrant {
        if (vaults[vaultId].id == 0) revert VaultNotExist();

        Vault storage vault = vaults[vaultId];
        uint256 currentGuardianCount = vault.guardians.length;
        uint256 requiredApprovals = (currentGuardianCount / 2) + 1;

        GuardianRemovalProposal storage removalProposal = guardianRemovalProposals[vaultId][guardianToRemove];
        ThresholdUpdateProposal storage thresholdProposal = thresholdUpdateProposals[vaultId][newThreshold];

        bool hasRemovalProposal = removalProposal.createdAt != 0 && !removalProposal.executed && removalProposal.expiresAt > block.timestamp;
        bool hasThresholdProposal = thresholdProposal.createdAt != 0 && !thresholdProposal.executed && thresholdProposal.expiresAt > block.timestamp;

        if (!hasRemovalProposal && !hasThresholdProposal) {
            revert ProposalNotExist();
        }

        if (hasRemovalProposal) {
            if (removalProposal.approvedBy.length < requiredApprovals) {
                revert InsufficientApprovalsForExecution();
            }

            _removeGuardian(vaultId, guardianToRemove);
            removalProposal.executed = true;

            currentGuardianCount--;
        }

        if (hasThresholdProposal) {
            if (thresholdProposal.approvedBy.length < requiredApprovals) {
                revert InsufficientApprovalsForExecution();
            }

            if (newThreshold > currentGuardianCount) {
                revert InvalidNewThreshold();
            }

            vault.approvalThreshold = uint96(newThreshold);
            thresholdProposal.executed = true;
        }

        emit VaultReconfigurationExecuted(vaultId, guardianToRemove, newThreshold);
    }

    // ------------------------------------------------------------------
    // Proactive Secret Sharing (zero-sharing based share refresh)
    // ------------------------------------------------------------------

    /**
     * @dev Opens a reshare window for a document's guardian shares.
     * Every current guardian must publish a zero-polynomial commitment
     * before {applyShareRefresh} can bump the share epoch.
     * @param documentId The document whose shares are being refreshed.
     * @param duration Length of the submission window (1 hour .. 7 days).
     */
    function startShareRefresh(uint256 documentId, uint256 duration) external {
        if (documents[documentId].id == 0) revert DocumentNotExist();
        uint256 vaultId = documents[documentId].vaultId;
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();
        if (reshareSessions[documentId].active) revert ReshareSessionAlreadyActive();
        if (duration < 1 hours || duration > 7 days) revert InvalidReshareDuration();

        uint256 nextEpoch = shareEpoch[documentId] + 1;
        ReshareSession storage session = reshareSessions[documentId];
        session.startedAt = block.timestamp;
        session.deadline = block.timestamp + duration;
        session.submittedCount = 0;
        session.active = true;

        emit ShareRefreshStarted(documentId, nextEpoch, session.deadline);
    }

    /**
     * @dev Guardian submits Feldman-style commitments to its zero-polynomial
     * h_i(x) with the defining property h_i(0) = 0 (enforced on-chain by
     * requiring commitments[0] == bytes32(0)). Off-chain, h_i(j) is derived
     * from these commitments and added to guardian j's share.
     * @param documentId The document whose shares are being refreshed.
     * @param commitments Coefficient commitments [g^a_0, g^a_1, ..., g^a_t]
     *        where a_0 must be zero.
     */
    function submitZeroShareCommitment(uint256 documentId, bytes32[] calldata commitments) external {
        if (documents[documentId].id == 0) revert DocumentNotExist();
        ReshareSession storage session = reshareSessions[documentId];
        if (!session.active) revert ReshareSessionNotActive();
        if (block.timestamp > session.deadline) revert ReshareDeadlineExceeded();

        uint256 vaultId = documents[documentId].vaultId;
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();

        uint256 epoch = shareEpoch[documentId] + 1;
        if (_zeroShareSubmitted[documentId][epoch][msg.sender]) {
            revert ZeroShareAlreadySubmitted();
        }
        if (commitments.length < 2 || commitments[0] != bytes32(0)) {
            revert InvalidZeroShareCommitment();
        }

        _zeroShareSubmitted[documentId][epoch][msg.sender] = true;
        zeroShareCommitments[documentId][epoch][msg.sender] = commitments;
        session.submittedCount += 1;

        emit ZeroShareCommitmentSubmitted(documentId, epoch, msg.sender, commitments.length - 1);
    }

    /**
     * @dev Sets the initial Feldmann VSS polynomial commitments for a document.
     * Callable by vault guardians or creator.
     */
    function setDocumentVSSCommitments(uint256 documentId, bytes32[] calldata commitments) external {
        if (documents[documentId].id == 0) revert DocumentNotExist();
        uint256 vaultId = documents[documentId].vaultId;
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();
        if (commitments.length < 2) revert InvalidVSSCommitmentUpdate();

        documentVssCommitments[documentId] = commitments;
        emit VSSCommitmentsUpdated(documentId, shareEpoch[documentId], commitments);
    }

    /**
     * @dev Returns the current active Feldmann VSS polynomial coefficient commitments for a document.
     */
    function getDocumentVSSCommitments(uint256 documentId) external view returns (bytes32[] memory) {
        return documentVssCommitments[documentId];
    }

    /**
     * @dev Finalizes the refresh once every current guardian has published a
     * zero-share commitment. Stores the redistributed (re-encrypted) shares
     * and irreversibly bumps the share epoch, invalidating all pre-refresh
     * share material for this document.
     * @param documentId The document whose shares are being refreshed.
     * @param guardiansList Full guardian set of the vault (order defines
     *        the polynomial evaluation points used off-chain).
     * @param newShares Updated ECIES-encrypted shares, one per guardian.
     */
    function applyShareRefresh(
        uint256 documentId,
        address[] calldata guardiansList,
        string[] calldata newShares
    ) external {
        _applyShareRefresh(documentId, guardiansList, newShares, new bytes32[](0));
    }

    /**
     * @dev Overload of applyShareRefresh that additionally updates the on-chain
     * Feldmann VSS polynomial coefficient commitments to reflect the refreshed shares.
     * Invariance check: Enforces newCommitments[0] == documentVssCommitments[documentId][0]
     * so that the master key commitment remains unchanged.
     * @param documentId The document whose shares are being refreshed.
     * @param guardiansList Full guardian set of the vault.
     * @param newShares Updated ECIES-encrypted shares, one per guardian.
     * @param newCommitments Updated coefficient commitments [C'_0, C'_1, ..., C'_{k-1}].
     */
    function applyShareRefresh(
        uint256 documentId,
        address[] calldata guardiansList,
        string[] calldata newShares,
        bytes32[] calldata newCommitments
    ) external {
        _applyShareRefresh(documentId, guardiansList, newShares, newCommitments);
    }

    function _applyShareRefresh(
        uint256 documentId,
        address[] calldata guardiansList,
        string[] calldata newShares,
        bytes32[] memory newCommitments
    ) internal {
        if (documents[documentId].id == 0) revert DocumentNotExist();
        ReshareSession storage session = reshareSessions[documentId];
        if (!session.active) revert ReshareSessionNotActive();

        uint256 vaultId = documents[documentId].vaultId;
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();

        address[] storage vaultGuardians = vaults[vaultId].guardians;
        if (
            guardiansList.length != vaultGuardians.length ||
            newShares.length != guardiansList.length
        ) {
            revert InvalidShareRefreshInput();
        }

        for (uint256 i = 0; i < guardiansList.length; i++) {
            address guardian = guardiansList[i];
            if (!isGuardian[vaultId][guardian]) revert InvalidShareRefreshInput();

            for (uint256 j = 0; j < i; j++) {
                if (guardiansList[j] == guardian) revert InvalidShareRefreshInput();
            }

            encryptedGuardianShares[documentId][guardian] = newShares[i];
            if (bytes(newShares[i]).length > 0) {
                guardianShareCommitments[documentId][guardian] = keccak256(bytes(newShares[i]));
            }
        }

        if (session.submittedCount < vaultGuardians.length) {
            if (block.timestamp <= session.deadline) revert ReshareDeadlineNotReached();
            revert ReshareIncomplete();
        }

        if (newCommitments.length > 0) {
            bytes32[] storage currentComm = documentVssCommitments[documentId];
            if (currentComm.length > 0) {
                if (newCommitments.length != currentComm.length || newCommitments[0] != currentComm[0]) {
                    revert InvalidVSSCommitmentUpdate();
                }
            } else {
                if (newCommitments.length < 2) {
                    revert InvalidVSSCommitmentUpdate();
                }
            }
            documentVssCommitments[documentId] = newCommitments;
        }

        session.active = false;
        uint256 newEpoch = shareEpoch[documentId] + 1;
        shareEpoch[documentId] = newEpoch;

        emit SharesRefreshed(documentId, newEpoch);
        if (newCommitments.length > 0) {
            emit VSSCommitmentsUpdated(documentId, newEpoch, newCommitments);
        }
    }

    /**
     * @dev Returns whether a guardian has submitted its zero-share commitment
     * for the given epoch.
     */
    function hasSubmittedZeroShare(
        uint256 documentId,
        uint256 epoch,
        address guardian
    ) external view returns (bool) {
        return _zeroShareSubmitted[documentId][epoch][guardian];
    }

    /**
     * @dev Returns the full zero-polynomial commitment vector published by
     * `guardian` for `epoch`. commitments[0] is always bytes32(0).
     */
    function getZeroShareCommitments(
        uint256 documentId,
        uint256 epoch,
        address guardian
    ) external view returns (bytes32[] memory) {
        return zeroShareCommitments[documentId][epoch][guardian];
    }

    /**
     * @dev Returns the active reshare session summary for a document.
     */
    function getReshareSession(uint256 documentId) external view returns (
        uint256 startedAt,
        uint256 deadline,
        uint256 submittedCount,
        bool active
    ) {
        ReshareSession storage session = reshareSessions[documentId];
        return (session.startedAt, session.deadline, session.submittedCount, session.active);
    }

    /**
     * @dev Internal helper to remove a guardian from a vault.
     */
    function _removeGuardian(uint256 vaultId, address guardianToRemove) internal {
        Vault storage vault = vaults[vaultId];
        
        for (uint256 i = 0; i < vault.guardians.length; i++) {
            if (vault.guardians[i] == guardianToRemove) {
                vault.guardians[i] = vault.guardians[vault.guardians.length - 1];
                vault.guardians.pop();
                break;
            }
        }

        isGuardian[vaultId][guardianToRemove] = false;
        emit GuardianRemoved(vaultId, guardianToRemove);
    }

    /**
     * @dev Blocks elapsed since the last recorded proof of life for a vault.
     */
    function getBlocksSinceProofOfLife(uint256 vaultId) external view returns (uint256) {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        VaultReleaseState storage state = _vaultReleaseStates[vaultId];
        if (block.number <= state.lastProofOfLifeBlock) {
            return 0;
        }
        return block.number - state.lastProofOfLifeBlock;
    }

    function _addDocument(
        uint256 vaultId,
        string memory encryptedMetadata,
        string memory ipfsHash,
        AccessLevel requiredAccess,
        ReleaseCondition releaseCondition,
        address[] memory guardiansList,
        string[] memory shares
    ) internal returns (uint256) {
        if (!vaults[vaultId].isActive) revert VaultNotActive();
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();
        if (bytes(ipfsHash).length == 0) revert IPFSHashRequired();

        _documentIdCounter += 1;
        uint256 documentId = _documentIdCounter;

        documents[documentId] = Document({
            id: uint64(documentId),
            vaultId: uint64(vaultId),
            encryptedMetadata: encryptedMetadata,
            ipfsHash: ipfsHash,
            uploadedBy: msg.sender,
            uploadedAt: uint40(block.timestamp),
            requiredAccess: requiredAccess
        });

        documentReleaseCondition[documentId] = releaseCondition;
        _grantAccess(0, documentId, msg.sender);

        for (uint256 i = 0; i < guardiansList.length; i++) {
            encryptedGuardianShares[documentId][guardiansList[i]] = shares[i];
            if (bytes(shares[i]).length > 0) {
                guardianShareCommitments[documentId][guardiansList[i]] = keccak256(bytes(shares[i]));
            }
        }

        emit DocumentAdded(documentId, vaultId, ipfsHash);
        emit DocumentReleaseConditionSet(documentId, releaseCondition);
        if (guardiansList.length > 0) {
            emit GuardianSharesSaved(documentId);
        }
        return documentId;
    }

    /**
     * @dev Request access to a document. Requires current ownership of a vault NFT.
     */
    function requestAccess(uint256 documentId) external nonReentrant returns (uint256) {
        if (documents[documentId].id == 0) revert DocumentNotExist();
        if (_hasActiveAccess(documentId, msg.sender)) revert AlreadyHasAccess();
        if (!_isReleaseConditionSatisfied(documentId)) revert ReleaseConditionLocked();

        uint256 vaultId = documents[documentId].vaultId;
        if (!_ownsVaultToken(msg.sender, vaultId)) revert NFTRequired();

        uint256 existingRequestId = latestRequestId[documentId][msg.sender];
        if (existingRequestId != 0) {
            AccessRequest storage existingRequest = accessRequests[existingRequestId];
            if (
                existingRequest.status == RequestStatus.PENDING &&
                existingRequest.expiresAt > block.timestamp
            ) {
                revert RequestAlreadyPending();
            }
        }

        _requestIdCounter += 1;
        uint256 requestId = _requestIdCounter;

        accessRequests[requestId] = AccessRequest({
            requestId: requestId,
            documentId: documentId,
            requester: msg.sender,
            approvedBy: new address[](0),
            status: RequestStatus.PENDING,
            expiresAt: block.timestamp + 3 days,
            createdAt: block.timestamp
        });

        latestRequestId[documentId][msg.sender] = requestId;

        emit AccessRequested(requestId, documentId, msg.sender);
        return requestId;
    }

    /**
     * @dev Save FHE-encrypted guardian shares for a document.
     */
    function saveGuardianSharesFHE(
        uint256 documentId,
        address[] calldata guardiansList,
        bytes[] calldata sharesFHE
    ) external nonReentrant {
        if (documents[documentId].id == 0) revert DocumentNotExist();
        uint256 vaultId = documents[documentId].vaultId;
        if (vaults[vaultId].creator != msg.sender && !isGuardian[vaultId][msg.sender]) {
            revert OnlyGuardian();
        }
        if (guardiansList.length != sharesFHE.length) revert InvalidShareRefreshInput();

        for (uint256 i = 0; i < guardiansList.length; i++) {
            fheGuardianShares[documentId][guardiansList[i]] = sharesFHE[i];
        }
        emit FheGuardianSharesSaved(documentId, guardiansList.length);
    }

    /**
     * @dev Approve an access request (accepted guardian only, never the requester).
     */
    function approveAccess(uint256 requestId) external nonReentrant {
        _approveAccess(requestId, "");
    }

    /**
     * @dev Approve an access request and submit the decrypted key share for the beneficiary.
     * The requester can never approve their own request; quorum therefore counts only
     * distinct accepted guardians other than the requester.
     */
    function approveAccess(uint256 requestId, string calldata encryptedShareForBeneficiary) external nonReentrant {
        _approveAccess(requestId, encryptedShareForBeneficiary);
    }

    /**
     * @dev Approve an access request using an FHE-encrypted share payload.
     *      Homomorphically accumulates the share directly on-chain without decrypting.
     */
    function approveAccessFHE(uint256 requestId, bytes calldata fheSharePayload) external nonReentrant {
        AccessRequest storage request = accessRequests[requestId];
        if (request.requestId == 0) revert RequestNotExist();
        if (request.status != RequestStatus.PENDING) revert RequestNotPending();
        if (request.expiresAt <= block.timestamp) revert RequestExpired();
        if (request.requester == msg.sender) revert CannotSelfApproveAccess();

        uint256 vaultId = documents[request.documentId].vaultId;
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();
        if (hasApprovedRequest[requestId][msg.sender]) revert AlreadyApproved();

        bytes memory guardianKey = bytes(userPublicKeys[msg.sender]);
        if (guardianKey.length != 0 && _revokedKeyHashes[keccak256(guardianKey)]) {
            revert RevokedPublicKey();
        }

        hasApprovedRequest[requestId][msg.sender] = true;
        request.approvedBy.push(msg.sender);

        if (fheSharePayload.length > 0) {
            fheBeneficiaryShares[requestId][msg.sender] = fheSharePayload;
            bytes memory currentAcc = fheRequestAccumulator[requestId];
            fheRequestAccumulator[requestId] = FHEEngine.fheAdd(currentAcc, fheSharePayload);
            fheAccumulatorCount[requestId] += 1;
            emit FheShareSubmitted(requestId, msg.sender);
        }

        emit AccessApproved(requestId, msg.sender);

        if (request.approvedBy.length >= vaults[vaultId].approvalThreshold) {
            if (!_ownsVaultToken(request.requester, vaultId)) {
                request.status = RequestStatus.REJECTED;
                return;
            }

            request.status = RequestStatus.APPROVED;
            _grantAccess(requestId, request.documentId, request.requester);
            emit FheSharesAggregated(
                requestId,
                request.documentId,
                request.requester,
                fheRequestAccumulator[requestId]
            );
        }
    }

    function _approveAccess(uint256 requestId, string memory encryptedShareForBeneficiary) internal {
        AccessRequest storage request = accessRequests[requestId];
        if (request.requestId == 0) revert RequestNotExist();
        if (request.status != RequestStatus.PENDING) revert RequestNotPending();
        if (request.expiresAt <= block.timestamp) revert RequestExpired();
        if (request.requester == msg.sender) revert CannotSelfApproveAccess();

        uint256 vaultId = documents[request.documentId].vaultId;
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();
        if (hasApprovedRequest[requestId][msg.sender]) revert AlreadyApproved();

        // A guardian whose registered key is blacklisted as compromised may not submit
        // new key material until it has been rotated via revokeKey().
        bytes memory guardianKey = bytes(userPublicKeys[msg.sender]);
        if (guardianKey.length != 0 && _revokedKeyHashes[keccak256(guardianKey)]) {
            revert RevokedPublicKey();
        }

        hasApprovedRequest[requestId][msg.sender] = true;
        request.approvedBy.push(msg.sender);

        if (bytes(encryptedShareForBeneficiary).length > 0) {
            bytes32 expectedCommitment = guardianShareCommitments[request.documentId][msg.sender];
            if (expectedCommitment == bytes32(0) && bytes(encryptedGuardianShares[request.documentId][msg.sender]).length > 0) {
                expectedCommitment = keccak256(bytes(encryptedGuardianShares[request.documentId][msg.sender]));
            }
            if (expectedCommitment != bytes32(0)) {
                bytes32 submittedCommitment = keccak256(bytes(encryptedShareForBeneficiary));
                if (submittedCommitment != expectedCommitment) {
                    revert InvalidShareCommitment();
                }
                emit ShareValidated(requestId, msg.sender, submittedCommitment);
            }
            beneficiaryKeyShares[requestId][msg.sender] = encryptedShareForBeneficiary;
            emit ShareSubmittedForBeneficiary(requestId, msg.sender, encryptedShareForBeneficiary);
        }

        emit AccessApproved(requestId, msg.sender);

        if (request.approvedBy.length >= vaults[vaultId].approvalThreshold) {
            if (!_ownsVaultToken(request.requester, vaultId)) {
                request.status = RequestStatus.REJECTED;
                return;
            }

            request.status = RequestStatus.APPROVED;
            _grantAccess(requestId, request.documentId, request.requester);
        }
    }

    /**
     * @notice Instantly revokes an off-chain EIP-712 delegation nonce for the caller.
     * @param nonce The delegation nonce to invalidate.
     */
    function revokeDelegation(uint256 nonce) external {
        revokedNonces[msg.sender][nonce] = true;
        emit DelegationRevoked(msg.sender, nonce);
    }

    /**
     * @notice Verifies an EIP-712 typed data guardian delegation signature.
     * @param guardian The guardian address granting delegation.
     * @param delegate The delegate authorized to act on behalf of the guardian.
     * @param vaultId The vault for which delegation is valid.
     * @param validUntil Expiration timestamp for the delegation.
     * @param nonce Replay and revocation tracking nonce.
     * @param signature 65-byte ECDSA signature over the EIP-712 typed struct hash.
     * @return bool True if the signature is valid, unexpired, unrevoked, and guardian belongs to vault.
     */
    function verifyDelegation(
        address guardian,
        address delegate,
        uint256 vaultId,
        uint256 validUntil,
        uint256 nonce,
        bytes calldata signature
    ) public view returns (bool) {
        if (block.timestamp > validUntil) return false;
        if (revokedNonces[guardian][nonce]) return false;
        if (!isGuardian[vaultId][guardian]) return false;

        bytes32 structHash = keccak256(
            abi.encode(
                GUARDIAN_DELEGATION_TYPEHASH,
                guardian,
                delegate,
                vaultId,
                validUntil,
                nonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError) {
            return false;
        }
        return recovered == guardian;
    }

    /**
     * @notice Approves a document access request on behalf of a guardian using a valid EIP-712 delegation.
     * @param requestId Document access request ID.
     * @param guardian The guardian who signed the delegation.
     * @param validUntil Expiration timestamp for the delegation.
     * @param nonce Replay and revocation tracking nonce.
     * @param signature EIP-712 ECDSA signature by the guardian.
     */
    function approveAccessDelegated(
        uint256 requestId,
        address guardian,
        uint256 validUntil,
        uint256 nonce,
        bytes calldata signature
    ) external nonReentrant {
        _approveAccessDelegated(requestId, guardian, validUntil, nonce, signature, "");
    }

    /**
     * @notice Approves a document access request with beneficiary key share on behalf of a guardian using a valid EIP-712 delegation.
     * @param requestId Document access request ID.
     * @param guardian The guardian who signed the delegation.
     * @param validUntil Expiration timestamp for the delegation.
     * @param nonce Replay and revocation tracking nonce.
     * @param signature EIP-712 ECDSA signature by the guardian.
     * @param encryptedShareForBeneficiary Beneficiary key share encrypted with beneficiary public key.
     */
    function approveAccessDelegated(
        uint256 requestId,
        address guardian,
        uint256 validUntil,
        uint256 nonce,
        bytes calldata signature,
        string calldata encryptedShareForBeneficiary
    ) external nonReentrant {
        _approveAccessDelegated(requestId, guardian, validUntil, nonce, signature, encryptedShareForBeneficiary);
    }

    function _approveAccessDelegated(
        uint256 requestId,
        address guardian,
        uint256 validUntil,
        uint256 nonce,
        bytes calldata signature,
        string memory encryptedShareForBeneficiary
    ) internal {
        AccessRequest storage request = accessRequests[requestId];
        if (request.requestId == 0) revert RequestNotExist();
        if (request.status != RequestStatus.PENDING) revert RequestNotPending();
        if (request.expiresAt <= block.timestamp) revert RequestExpired();
        if (request.requester == guardian || request.requester == msg.sender) revert CannotSelfApproveAccess();

        uint256 vaultId = documents[request.documentId].vaultId;
        if (!verifyDelegation(guardian, msg.sender, vaultId, validUntil, nonce, signature)) {
            revert DelegationInvalidOrExpired();
        }

        if (hasApprovedRequest[requestId][guardian]) revert AlreadyApproved();

        bytes memory guardianKey = bytes(userPublicKeys[guardian]);
        if (guardianKey.length != 0 && _revokedKeyHashes[keccak256(guardianKey)]) {
            revert RevokedPublicKey();
        }

        hasApprovedRequest[requestId][guardian] = true;
        request.approvedBy.push(guardian);

        if (bytes(encryptedShareForBeneficiary).length > 0) {
            bytes32 expectedCommitment = guardianShareCommitments[request.documentId][guardian];
            if (expectedCommitment == bytes32(0) && bytes(encryptedGuardianShares[request.documentId][guardian]).length > 0) {
                expectedCommitment = keccak256(bytes(encryptedGuardianShares[request.documentId][guardian]));
            }
            if (expectedCommitment != bytes32(0)) {
                bytes32 submittedCommitment = keccak256(bytes(encryptedShareForBeneficiary));
                if (submittedCommitment != expectedCommitment) {
                    revert InvalidShareCommitment();
                }
                emit ShareValidated(requestId, guardian, submittedCommitment);
            }
            beneficiaryKeyShares[requestId][guardian] = encryptedShareForBeneficiary;
            emit ShareSubmittedForBeneficiary(requestId, guardian, encryptedShareForBeneficiary);
        }

        emit AccessApproved(requestId, guardian);
        emit DelegatedApprovalSubmitted(requestId, guardian, msg.sender);

        if (request.approvedBy.length >= vaults[vaultId].approvalThreshold) {
            if (!_ownsVaultToken(request.requester, vaultId)) {
                request.status = RequestStatus.REJECTED;
                return;
            }

            request.status = RequestStatus.APPROVED;
            _grantAccess(requestId, request.documentId, request.requester);
        }
    }

    /**
     * @notice Registers a BLS12-381 G1 public key with Proof of Possession for a vault guardian.
     * @param vaultId Vault identifier.
     * @param blsPublicKey 48-byte compressed G1 public key.
     * @param proofOfPossession 96-byte compressed G2 Proof of Possession signature.
     */
    function registerGuardianBLSKey(
        uint256 vaultId,
        bytes calldata blsPublicKey,
        bytes calldata proofOfPossession
    ) external nonReentrant override {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();
        if (blsPublicKey.length != 48) revert InvalidBLSKeyLength();
        if (proofOfPossession.length != 96) revert InvalidBLSKeyLength();

        bool popValid = BLSVerifier.verifyProofOfPossession(blsPublicKey, proofOfPossession);
        if (!popValid) revert InvalidProofOfPossession();

        guardianBLSKeys[vaultId][msg.sender] = GuardianBLSKeyInfo({
            publicKey: blsPublicKey,
            proofOfPossession: proofOfPossession,
            registered: true,
            registeredAt: block.timestamp
        });

        emit GuardianBLSKeyRegistered(vaultId, msg.sender, blsPublicKey);
    }

    /**
     * @notice Fetch registered BLS public key and Proof of Possession for a guardian.
     */
    function getGuardianBLSKey(
        uint256 vaultId,
        address guardian
    ) external view override returns (bytes memory blsPublicKey, bytes memory proofOfPossession, bool isRegistered) {
        GuardianBLSKeyInfo storage info = guardianBLSKeys[vaultId][guardian];
        return (info.publicKey, info.proofOfPossession, info.registered);
    }

    function _processBLSGuardians(
        uint256 requestId,
        uint256 vaultId,
        uint256 documentId,
        address requester,
        address[] calldata guardianAddresses,
        string[] calldata encryptedSharesForBeneficiary
    ) internal {
        uint256 guardianCount = guardianAddresses.length;
        for (uint256 i = 0; i < guardianCount; i++) {
            address guardian = guardianAddresses[i];
            if (i > 0 && guardian <= guardianAddresses[i - 1]) revert DuplicateGuardianBLS();
            if (!isGuardian[vaultId][guardian]) revert OnlyGuardian();
            if (guardian == requester) revert CannotSelfApproveAccess();
            if (!guardianBLSKeys[vaultId][guardian].registered) revert GuardianBLSKeyNotRegistered();

            if (i < encryptedSharesForBeneficiary.length && bytes(encryptedSharesForBeneficiary[i]).length > 0) {
                bytes32 expectedCommitment = guardianShareCommitments[documentId][guardian];
                if (expectedCommitment == bytes32(0) && bytes(encryptedGuardianShares[documentId][guardian]).length > 0) {
                    expectedCommitment = keccak256(bytes(encryptedGuardianShares[documentId][guardian]));
                }
                if (expectedCommitment != bytes32(0)) {
                    bytes32 submittedCommitment = keccak256(bytes(encryptedSharesForBeneficiary[i]));
                    if (submittedCommitment != expectedCommitment) {
                        revert InvalidShareCommitment();
                    }
                    emit ShareValidated(requestId, guardian, submittedCommitment);
                }
                beneficiaryKeyShares[requestId][guardian] = encryptedSharesForBeneficiary[i];
                emit ShareSubmittedForBeneficiary(requestId, guardian, encryptedSharesForBeneficiary[i]);
            }
        }
    }

    /**
     * @notice Approves an access request via off-chain aggregated BLS threshold signature in a single transaction.
     * @dev Replaces O(K) on-chain verification steps with 1 single pairing check, reducing multi-guardian approval
     * gas consumption by >70% for K=10 approvals.
     */
    function approveAccessBLS(
        uint256 requestId,
        address[] calldata guardianAddresses,
        bytes calldata aggregatedSignature,
        bytes calldata aggregatedPublicKey,
        string[] calldata encryptedSharesForBeneficiary
    ) external nonReentrant override {
        AccessRequest storage request = accessRequests[requestId];
        if (request.requestId == 0) revert RequestNotExist();
        if (request.status != RequestStatus.PENDING) revert RequestNotPending();
        if (request.expiresAt <= block.timestamp) revert RequestExpired();

        uint256 vaultId = documents[request.documentId].vaultId;
        uint256 threshold = vaults[vaultId].approvalThreshold;
        uint256 guardianCount = guardianAddresses.length;

        if (guardianCount < threshold) revert ThresholdNotMetBLS();

        // Verify participating guardians validity, strict ascending order, and registered BLS key
        _processBLSGuardians(
            requestId,
            vaultId,
            request.documentId,
            request.requester,
            guardianAddresses,
            encryptedSharesForBeneficiary
        );

        // On-chain BLS Pairing Verification in 1 single pairing check
        BLSVerifier.verifyThresholdApproval(
            requestId,
            vaultId,
            request.documentId,
            request.requester,
            block.chainid,
            aggregatedPublicKey,
            aggregatedSignature,
            guardianCount,
            threshold
        );

        emit BLSAccessApproved(requestId, vaultId, guardianCount, aggregatedSignature);

        if (!_ownsVaultToken(request.requester, vaultId)) {
            request.status = RequestStatus.REJECTED;
            return;
        }

        request.status = RequestStatus.APPROVED;
        _grantAccess(requestId, request.documentId, request.requester);
    }

    /**
     * @dev Revoke access from user for a specific document. If the vault has
     *      opted into cross-chain revocation via `setCrossChainRevocationEnabled`,
     *      also emits a broadcast payload (vaultGID, documentId, targetUser,
     *      nonce) that a relayer can have the calling guardian sign and
     *      forward to the linked Soroban vault via `relay_revoke_access`,
     *      closing the window where a still-cached Stellar-side grant could
     *      be used after this EVM-side revocation. Disabled by default so
     *      single-chain vaults don't pay for broadcast infrastructure they
     *      never use.
     */
    function revokeAccess(uint256 documentId, address user) external nonReentrant {
        if (documents[documentId].id == 0) revert DocumentNotExist();

        uint256 vaultId = documents[documentId].vaultId;
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();

        hasAccess[documentId][user] = false;
        delete userAccessLevel[documentId][user];
        delete _documentAccessVersion[documentId][user];

        emit AccessRevoked(documentId, user);

        if (crossChainRevocationEnabled[vaultId]) {
            uint256 nonce = ++documentRevocationNonce[documentId][user];
            emit CrossChainRevocationBroadcast(vaultGID(vaultId), documentId, user, nonce);
        }
    }

    /// @notice Globally-unique cross-chain identifier for a vault, derived from
    ///         this contract's address and the local vault id. A Soroban vault
    ///         links itself to this id via `link_cross_chain_vault` so relayed
    ///         revocation broadcasts can be routed to the right vault.
    function vaultGID(uint256 vaultId) public view returns (bytes32) {
        return keccak256(abi.encodePacked(address(this), vaultId));
    }

    /// @notice Opt a vault into (or out of) cross-chain revocation broadcasting.
    ///         Only the vault creator may toggle this; leave disabled (the
    ///         default) for vaults with no linked Soroban counterpart so
    ///         `revokeAccess` doesn't pay for broadcast infrastructure they
    ///         never use.
    function setCrossChainRevocationEnabled(uint256 vaultId, bool enabled) external nonReentrant {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (vaults[vaultId].creator != msg.sender) revert OnlyVaultCreator();

        crossChainRevocationEnabled[vaultId] = enabled;
    }

    /**
     * @dev Mint NFT access token for a vault.
     */
    function mintAccessToken(
        uint256 vaultId,
        address to,
        string memory tokenURIValue
    ) external nonReentrant returns (uint256) {
        if (!vaults[vaultId].isActive) revert VaultNotActive();
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();

        _tokenIdCounter += 1;
        uint256 tokenId = _tokenIdCounter;

        tokenVaultMapping[tokenId] = vaultId;
        _safeMint(to, tokenId);
        tokenURIs[tokenId] = tokenURIValue;

        emit NFTMinted(tokenId, to, vaultId);
        return tokenId;
    }

    /**
     * @dev Burn NFT access token. Grant invalidation is handled centrally in
     * _update, which bumps the vault access version whenever the burner's
     * balance for the vault drops to zero.
     */
    function burnAccessToken(uint256 tokenId) external nonReentrant {
        address owner = ownerOf(tokenId);
        if (!_isTokenOwnerOrApproved(owner, msg.sender, tokenId)) {
            revert NotOwnerOrApproved();
        }

        _burn(tokenId);

        delete tokenVaultMapping[tokenId];
        delete tokenURIs[tokenId];

        emit NFTBurned(tokenId);
    }

    /**
     * @dev Get vault details.
     */
    function getVault(uint256 vaultId) external view nonReentrantView returns (
        uint256 id,
        address creator,
        string memory name,
        string memory description,
        address[] memory guardians,
        uint256 approvalThreshold,
        bool isActive,
        uint256 createdAt
    ) {
        Vault storage vault = vaults[vaultId];
        return (
            vault.id,
            vault.creator,
            vault.name,
            vault.description,
            vault.guardians,
            vault.approvalThreshold,
            vault.isActive,
            vault.createdAt
        );
    }

    /**
     * @dev Get user's pending invites.
     */
    function getPendingInvites(address user) external view nonReentrantView returns (GuardianInvite[] memory) {
        uint256[] storage vaultIds = userInviteVaultIds[user];
        uint256 count = 0;

        for (uint256 i = 0; i < vaultIds.length; i++) {
            GuardianInvite storage invite = guardianInvites[user][vaultIds[i]];
            if (!invite.accepted && invite.expiresAt > block.timestamp) {
                count++;
            }
        }

        GuardianInvite[] memory pending = new GuardianInvite[](count);
        uint256 index = 0;

        for (uint256 i = 0; i < vaultIds.length; i++) {
            GuardianInvite storage invite = guardianInvites[user][vaultIds[i]];
            if (!invite.accepted && invite.expiresAt > block.timestamp) {
                pending[index] = invite;
                index++;
            }
        }

        return pending;
    }

    /**
     * @dev Return vault id attached to token id (0 if missing/deleted).
     */
    function getTokenVault(uint256 tokenId) external view nonReentrantView returns (uint256) {
        return tokenVaultMapping[tokenId];
    }

    /**
     * @dev Returns whether user currently holds any token for vault.
     */
    function hasVaultToken(address user, uint256 vaultId) external view nonReentrantView returns (bool) {
        return _ownsVaultToken(user, vaultId);
    }

    /**
     * @dev Returns effective access, tied to both granted access and live vault token ownership.
     */
    function hasActiveAccess(uint256 documentId, address user) external view nonReentrantView returns (bool) {
        if (documents[documentId].id == 0) {
            return false;
        }
        return _hasActiveAccess(documentId, user);
    }

    /**
     * @dev Standardized, non-reverting access check for cross-contract callers.
     *      Encodes the access state of `user` for `documentId` as a status code so
     *      third-party DApps can branch without catching reverts.
     * @return code 0 = document does not exist, 1 = access denied, 2 = access granted.
     */
    function checkAccess(uint256 documentId, address user) external view nonReentrantView returns (uint8) {
        if (documents[documentId].id == 0) {
            return 0; // DOCUMENT_NOT_FOUND
        }
        if (_hasActiveAccess(documentId, user)) {
            return 2; // ACCESS_GRANTED
        }
        return 1; // ACCESS_DENIED
    }

    /**
     * @dev Returns the creator/owner address of `vaultId`.
     */
    function getVaultCreator(uint256 vaultId) external view returns (address) {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        return vaults[vaultId].creator;
    }

    /**
     * @dev Returns the guardian approval threshold for `vaultId`.
     */
    function getApprovalThreshold(uint256 vaultId) external view returns (uint256) {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        return vaults[vaultId].approvalThreshold;
    }

    /**
     * @dev ERC-165 interface detection.
     *      Returns true for the {ISpooVault} interface id in addition to the
     *      standard ERC-165 and ERC-721 identifiers provided by {ERC721}.
     */
    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ISpooVault) returns (bool) {
        return interfaceId == type(ISpooVault).interfaceId || super.supportsInterface(interfaceId);
    }

    /**
     * @dev Total active NFT supply (minted - burned).
     */
    function totalSupply() external view nonReentrantView returns (uint256) {
        return _activeTokenSupply;
    }

    /**
     * @dev Return token URI from storage mapping.
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        ownerOf(tokenId);
        return tokenURIs[tokenId];
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = super._update(to, tokenId, auth);
        uint256 vaultId = tokenVaultMapping[tokenId];

        if (from == address(0)) {
            _activeTokenSupply += 1;
        } else if (vaultId != 0 && _ownedVaultTokenBalance[from][vaultId] > 0) {
            _ownedVaultTokenBalance[from][vaultId] -= 1;
        }

        if (to == address(0)) {
            if (_activeTokenSupply > 0) {
                _activeTokenSupply -= 1;
            }
        } else if (vaultId != 0) {
            _ownedVaultTokenBalance[to][vaultId] += 1;
            if (_vaultAccessVersion[vaultId][to] == 0) {
                _vaultAccessVersion[vaultId][to] = 1;
            }
        }

        // Evaluated after all balance mutations so self-transfers never
        // transiently read a zero balance. When the sender's balance for this
        // vault drops to zero, every prior document grant they hold is
        // invalidated; re-acquiring a pass requires fresh guardian approval.
        if (from != address(0) && vaultId != 0 && _ownedVaultTokenBalance[from][vaultId] == 0) {
            _vaultAccessVersion[vaultId][from] += 1;
        }

        return from;
    }

    function _grantAccess(uint256 requestId, uint256 documentId, address user) internal {
        uint256 vaultId = documents[documentId].vaultId;
        uint256 currentVersion = _currentAccessVersion(vaultId, user);

        hasAccess[documentId][user] = true;
        _documentAccessVersion[documentId][user] = currentVersion;
        userAccessLevel[documentId][user] = documents[documentId].requiredAccess;

        emit AccessGranted(requestId, documentId, user);
    }

    function _hasActiveAccess(uint256 documentId, address user) internal view returns (bool) {
        uint256 vaultId = documents[documentId].vaultId;
        if (isGuardian[vaultId][user]) {
            return true;
        }

        if (!hasAccess[documentId][user]) {
            return false;
        }

        if (!_ownsVaultToken(user, vaultId)) {
            return false;
        }

        return _documentAccessVersion[documentId][user] == _currentAccessVersion(vaultId, user);
    }

    function _currentAccessVersion(uint256 vaultId, address user) internal view returns (uint256) {
        uint256 version = _vaultAccessVersion[vaultId][user];
        return version == 0 ? 1 : version;
    }

    function _isPostDeathUnlocked(uint256 vaultId) internal view returns (bool) {
        VaultReleaseState storage state = _vaultReleaseStates[vaultId];
        if (state.inactivityPeriod == 0) {
            return false;
        }

        bool timestampExpired = block.timestamp >= state.lastProofOfLife + state.inactivityPeriod;
        bool blocksElapsed = block.number >= state.lastProofOfLifeBlock + state.targetBlocks;

        return timestampExpired && blocksElapsed;
    }

    function _isReleaseConditionSatisfied(uint256 documentId) internal view returns (bool) {
        uint256 vaultId = documents[documentId].vaultId;
        ReleaseCondition condition = documentReleaseCondition[documentId];

        if (condition == ReleaseCondition.ANYTIME) {
            return true;
        }

        bool postDeathUnlocked = _isPostDeathUnlocked(vaultId);

        if (condition == ReleaseCondition.LIVE_ONLY) {
            return !postDeathUnlocked;
        }

        if (condition == ReleaseCondition.EMERGENCY_ONLY) {
            if (postDeathUnlocked) {
                // The post-death track is independent of emergency jitter.
                return true;
            }
            if (!_vaultReleaseStates[vaultId].emergencyMode) {
                return false;
            }

            uint256 scheduledAt = emergencyUnlockAt[vaultId];
            if (vrfRequestIdByVault[vaultId] != 0) {
                // VRF-gated vault: releasable only at the verifiably
                // scheduled time (pending requests stay locked).
                return block.timestamp >= scheduledAt && scheduledAt != 0;
            }

            // Legacy behavior for deployments without VRF configured.
            return true;
        }

        if (condition == ReleaseCondition.POST_DEATH_ONLY) {
            return postDeathUnlocked;
        }

        return false;
    }

    function _ownsVaultToken(address user, uint256 vaultId) internal view returns (bool) {
        return _ownedVaultTokenBalance[user][vaultId] > 0;
    }

    function _isTokenOwnerOrApproved(address owner, address spender, uint256 tokenId) internal view returns (bool) {
        return (
            spender == owner ||
            getApproved(tokenId) == spender ||
            isApprovedForAll(owner, spender)
        );
    }
}
