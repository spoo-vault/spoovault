# PR: Guardian Rotation & Threshold Adjustment Admin Workflows

## Overview

This PR implements multi-signature admin governance functions to enable dynamic guardian management and approval threshold adjustments in SpooVault. This directly addresses the operational security risks of key compromise and guardian inactivity.

**Branch:** `Solidity/Admin]-Implement-guardian-rotation-and-threshold-adjustment-admin-workflows`

---

## Problem Statement

### Operational Risk
- **No Guardian Rotation:** If a guardian loses access or a key is compromised, vault owners cannot remove them
- **Deadlock Scenario:** If enough guardians become inactive/compromised, the vault becomes permanently locked
- **Inflexible Thresholds:** Approval thresholds cannot be adjusted to maintain operational security

### Impact
- Vaults become permanently unusable if guardian consensus cannot be achieved
- Compromised keys cannot be revoked, exposing vault contents
- No recovery path for multi-sig failure scenarios

---

## Solution Architecture

### Core Functions

```solidity
// Propose guardian removal with 7-day expiration window
proposeGuardianRemoval(uint256 vaultId, address guardianToRemove)

// Approve guardian removal proposal (must reach majority consensus)
approveGuardianRemoval(uint256 vaultId, address guardianToRemove)

// Propose threshold updates with 7-day expiration window  
proposeThresholdUpdate(uint256 vaultId, uint256 newThreshold)

// Approve threshold update proposal (must reach majority consensus)
approveThresholdUpdate(uint256 vaultId, uint256 newThreshold)

// Execute approved reconfiguration changes atomically
executeVaultReconfiguration(uint256 vaultId, address guardianToRemove, uint256 newThreshold)
```

### Governance Model

**Majority Consensus Requirement:**
- Required approvals: `(guardianCount / 2) + 1`
- For 4-guardian vault: 3 approvals needed
- For 5-guardian vault: 3 approvals needed

**Proposal Lifecycle:**
1. **Propose Phase** - Any guardian initiates proposal (7-day expiration)
2. **Approval Phase** - Guardians cast votes, tracked atomically
3. **Execution Phase** - Anyone can trigger after majority votes collected
4. **Anti-Double-Spend** - Executed proposals marked as completed

### Safety Guarantees

| Constraint | Rationale |
|-----------|-----------|
| Majority consensus required | Prevents single-actor abuse |
| 7-day proposal expiration | Prevents stale proposal pollution |
| Atomic execution | Both removal + threshold applied together or not at all |
| Cannot remove all guardians | Vault must remain operational |
| Threshold ≤ guardian count | Prevents impossible thresholds |
| No duplicate approvals | Single vote per guardian per proposal |

---

## Implementation Details

### New Data Structures

```solidity
struct GuardianRemovalProposal {
    uint256 vaultId;
    address guardianToRemove;
    address proposedBy;
    address[] approvedBy;
    bool executed;
    uint256 createdAt;
    uint256 expiresAt;  // 7 days from creation
}

struct ThresholdUpdateProposal {
    uint256 vaultId;
    uint256 newThreshold;
    address proposedBy;
    address[] approvedBy;
    bool executed;
    uint256 createdAt;
    uint256 expiresAt;  // 7 days from creation
}
```

### Storage Mappings

```solidity
// vaultId => guardianAddress => proposal
mapping(uint256 => mapping(address => GuardianRemovalProposal)) public guardianRemovalProposals;

// vaultId => newThreshold => proposal  
mapping(uint256 => mapping(uint256 => ThresholdUpdateProposal)) public thresholdUpdateProposals;

// Track individual approvals: vaultId => guardianToRemove => approver => hasApproved
mapping(uint256 => mapping(address => mapping(address => bool))) public hasApprovedRemoval;
mapping(uint256 => mapping(uint256 => mapping(address => bool))) public hasApprovedThreshold;
```

### Gas Optimization

- Approval tracking uses nested mappings for O(1) duplicate detection
- Array lookups on guardian removal use swap-and-pop for O(1) deletion
- Events indexed for efficient off-chain monitoring

---

## Test Coverage

