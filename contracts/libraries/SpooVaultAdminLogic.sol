// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/Strings.sol";

/// @dev Linked library for guardian rotation and PSS share refresh.
/// External functions are DELEGATECALL'd from SpooVault to stay under EIP-170.
/// Proposal, invite, and reshare windows use wall-clock expiry the same way
/// the original SpooVault entry points did; miners cannot rewrite executed
/// state with timestamp drift alone.
// slither-disable-start timestamp
library SpooVaultAdminLogic {
    // Packed to match SpooVault storage layout on main: creator+id+isActive
    // share slot 0; approvalThreshold+createdAt pack together. Dynamic fields
    // keep their own slots. External getVault still widens to uint256.
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

    struct GuardianRemovalProposal {
        uint256 vaultId;
        address guardianToRemove;
        address proposedBy;
        address[] approvedBy;
        bool executed;
        bool vetoed;
        uint256 createdAt;
        uint256 expiresAt;
        uint256 queuedAt;
    }

    struct ThresholdUpdateProposal {
        uint256 vaultId;
        uint256 newThreshold;
        address proposedBy;
        address[] approvedBy;
        bool executed;
        bool vetoed;
        uint256 createdAt;
        uint256 expiresAt;
        uint256 queuedAt;
    }

    struct ReshareSession {
        uint256 startedAt;
        uint256 deadline;
        uint256 submittedCount;
        bool active;
    }

    struct GuardianInvite {
        address guardian;
        uint64 vaultId;
        bool accepted;
        uint40 expiresAt;
    }

    uint256 public constant TIMELOCK_DELAY = 24 hours;

    error VaultNotExist();
    error OnlyGuardian();
    error OnlyVaultCreator();
    error GuardianNotExists();
    error CannotRemoveOnlyGuardian();
    error ProposalNotExist();
    error ProposalExpired();
    error ProposalAlreadyExecuted();
    error ProposalNotQueued();
    error ProposalAlreadyQueued();
    error TimelockNotElapsed();
    error ProposalVetoed();
    error ApprovalAlreadyGiven();
    error InvalidNewThreshold();
    error InsufficientApprovalsForExecution();
    error DocumentNotExist();
    error ReshareSessionAlreadyActive();
    error InvalidReshareDuration();
    error ReshareSessionNotActive();
    error ReshareDeadlineExceeded();
    error ZeroShareAlreadySubmitted();
    error InvalidZeroShareCommitment();
    error InvalidShareRefreshInput();
    error ReshareDeadlineNotReached();
    error ReshareIncomplete();

    event GuardianRemovalProposed(uint256 indexed vaultId, address indexed guardianToRemove, address indexed proposedBy);
    event GuardianRemovalApproved(uint256 indexed vaultId, address indexed guardianToRemove, address indexed approver);
    event ThresholdUpdateProposed(uint256 indexed vaultId, uint256 newThreshold, address indexed proposedBy);
    event ThresholdUpdateApproved(uint256 indexed vaultId, uint256 newThreshold, address indexed approver);
    event VaultReconfigurationQueued(uint256 indexed vaultId, address indexed guardianRemoved, uint256 newThreshold, uint256 eta);
    event VaultReconfigurationCanceled(uint256 indexed vaultId, address indexed guardianRemoved, uint256 newThreshold, address indexed canceledBy);
    event VaultReconfigurationExecuted(uint256 indexed vaultId, address indexed guardianRemoved, uint256 newThreshold);
    event GuardianRemoved(uint256 indexed vaultId, address indexed guardian);
    event ShareRefreshStarted(uint256 indexed documentId, uint256 indexed epoch, uint256 deadline);
    event ZeroShareCommitmentSubmitted(uint256 indexed documentId, uint256 indexed epoch, address indexed guardian, uint256 degree);
    event SharesRefreshed(uint256 indexed documentId, uint256 indexed epoch);

    function requiredQuorumApprovals(uint256 guardianCount) internal pure returns (uint256) {
        return ((guardianCount + 1) / 2) + 1;
    }

    function proposeGuardianRemoval(
        mapping(uint256 => Vault) storage vaults,
        mapping(uint256 => mapping(address => bool)) storage isGuardian,
        mapping(uint256 => mapping(address => GuardianRemovalProposal)) storage proposals,
        uint256 vaultId,
        address guardianToRemove
    ) external {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();
        if (!isGuardian[vaultId][guardianToRemove]) revert GuardianNotExists();
        if (vaults[vaultId].guardians.length <= 1) revert CannotRemoveOnlyGuardian();

        GuardianRemovalProposal storage proposal = proposals[vaultId][guardianToRemove];
        if (proposal.createdAt != 0 && proposal.expiresAt > block.timestamp && !proposal.executed && !proposal.vetoed) {
            revert ProposalNotExist();
        }

        uint256 expiresAt = block.timestamp + 7 days;
        proposals[vaultId][guardianToRemove] = GuardianRemovalProposal({
            vaultId: vaultId,
            guardianToRemove: guardianToRemove,
            proposedBy: msg.sender,
            approvedBy: new address[](0),
            executed: false,
            vetoed: false,
            createdAt: block.timestamp,
            expiresAt: expiresAt,
            queuedAt: 0
        });

        emit GuardianRemovalProposed(vaultId, guardianToRemove, msg.sender);
    }

    function approveGuardianRemoval(
        mapping(uint256 => Vault) storage vaults,
        mapping(uint256 => mapping(address => bool)) storage isGuardian,
        mapping(uint256 => mapping(address => GuardianRemovalProposal)) storage proposals,
        mapping(uint256 => mapping(address => mapping(address => bool))) storage hasApprovedRemoval,
        uint256 vaultId,
        address guardianToRemove
    ) external {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();

        GuardianRemovalProposal storage proposal = proposals[vaultId][guardianToRemove];
        if (proposal.createdAt == 0) revert ProposalNotExist();
        if (proposal.expiresAt <= block.timestamp) revert ProposalExpired();
        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (proposal.vetoed) revert ProposalVetoed();
        if (hasApprovedRemoval[vaultId][guardianToRemove][msg.sender]) revert ApprovalAlreadyGiven();

        hasApprovedRemoval[vaultId][guardianToRemove][msg.sender] = true;
        proposal.approvedBy.push(msg.sender);

        emit GuardianRemovalApproved(vaultId, guardianToRemove, msg.sender);
    }

    function proposeThresholdUpdate(
        mapping(uint256 => Vault) storage vaults,
        mapping(uint256 => mapping(address => bool)) storage isGuardian,
        mapping(uint256 => mapping(uint256 => ThresholdUpdateProposal)) storage proposals,
        uint256 vaultId,
        uint256 newThreshold
    ) external {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();
        if (newThreshold == 0 || newThreshold > vaults[vaultId].guardians.length) {
            revert InvalidNewThreshold();
        }

        ThresholdUpdateProposal storage proposal = proposals[vaultId][newThreshold];
        if (proposal.createdAt != 0 && proposal.expiresAt > block.timestamp && !proposal.executed && !proposal.vetoed) {
            revert ProposalNotExist();
        }

        uint256 expiresAt = block.timestamp + 7 days;
        proposals[vaultId][newThreshold] = ThresholdUpdateProposal({
            vaultId: vaultId,
            newThreshold: newThreshold,
            proposedBy: msg.sender,
            approvedBy: new address[](0),
            executed: false,
            vetoed: false,
            createdAt: block.timestamp,
            expiresAt: expiresAt,
            queuedAt: 0
        });

        emit ThresholdUpdateProposed(vaultId, newThreshold, msg.sender);
    }

    function approveThresholdUpdate(
        mapping(uint256 => Vault) storage vaults,
        mapping(uint256 => mapping(address => bool)) storage isGuardian,
        mapping(uint256 => mapping(uint256 => ThresholdUpdateProposal)) storage proposals,
        mapping(uint256 => mapping(uint256 => mapping(address => bool))) storage hasApprovedThreshold,
        uint256 vaultId,
        uint256 newThreshold
    ) external {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();

        ThresholdUpdateProposal storage proposal = proposals[vaultId][newThreshold];
        if (proposal.createdAt == 0) revert ProposalNotExist();
        if (proposal.expiresAt <= block.timestamp) revert ProposalExpired();
        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (proposal.vetoed) revert ProposalVetoed();
        if (hasApprovedThreshold[vaultId][newThreshold][msg.sender]) revert ApprovalAlreadyGiven();

        hasApprovedThreshold[vaultId][newThreshold][msg.sender] = true;
        proposal.approvedBy.push(msg.sender);

        emit ThresholdUpdateApproved(vaultId, newThreshold, msg.sender);
    }

    function queueVaultReconfiguration(
        mapping(uint256 => Vault) storage vaults,
        mapping(uint256 => mapping(address => bool)) storage isGuardian,
        mapping(uint256 => mapping(address => GuardianRemovalProposal)) storage removalProposals,
        mapping(uint256 => mapping(uint256 => ThresholdUpdateProposal)) storage thresholdProposals,
        uint256 vaultId,
        address guardianToRemove,
        uint256 newThreshold
    ) external {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();

        Vault storage vault = vaults[vaultId];
        uint256 currentGuardianCount = vault.guardians.length;
        uint256 requiredApprovals = requiredQuorumApprovals(currentGuardianCount);

        GuardianRemovalProposal storage removalProposal = removalProposals[vaultId][guardianToRemove];
        ThresholdUpdateProposal storage thresholdProposal = thresholdProposals[vaultId][newThreshold];

        bool hasRemovalProposal = removalProposal.createdAt != 0 && !removalProposal.executed && removalProposal.expiresAt > block.timestamp;
        bool hasThresholdProposal = thresholdProposal.createdAt != 0 && !thresholdProposal.executed && thresholdProposal.expiresAt > block.timestamp;

        if (!hasRemovalProposal && !hasThresholdProposal) {
            revert ProposalNotExist();
        }

        if (hasRemovalProposal) {
            if (removalProposal.vetoed) revert ProposalVetoed();
            if (removalProposal.queuedAt != 0) revert ProposalAlreadyQueued();
            if (removalProposal.approvedBy.length < requiredApprovals) {
                revert InsufficientApprovalsForExecution();
            }
            removalProposal.queuedAt = block.timestamp;
        }

        if (hasThresholdProposal) {
            if (thresholdProposal.vetoed) revert ProposalVetoed();
            if (thresholdProposal.queuedAt != 0) revert ProposalAlreadyQueued();
            if (thresholdProposal.approvedBy.length < requiredApprovals) {
                revert InsufficientApprovalsForExecution();
            }
            thresholdProposal.queuedAt = block.timestamp;
        }

        emit VaultReconfigurationQueued(vaultId, guardianToRemove, newThreshold, block.timestamp + TIMELOCK_DELAY);
    }

    function cancelVaultReconfiguration(
        mapping(uint256 => Vault) storage vaults,
        mapping(uint256 => mapping(address => GuardianRemovalProposal)) storage removalProposals,
        mapping(uint256 => mapping(uint256 => ThresholdUpdateProposal)) storage thresholdProposals,
        uint256 vaultId,
        address guardianToRemove,
        uint256 newThreshold
    ) external {
        if (vaults[vaultId].id == 0) revert VaultNotExist();
        if (vaults[vaultId].creator != msg.sender) revert OnlyVaultCreator();

        GuardianRemovalProposal storage removalProposal = removalProposals[vaultId][guardianToRemove];
        ThresholdUpdateProposal storage thresholdProposal = thresholdProposals[vaultId][newThreshold];

        bool hasRemovalProposal = removalProposal.createdAt != 0 && !removalProposal.executed;
        bool hasThresholdProposal = thresholdProposal.createdAt != 0 && !thresholdProposal.executed;

        if (!hasRemovalProposal && !hasThresholdProposal) {
            revert ProposalNotExist();
        }

        if (hasRemovalProposal) {
            removalProposal.vetoed = true;
        }

        if (hasThresholdProposal) {
            thresholdProposal.vetoed = true;
        }

        emit VaultReconfigurationCanceled(vaultId, guardianToRemove, newThreshold, msg.sender);
    }

    function executeVaultReconfiguration(
        mapping(uint256 => Vault) storage vaults,
        mapping(uint256 => mapping(address => bool)) storage isGuardian,
        mapping(uint256 => mapping(address => GuardianRemovalProposal)) storage removalProposals,
        mapping(uint256 => mapping(uint256 => ThresholdUpdateProposal)) storage thresholdProposals,
        uint256 vaultId,
        address guardianToRemove,
        uint256 newThreshold
    ) external {
        if (vaults[vaultId].id == 0) revert VaultNotExist();

        Vault storage vault = vaults[vaultId];
        uint256 currentGuardianCount = vault.guardians.length;
        uint256 requiredApprovals = requiredQuorumApprovals(currentGuardianCount);

        GuardianRemovalProposal storage removalProposal = removalProposals[vaultId][guardianToRemove];
        ThresholdUpdateProposal storage thresholdProposal = thresholdProposals[vaultId][newThreshold];

        bool hasRemovalProposal = removalProposal.createdAt != 0 && !removalProposal.executed && removalProposal.expiresAt > block.timestamp;
        bool hasThresholdProposal = thresholdProposal.createdAt != 0 && !thresholdProposal.executed && thresholdProposal.expiresAt > block.timestamp;

        if (!hasRemovalProposal && !hasThresholdProposal) {
            revert ProposalNotExist();
        }

        if (hasRemovalProposal) {
            if (removalProposal.vetoed) revert ProposalVetoed();
            if (removalProposal.queuedAt == 0) revert ProposalNotQueued();
            if (block.timestamp < removalProposal.queuedAt + TIMELOCK_DELAY) {
                revert TimelockNotElapsed();
            }
            if (removalProposal.approvedBy.length < requiredApprovals) {
                revert InsufficientApprovalsForExecution();
            }

            _removeGuardian(vaults, isGuardian, vaultId, guardianToRemove);
            removalProposal.executed = true;

            currentGuardianCount--;
        }

        if (hasThresholdProposal) {
            if (thresholdProposal.vetoed) revert ProposalVetoed();
            if (thresholdProposal.queuedAt == 0) revert ProposalNotQueued();
            if (block.timestamp < thresholdProposal.queuedAt + TIMELOCK_DELAY) {
                revert TimelockNotElapsed();
            }
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

    function startShareRefresh(
        uint256 documentExistsId,
        uint256 vaultId,
        uint256 duration,
        uint256 documentId,
        mapping(uint256 => mapping(address => bool)) storage isGuardian,
        mapping(uint256 => ReshareSession) storage sessions,
        mapping(uint256 => uint256) storage shareEpoch
    ) external {
        if (documentExistsId == 0) revert DocumentNotExist();
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();
        if (sessions[documentId].active) revert ReshareSessionAlreadyActive();
        if (duration < 1 hours || duration > 7 days) revert InvalidReshareDuration();

        uint256 nextEpoch = shareEpoch[documentId] + 1;
        ReshareSession storage session = sessions[documentId];
        session.startedAt = block.timestamp;
        session.deadline = block.timestamp + duration;
        session.submittedCount = 0;
        session.active = true;

        emit ShareRefreshStarted(documentId, nextEpoch, session.deadline);
    }

    function submitZeroShareCommitment(
        uint256 documentExistsId,
        uint256 vaultId,
        uint256 documentId,
        bytes32[] calldata commitments,
        mapping(uint256 => mapping(address => bool)) storage isGuardian,
        mapping(uint256 => ReshareSession) storage sessions,
        mapping(uint256 => uint256) storage shareEpoch,
        mapping(uint256 => mapping(uint256 => mapping(address => bytes32[]))) storage zeroShareCommitments,
        mapping(uint256 => mapping(uint256 => mapping(address => bool))) storage zeroShareSubmitted
    ) external {
        if (documentExistsId == 0) revert DocumentNotExist();
        ReshareSession storage session = sessions[documentId];
        if (!session.active) revert ReshareSessionNotActive();
        if (block.timestamp > session.deadline) revert ReshareDeadlineExceeded();
        if (!isGuardian[vaultId][msg.sender]) revert OnlyGuardian();

        uint256 epoch = shareEpoch[documentId] + 1;
        if (zeroShareSubmitted[documentId][epoch][msg.sender]) {
            revert ZeroShareAlreadySubmitted();
        }
        if (commitments.length < 2 || commitments[0] != bytes32(0)) {
            revert InvalidZeroShareCommitment();
        }

        zeroShareSubmitted[documentId][epoch][msg.sender] = true;
        zeroShareCommitments[documentId][epoch][msg.sender] = commitments;
        session.submittedCount += 1;

        emit ZeroShareCommitmentSubmitted(documentId, epoch, msg.sender, commitments.length - 1);
    }

    function applyShareRefresh(
        uint256 documentExistsId,
        uint256 vaultId,
        uint256 documentId,
        address[] calldata guardiansList,
        string[] calldata newShares,
        mapping(uint256 => Vault) storage vaults,
        mapping(uint256 => mapping(address => bool)) storage isGuardian,
        mapping(uint256 => mapping(address => string)) storage encryptedGuardianShares,
        mapping(uint256 => ReshareSession) storage sessions,
        mapping(uint256 => uint256) storage shareEpoch
    ) external {
        if (documentExistsId == 0) revert DocumentNotExist();
        ReshareSession storage session = sessions[documentId];
        if (!session.active) revert ReshareSessionNotActive();
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

    function _removeGuardian(
        mapping(uint256 => Vault) storage vaults,
        mapping(uint256 => mapping(address => bool)) storage isGuardian,
        uint256 vaultId,
        address guardianToRemove
    ) private {
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

    function vaultGidString(uint256 vaultId) external view returns (string memory) {
        return string.concat(
            Strings.toString(block.chainid),
            ":",
            Strings.toHexString(address(this)),
            ":",
            Strings.toString(vaultId)
        );
    }

    function pendingInvites(
        address user,
        mapping(address => uint256[]) storage userInviteVaultIds,
        mapping(address => mapping(uint256 => GuardianInvite)) storage guardianInvites
    ) external view returns (GuardianInvite[] memory) {
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
}
// slither-disable-end timestamp
