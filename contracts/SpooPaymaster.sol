// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IPaymaster.sol";
import "./interfaces/IEntryPoint.sol";

interface ISpooVaultForPaymaster {
    function getVaultCreator(uint256 vaultId) external view returns (address);
}

/**
 * @title SpooPaymaster
 * @notice EIP-4337 Account Abstraction Paymaster sponsoring gas fees for SpooVault
 *         guardians executing `approveAccess` and `acceptGuardianInvite`.
 *
 * Sponsorship Architecture:
 * - Vault creators deposit native AVAX into SpooPaymaster (allocated per vault or per creator).
 * - SpooPaymaster forwards deposited native AVAX directly to the EIP-4337 EntryPoint.
 * - During UserOp validation (`validatePaymasterUserOp`):
 *     1. Validates that target is SpooVault and inner method is `approveAccess` or `acceptGuardianInvite`.
 *     2. Enforces per-guardian and per-vault rate limits to prevent gas drainage.
 *     3. Resolves the vault creator and validates that the vault/creator has sufficient balance >= maxCost.
 * - During `postOp`:
 *     Deducts the actual gas cost incurred (`actualGasCost`), automatically refunding/preserving
 *     any unused gas from `maxCost`.
 */
contract SpooPaymaster is IPaymaster, Ownable, ReentrancyGuard {
    // ─── Function Selectors ──────────────────────────────────────────────────
    bytes4 private constant EXECUTE_SELECTOR = 0xb61d27f6; // execute(address,uint256,bytes)
    bytes4 private constant EXECUTE_CALL_SELECTOR = 0x9e5d4c49; // executeCall(address,uint256,bytes)
    bytes4 private constant ACCEPT_INVITE_SELECTOR = 0x0f576ff1; // acceptGuardianInvite(uint256)
    bytes4 private constant APPROVE_ACCESS_SELECTOR = 0x568497bb; // approveAccess(uint256)
    bytes4 private constant APPROVE_ACCESS_ENCRYPTED_SELECTOR = 0xc050099e; // approveAccess(uint256,string)

    // ─── Immutables & State ──────────────────────────────────────────────────
    IEntryPoint public immutable entryPoint;
    address public spooVault;

    // Sponsorship accounting
    mapping(uint256 => uint256) public vaultSponsorBalances;
    mapping(address => uint256) public creatorSponsorBalances;

    // Rate limiting rules
    uint256 public maxOpsPerWindow = 10;
    uint256 public rateLimitWindow = 1 hours;
    uint256 public maxVaultOpsPerWindow = 50;

    mapping(address => uint256) public guardianOpCount;
    mapping(address => uint256) public guardianWindowStart;

    mapping(uint256 => uint256) public vaultOpCount;
    mapping(uint256 => uint256) public vaultWindowStart;

    // ─── Events ──────────────────────────────────────────────────────────────
    event VaultDeposit(uint256 indexed vaultId, address indexed sender, uint256 amount);
    event CreatorDeposit(address indexed creator, uint256 amount);
    event VaultWithdrawal(uint256 indexed vaultId, address indexed creator, uint256 amount);
    event CreatorWithdrawal(address indexed creator, uint256 amount);
    event GasSponsored(
        uint256 indexed vaultId,
        address indexed creator,
        address indexed guardian,
        uint256 actualGasCost,
        PostOpMode mode
    );
    event RateLimitsUpdated(uint256 maxOpsPerWindow, uint256 rateLimitWindow, uint256 maxVaultOpsPerWindow);
    event SpooVaultUpdated(address newSpooVault);

    // ─── Custom Errors ───────────────────────────────────────────────────────
    error OnlyEntryPoint();
    error InvalidTarget(address target);
    error UnauthorizedMethod(bytes4 selector);
    error InvalidCallData();
    error InvalidVault(uint256 vaultId);
    error InsufficientSponsorBalance(uint256 vaultId, address creator, uint256 requiredAmount);
    error RateLimitExceeded(address guardian);
    error VaultRateLimitExceeded(uint256 vaultId);
    error ZeroDeposit();
    error ZeroAmount();
    error Unauthorized();
    error InsufficientBalance();
    error ZeroAddress();

    // ─── Constructor ─────────────────────────────────────────────────────────
    constructor(
        IEntryPoint _entryPoint,
        address _spooVault,
        address initialOwner
    ) Ownable(initialOwner) {
        if (address(_entryPoint) == address(0) || _spooVault == address(0)) {
            revert ZeroAddress();
        }
        entryPoint = _entryPoint;
        spooVault = _spooVault;
    }

    // ─── Receive & Deposits ──────────────────────────────────────────────────
    receive() external payable {
        depositForCreator(msg.sender);
    }

    function deposit() external payable {
        depositForCreator(msg.sender);
    }

    /**
     * @notice Deposit AVAX sponsorship allocated specifically to a vault.
     * @param vaultId Vault identifier to fund.
     */
    function depositForVault(uint256 vaultId) external payable nonReentrant {
        if (msg.value == 0) revert ZeroDeposit();
        vaultSponsorBalances[vaultId] += msg.value;
        entryPoint.depositTo{value: msg.value}(address(this));
        emit VaultDeposit(vaultId, msg.sender, msg.value);
    }

    /**
     * @notice Deposit AVAX sponsorship allocated to a creator address.
     * @param creator Vault creator address.
     */
    function depositForCreator(address creator) public payable nonReentrant {
        if (msg.value == 0) revert ZeroDeposit();
        creatorSponsorBalances[creator] += msg.value;
        entryPoint.depositTo{value: msg.value}(address(this));
        emit CreatorDeposit(creator, msg.value);
    }

    // ─── Withdrawals ─────────────────────────────────────────────────────────
    /**
     * @notice Withdraw unused vault-allocated deposit back to the vault creator.
     * @param vaultId Vault identifier.
     * @param amount Amount of AVAX in wei to withdraw.
     */
    function withdrawVaultDeposit(uint256 vaultId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        address creator = ISpooVaultForPaymaster(spooVault).getVaultCreator(vaultId);
        if (msg.sender != creator) revert Unauthorized();
        if (vaultSponsorBalances[vaultId] < amount) revert InsufficientBalance();

        vaultSponsorBalances[vaultId] -= amount;
        entryPoint.withdrawTo(payable(msg.sender), amount);
        emit VaultWithdrawal(vaultId, msg.sender, amount);
    }

    /**
     * @notice Withdraw creator-allocated deposit.
     * @param amount Amount in wei to withdraw.
     */
    function withdrawCreatorDeposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (creatorSponsorBalances[msg.sender] < amount) revert InsufficientBalance();

        creatorSponsorBalances[msg.sender] -= amount;
        entryPoint.withdrawTo(payable(msg.sender), amount);
        emit CreatorWithdrawal(msg.sender, amount);
    }

    // ─── EIP-4337 Paymaster Implementation ───────────────────────────────────

    /**
     * @inheritdoc IPaymaster
     */
    function validatePaymasterUserOp(
        UserOperation calldata userOp,
        bytes32 /* userOpHash */,
        uint256 maxCost
    ) external override returns (bytes memory context, uint256 validationData) {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();

        (address target, bytes4 selector, uint256 param) = _parseCallData(userOp.callData);

        if (target != spooVault) revert InvalidTarget(target);

        if (
            selector != ACCEPT_INVITE_SELECTOR &&
            selector != APPROVE_ACCESS_SELECTOR &&
            selector != APPROVE_ACCESS_ENCRYPTED_SELECTOR
        ) {
            revert UnauthorizedMethod(selector);
        }

        uint256 vaultId = _resolveVaultId(selector, param, userOp.paymasterAndData);
        address creator = ISpooVaultForPaymaster(spooVault).getVaultCreator(vaultId);
        if (creator == address(0)) revert InvalidVault(vaultId);

        // Enforce rate limiting
        _enforceRateLimits(userOp.sender, vaultId);

        // Verify sponsorship balance
        bool isVaultBalance = false;
        if (vaultSponsorBalances[vaultId] >= maxCost) {
            isVaultBalance = true;
        } else if (creatorSponsorBalances[creator] >= maxCost) {
            isVaultBalance = false;
        } else {
            revert InsufficientSponsorBalance(vaultId, creator, maxCost);
        }

        context = abi.encode(vaultId, creator, isVaultBalance, userOp.sender);
        validationData = 0; // Success
    }

    /**
     * @inheritdoc IPaymaster
     */
    function postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost
    ) external override {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();

        (uint256 vaultId, address creator, bool isVaultBalance, address guardian) =
            abi.decode(context, (uint256, address, bool, address));

        if (isVaultBalance) {
            if (vaultSponsorBalances[vaultId] >= actualGasCost) {
                vaultSponsorBalances[vaultId] -= actualGasCost;
            } else {
                vaultSponsorBalances[vaultId] = 0;
            }
        } else {
            if (creatorSponsorBalances[creator] >= actualGasCost) {
                creatorSponsorBalances[creator] -= actualGasCost;
            } else {
                creatorSponsorBalances[creator] = 0;
            }
        }

        emit GasSponsored(vaultId, creator, guardian, actualGasCost, mode);
    }

    // ─── Internal Helpers ────────────────────────────────────────────────────

    function _parseCallData(bytes calldata callData)
        internal
        view
        returns (address target, bytes4 selector, uint256 param)
    {
        if (callData.length < 4) revert InvalidCallData();
        bytes4 topSelector = bytes4(callData[:4]);

        if (topSelector == EXECUTE_SELECTOR || topSelector == EXECUTE_CALL_SELECTOR) {
            if (callData.length < 100) revert InvalidCallData();
            (address dest,, bytes memory innerData) = abi.decode(callData[4:], (address, uint256, bytes));
            target = dest;
            if (innerData.length < 4) revert InvalidCallData();
            selector = bytes4(innerData);
            if (innerData.length >= 36) {
                bytes memory paramBytes = new bytes(32);
                for (uint256 i = 0; i < 32; i++) {
                    paramBytes[i] = innerData[4 + i];
                }
                param = abi.decode(paramBytes, (uint256));
            }
        } else {
            target = spooVault;
            selector = topSelector;
            if (callData.length >= 36) {
                param = abi.decode(callData[4:36], (uint256));
            }
        }
    }

    function _resolveVaultId(bytes4 selector, uint256 param, bytes calldata paymasterAndData)
        internal
        view
        returns (uint256 vaultId)
    {
        if (selector == ACCEPT_INVITE_SELECTOR) {
            vaultId = param;
        } else if (selector == APPROVE_ACCESS_SELECTOR || selector == APPROVE_ACCESS_ENCRYPTED_SELECTOR) {
            uint256 requestId = param;
            (bool successReq, bytes memory reqData) = spooVault.staticcall(
                abi.encodeWithSignature("accessRequests(uint256)", requestId)
            );
            if (successReq && reqData.length >= 64) {
                (, uint256 documentId) = abi.decode(reqData, (uint256, uint256));
                if (documentId > 0) {
                    (bool successDoc, bytes memory docData) = spooVault.staticcall(
                        abi.encodeWithSignature("documents(uint256)", documentId)
                    );
                    if (successDoc && docData.length >= 64) {
                        (, uint64 docVaultId) = abi.decode(docData, (uint64, uint64));
                        vaultId = uint256(docVaultId);
                    }
                }
            }

            if (vaultId == 0 && paymasterAndData.length >= 52) {
                vaultId = abi.decode(paymasterAndData[20:52], (uint256));
            }
        }
    }

    function _enforceRateLimits(address guardian, uint256 vaultId) internal {
        // Guardian rate limit
        // slither-disable-next-line timestamp
        if (block.timestamp >= guardianWindowStart[guardian] + rateLimitWindow) {
            guardianWindowStart[guardian] = block.timestamp;
            guardianOpCount[guardian] = 1;
        } else {
            if (guardianOpCount[guardian] >= maxOpsPerWindow) {
                revert RateLimitExceeded(guardian);
            }
            guardianOpCount[guardian] += 1;
        }

        // Vault rate limit
        // slither-disable-next-line timestamp
        if (block.timestamp >= vaultWindowStart[vaultId] + rateLimitWindow) {
            vaultWindowStart[vaultId] = block.timestamp;
            vaultOpCount[vaultId] = 1;
        } else {
            if (vaultOpCount[vaultId] >= maxVaultOpsPerWindow) {
                revert VaultRateLimitExceeded(vaultId);
            }
            vaultOpCount[vaultId] += 1;
        }
    }

    // ─── Admin Configuration ─────────────────────────────────────────────────

    function setRateLimits(
        uint256 newMaxOpsPerWindow,
        uint256 newRateLimitWindow,
        uint256 newMaxVaultOpsPerWindow
    ) external onlyOwner {
        maxOpsPerWindow = newMaxOpsPerWindow;
        rateLimitWindow = newRateLimitWindow;
        maxVaultOpsPerWindow = newMaxVaultOpsPerWindow;
        emit RateLimitsUpdated(newMaxOpsPerWindow, newRateLimitWindow, newMaxVaultOpsPerWindow);
    }

    function setSpooVault(address newSpooVault) external onlyOwner {
        if (newSpooVault == address(0)) revert ZeroAddress();
        spooVault = newSpooVault;
        emit SpooVaultUpdated(newSpooVault);
    }

    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        entryPoint.addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        entryPoint.unlockStake();
    }

    function withdrawStake(address payable to) external onlyOwner {
        entryPoint.withdrawStake(to);
    }

    function getEntryPointDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    function getVaultDeposit(uint256 vaultId) external view returns (uint256) {
        return vaultSponsorBalances[vaultId];
    }

    function getCreatorDeposit(address creator) external view returns (uint256) {
        return creatorSponsorBalances[creator];
    }
}