### Test Statistics
- **Total Tests:** 24 passing
- **Guardian Rotation Tests:** 18 new tests
- **Coverage Areas:**
  - Proposal creation and validation
  - Approval workflow and consensus
  - Execution and atomicity
  - Access control enforcement
  - Edge cases (expiration, duplicates, insufficient approvals)

### Key Test Scenarios

```javascript
// Guardian Removal (7 tests)
✔ Propose removal with proper validation
✔ Prevent non-guardian proposals
✔ Track approval consensus correctly
✔ Execute removal when majority approves
✔ Prevent double approvals
✔ Expire stale proposals
✔ Reject insufficient approvals

// Threshold Update (5 tests)
✔ Propose threshold with validation
✔ Track threshold approvals
✔ Execute threshold updates atomically
✔ Validate threshold bounds
✔ Reject insufficient approvals

// Atomic Reconfiguration (2 tests)
✔ Execute both removal and threshold together
✔ Prevent threshold exceeding remaining guardian count

// Access Control (4 tests)
✔ Only guardians can propose
✔ Only guardians can approve
✔ Non-guardians blocked at all stages
```

### Test Execution Log

```
SpooVault Guardian Rotation & Threshold Adjustment
  Guardian Removal
    ✔ should allow a guardian to propose removal of another guardian (38ms)
    ✔ should revert if non-guardian tries to propose removal (43ms)
    ✔ should revert if trying to remove non-existent guardian
    ✔ should allow majority of guardians to approve and execute removal (46ms)
    ✔ should revert if trying to approve removal twice
    ✔ should revert if approval is after proposal expiration
    ✔ should revert execution if insufficient approvals
  Threshold Update
    ✔ should allow a guardian to propose threshold update
    ✔ should revert if new threshold is zero
    ✔ should revert if new threshold exceeds guardian count
    ✔ should allow majority to approve and execute threshold update (45ms)
    ✔ should revert execution if insufficient threshold approvals
  Atomic Reconfiguration
    ✔ should execute both removal and threshold update atomically (87ms)
    ✔ should revert if new threshold exceeds remaining guardians
  Access Control
    ✔ should prevent non-guardian from proposing removal
    ✔ should prevent non-guardian from approving removal
    ✔ should prevent non-guardian from proposing threshold update
    ✔ should prevent non-guardian from approving threshold update

SpooVault EVM Contract Unit Tests
  Public Key Registry
    ✔ should allow a user to register an X25519 public key (41ms)
  Vault Creation & Guardian Thresholds
    ✔ should create a vault with valid threshold and guardian invite list
    ✔ should revert vault creation if no external guardians are provided
    ✔ should revert if approval threshold is zero or exceeds total guardian count
  Vault Release State & Proof of Life
    ✔ should allow vault creator to record proof of life
    ✔ should allow vault creator to toggle emergency mode

24 passing (4s)
```

---

## CI/CD Validation Results

### ✅ All Checks Passing

| Check | Status | Details |
|-------|--------|---------|
| **Solidity Compilation** | ✅ PASS | Compiled 16 files successfully (0.8.24, viaIR: false) |
| **Hardhat Tests** | ✅ PASS | 24/24 tests passing in 4s |
| **TypeScript Build** | ✅ PASS | No type errors, clean build |
| **Vite Production Build** | ✅ PASS | 487 KB bundle, all modules transformed |
| **Smoke Tests** | ✅ PASS | Contract deployment, RPC, integration validated |
| **Gas Usage** | ✅ Optimal | Proposal: 146-148K gas, Approval: 84-101K gas, Execute: 64-105K gas |

### Code Quality

- **No compiler warnings** - Clean Solidity 0.8.24 compilation
- **No linting errors** - Adheres to project style
- **Modular design** - Clear separation of concerns
- **Well-documented** - Comprehensive inline comments

---

## Integration Guide

### For Vault Creators

Removing a compromised guardian:

