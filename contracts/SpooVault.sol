// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ISpooVault.sol";

/**
 * @title SpooVault
 * @dev NFT-powered multi-signature encrypted document vault.
 *      Implements {ISpooVault} so third-party DApps can discover and query
 *      document access delegations through a standardized, ERC-165 discoverable
 *      interface.
 */
contract SpooVault is ERC721, ISpooVault, ReentrancyGuard {
    uint256 private _tokenIdCounter;
    uint256 private _vaultIdCounter;
    uint256 private _documentIdCounter;
    uint256 private _requestIdCounter;

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
    error ReshareSessionAlreadyActive();
    error ReshareSessionNotActive();
    error ReshareDeadlineNotReached();
    error ReshareDeadlineExceeded();
    error ReshareIncomplete();
    error InvalidZeroShareCommitment();
    error ZeroShareAlreadySubmitted();
    error InvalidShareRefreshInput();
    error InvalidReshareDuration();

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

    // Access versions let us invalidate all prior document grants for a user+vault in O(1).
    mapping(uint256 => mapping(address => uint256)) private _vaultAccessVersion;
    mapping(uint256 => mapping(address => uint256)) private _documentAccessVersion;
    mapping(uint256 => VaultReleaseState) private _vaultReleaseStates;

    // Guardian rotation and threshold adjustment governance
    mapping(uint256 => mapping(address => GuardianRemovalProposal)) public guardianRemovalProposals;
    mapping(uint256 => mapping(uint256 => ThresholdUpdateProposal)) public thresholdUpdateProposals;
    mapping(uint256 => mapping(address => mapping(address => bool))) public hasApprovedRemoval;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public hasApprovedThreshold;

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
    event VaultReleaseConfigured(uint256 indexed vaultId, uint256 inactivityPeriod);
    event ProofOfLifeRecorded(uint256 indexed vaultId, address indexed owner, uint256 timestamp);
    event EmergencyModeUpdated(uint256 indexed vaultId, bool enabled);
    event DocumentReleaseConditionSet(uint256 indexed documentId, ReleaseCondition condition);
    event PublicKeyRegistered(address indexed user, string publicKey);
    event GuardianSharesSaved(uint256 indexed documentId);
    event ShareSubmittedForBeneficiary(uint256 indexed requestId, address indexed guardian, string encryptedShare);
    event GuardianRemovalProposed(uint256 indexed vaultId, address indexed guardian, address indexed proposedBy);
    event GuardianRemovalApproved(uint256 indexed vaultId, address indexed guardian, address indexed approver);
    event ThresholdUpdateProposed(uint256 indexed vaultId, uint256 newThreshold, address indexed proposedBy);
    event ThresholdUpdateApproved(uint256 indexed vaultId, uint256 newThreshold, address indexed approver);
    event VaultReconfigurationExecuted(uint256 indexed vaultId, address indexed guardianRemoved, uint256 newThreshold);
    event ShareRefreshStarted(uint256 indexed documentId, uint256 indexed epoch, uint256 deadline);
    event ZeroShareCommitmentSubmitted(uint256 indexed documentId, uint256 indexed epoch, address indexed guardian, uint256 degree);
    event SharesRefreshed(uint256 indexed documentId, uint256 indexed epoch);

    /// @notice Registers the caller's ECIES/X25519 encryption public key.
    /// @param publicKey The public key string to store for `msg.sender`.
    function registerPublicKey(string calldata publicKey) external {
        userPublicKeys[msg.sender] = publicKey;
        emit PublicKeyRegistered(msg.sender, publicKey);
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

    constructor() ERC721("SpooVault Access Token", "SPVT") {}

    /**
     * @dev Create a new vault with guardian invites.
     * msg.sender becomes the first active guardian.
     */
    function createVault(
        string memory name,
        string memory description,
        address[] memory guardians,
        uint256 approvalThreshold
    ) external nonReentrant returns (uint256) {
        uint256 externalGuardianCount = 0;

        for (uint256 i = 0; i < guardians.length; i++) {
            address guardian = guardians[i];
            if (guardian == address(0)) revert ZeroAddressGuardian();

            for (uint256 j = 0; j < i; j++) {
                if (guardians[j] == guardian) revert DuplicateGuardian();
            }

            if (guardian != msg.sender) {
                externalGuardianCount++;
            }
        }

        if (externalGuardianCount == 0) revert AtLeastOneGuardian();

        uint256 totalGuardianCount = externalGuardianCount + 1;
        if (approvalThreshold == 0 || approvalThreshold > totalGuardianCount) {
            revert InvalidApprovalThreshold();
        }

        _vaultIdCounter += 1;
        uint256 vaultId = _vaultIdCounter;

        Vault storage newVault = vaults[vaultId];
        newVault.id = vaultId;
        newVault.creator = msg.sender;
        newVault.name = name;
        newVault.description = description;
        newVault.approvalThreshold = approvalThreshold;
        newVault.isActive = true;
        newVault.createdAt = block.timestamp;

        _vaultReleaseStates[vaultId] = VaultReleaseState({
            emergencyMode: false,
            inactivityPeriod: 30 days,
            lastProofOfLife: block.timestamp
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
                vaultId: vaultId,
                accepted: false,
                expiresAt: block.timestamp + 7 days
            });

        }

        emit VaultCreated(vaultId, msg.sender, name);
        return vaultId;
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
    ) external returns (uint256) {
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
     */
    function configureVaultRelease(uint256 vaultId, uint256 inactivityPeriod) external nonReentrant {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (vaults[vaultId].creator != msg.sender) revert OnlyVaultCreator();
        if (!vaults[vaultId].isActive) revert VaultNotActive();
        if (inactivityPeriod < 1 days || inactivityPeriod > 365 days) {
            revert InvalidInactivityPeriod();
        }

        _vaultReleaseStates[vaultId].lastProofOfLife = block.timestamp;
        _vaultReleaseStates[vaultId].inactivityPeriod = inactivityPeriod;
        emit VaultReleaseConfigured(vaultId, inactivityPeriod);
    }

    /**
     * @dev Owner heartbeat to keep vault in live mode.
     */
    function proveLife(uint256 vaultId) external nonReentrant {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (vaults[vaultId].creator != msg.sender) revert OnlyVaultCreator();
        if (!vaults[vaultId].isActive) revert VaultNotActive();

        _vaultReleaseStates[vaultId].lastProofOfLife = block.timestamp;
        emit ProofOfLifeRecorded(vaultId, msg.sender, block.timestamp);
    }

    /**
     * @dev Owner can toggle emergency mode for rapid release workflows.
     */
    function setEmergencyMode(uint256 vaultId, bool enabled) external nonReentrant {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (vaults[vaultId].creator != msg.sender) revert OnlyVaultCreator();
        if (!vaults[vaultId].isActive) revert VaultNotActive();

        _vaultReleaseStates[vaultId].emergencyMode = enabled;
        emit EmergencyModeUpdated(vaultId, enabled);
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
    function getVaultReleaseState(uint256 vaultId) external view returns (
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

            vault.approvalThreshold = newThreshold;
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
        }

        if (session.submittedCount < vaultGuardians.length) {
            if (block.timestamp <= session.deadline) revert ReshareDeadlineNotReached();
            revert ReshareIncomplete();
        }

        session.active = false;
        uint256 newEpoch = shareEpoch[documentId] + 1;
        shareEpoch[documentId] = newEpoch;

        emit SharesRefreshed(documentId, newEpoch);
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
            id: documentId,
            vaultId: vaultId,
            encryptedMetadata: encryptedMetadata,
            ipfsHash: ipfsHash,
            uploadedBy: msg.sender,
            uploadedAt: block.timestamp,
            requiredAccess: requiredAccess
        });

        documentReleaseCondition[documentId] = releaseCondition;
        _grantAccess(0, documentId, msg.sender);

        for (uint256 i = 0; i < guardiansList.length; i++) {
            encryptedGuardianShares[documentId][guardiansList[i]] = shares[i];
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

    function _approveAccess(uint256 requestId, string memory encryptedShareForBeneficiary) internal {
        AccessRequest storage request = accessRequests[requestId];
        if (request.requestId == 0) revert RequestNotExist();
        if (request.status != RequestStatus.PENDING) revert RequestNotPending();
        if (request.expiresAt <= block.timestamp) revert RequestExpired();
        if (request.requester == msg.sender) revert CannotSelfApproveAccess();

        uint256 vaultId = documents[request.documentId].vaultId;
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();
        if (hasApprovedRequest[requestId][msg.sender]) revert AlreadyApproved();

        hasApprovedRequest[requestId][msg.sender] = true;
        request.approvedBy.push(msg.sender);

        if (bytes(encryptedShareForBeneficiary).length > 0) {
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
     * @dev Revoke access from user for a specific document.
     */
    function revokeAccess(uint256 documentId, address user) external nonReentrant {
        if (documents[documentId].id == 0) revert DocumentNotExist();

        uint256 vaultId = documents[documentId].vaultId;
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();

        hasAccess[documentId][user] = false;
        delete userAccessLevel[documentId][user];
        delete _documentAccessVersion[documentId][user];

        emit AccessRevoked(documentId, user);
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
    function getVault(uint256 vaultId) external view returns (
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
    function getPendingInvites(address user) external view returns (GuardianInvite[] memory) {
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
    function getTokenVault(uint256 tokenId) external view returns (uint256) {
        return tokenVaultMapping[tokenId];
    }

    /**
     * @dev Returns whether user currently holds any token for vault.
     */
    function hasVaultToken(address user, uint256 vaultId) external view returns (bool) {
        return _ownsVaultToken(user, vaultId);
    }

    /**
     * @dev Returns effective access, tied to both granted access and live vault token ownership.
     */
    function hasActiveAccess(uint256 documentId, address user) external view returns (bool) {
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
    function checkAccess(uint256 documentId, address user) external view returns (uint8) {
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
    function totalSupply() external view returns (uint256) {
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
        return block.timestamp >= state.lastProofOfLife + state.inactivityPeriod;
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
            return _vaultReleaseStates[vaultId].emergencyMode || postDeathUnlocked;
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