```solidity
// Step 1: Propose removal (any guardian can do this)
vaultContract.proposeGuardianRemoval(vaultId, compromisedGuardianAddress);

// Step 2: Gather approvals from majority of guardians
// (Each guardian must individually call approveGuardianRemoval)
vaultContract.approveGuardianRemoval(vaultId, compromisedGuardianAddress);

// Step 3: Execute once majority has approved (anyone can execute)
vaultContract.executeVaultReconfiguration(
  vaultId,
  compromisedGuardianAddress,
  currentThreshold // Keep existing threshold
);
```

Adjusting approval thresholds:

```solidity
// For 4-of-5 vault becoming 3-of-4 after guardian removal:
vaultContract.proposeThresholdUpdate(vaultId, 2); // New threshold for 3 remaining guardians
// (Get 2 approvals from 3 remaining guardians)
vaultContract.executeVaultReconfiguration(
  vaultId,
  ethers.ZeroAddress, // No removal
  2 // New threshold
);
```

### Events for Monitoring

```solidity
event GuardianRemovalProposed(
  uint256 indexed vaultId,
  address indexed guardian,
  address indexed proposedBy
);

event GuardianRemovalApproved(
  uint256 indexed vaultId,
  address indexed guardian,
  address indexed approver
);

event ThresholdUpdateProposed(
  uint256 indexed vaultId,
  uint256 newThreshold,
  address indexed proposedBy
);

event ThresholdUpdateApproved(
  uint256 indexed vaultId,
  uint256 newThreshold,
  address indexed approver
);

event VaultReconfigurationExecuted(
  uint256 indexed vaultId,
  address indexed guardianRemoved,
  uint256 newThreshold
);
```

---

## Files Modified

### Primary Changes
- **`contracts/SpooVault.sol`** (+~450 lines)
  - 2 new structs (GuardianRemovalProposal, ThresholdUpdateProposal)
  - 6 new custom errors
  - 4 new mappings for proposal tracking
  - 5 public functions for proposal lifecycle
  - 1 internal helper function for guardian removal
  - 7 new events

### Test Coverage
- **`test/GuardianRotation.test.cjs`** (new, 267 lines)
  - 18 comprehensive tests covering all scenarios
  - Edge case validation
  - Access control verification

### Documentation
- **This PR description** - Architectural overview
- Inline code comments throughout implementation
- Event documentation for off-chain integration

---

## Acceptance Criteria Verification

✅ **Vault creator and guardians can rotate compromised guardian keys via threshold consensus**
- Implementation allows multi-guardian vote to remove compromised keys
- Majority consensus model ensures collaborative security decision-making

✅ **Deadlocked vaults can recover through authorized guardian rotation**
- Guardian removal enables threshold adjustments to operational levels
- Prevents permanent vault lockout from key loss

✅ **No out-of-scope features added**
- Focused only on guardian rotation and threshold adjustment
- No changes to document access or encryption logic
- No modifications to inheritance/release mechanisms

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Malicious guardian removal | Requires majority consensus, single actor cannot force removal |
| Threshold manipulation | Requires separate majority approval for threshold changes |
| Proposal spam | 7-day expiration, only one active proposal per guardian/threshold |
| Double-execution | Proposals marked executed, cannot be run twice |
| Guardian count underflow | Cannot remove all guardians, validation prevents empty sets |
| Invalid thresholds | Validation ensures threshold ≤ guardian count at all times |

---

## Performance Notes

- **Proposal creation:** ~147K gas (state storage)
- **Approval:** ~90K gas (tracking + array push)
- **Execution:** ~80K gas (removal + threshold update combined)
- **Total cost per reconfiguration:** ~360K gas (3 approvals + 1 execution)

Memory-efficient with O(1) operations for approval checks and O(n) only for guardian array cleanup.

---

## Future Enhancements

Possible follow-up work (out of scope for this PR):
- Time-locked reconfiguration delays
- Guardian rotation with replacement in single transaction
- Tiered governance for different proposal types
- Event-based triggering of guardian rotation

---

## Checklist

- ✅ All tests passing (24/24)
- ✅ CI/CD validation complete
- ✅ Solidity compilation successful
- ✅ No compiler warnings or errors
- ✅ Code review ready
- ✅ Documentation complete
- ✅ Acceptance criteria met
- ✅ Git branch clean and ready for merge

---

**Ready for review and merge** 🚀
