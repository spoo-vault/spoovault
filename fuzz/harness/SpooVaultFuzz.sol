// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../contracts/SpooVault.sol";

/**
 * @title SpooVaultFuzz
 * @dev Differential / invariant fuzzing harness for the SpooVault EVM contract.
 *
 *      Consumed by:
 *        - Echidna  (https://github.com/crytic/echidna)  -> checks `echidna_*` properties
 *        - Medusa   (https://github.com/crytic/medusa)   -> checks `invariant_*` properties
 *
 *      Design notes:
 *        * The harness does NOT inherit SpooVault. It composes an internal
 *          `SpooVault` instance, so the fuzzer can only reach the contract's
 *          mutating entry points through the `fuzz_*` wrappers defined here.
 *          This keeps the harness's shadow accounting (trackedSupply) exact,
 *          because there is no way for the fuzzer to mint/burn/approve the
 *          underlying contract without going through these wrappers.
 *        * The deployer (msg.sender during fuzzing) is registered as the sole
 *          guardian of a bootstrap vault and is minted a vault access NFT, so
 *          the wrapped mutators can be exercised as a legitimate actor.
 */
contract SpooVaultFuzz {
    SpooVault private vault;

    uint256 public vaultId;
    uint256[] private documentIds;
    uint256[] private requestIds;
    uint256[] private mintedTokens;
    mapping(uint256 => bool) private burnedTokens;

    uint256 private trackedSupply;

    constructor() {
        vault = new SpooVault();

        address[] memory guardians = new address[](1);
        guardians[0] = msg.sender; // fuzzer actor becomes the guardian
        vaultId = vault.createVault("Fuzz Vault", "fuzz", guardians, 1);

        // Mint an access NFT to the fuzzer actor so it can request access.
        uint256 tid = vault.mintAccessToken(vaultId, msg.sender, "fuzz-token");
        mintedTokens.push(tid);

        // Seed one document so request/approve flows have something to act on.
        uint256 did = vault.addDocument(vaultId, "fuzz-meta", "QmFuzzSeed", SpooVault.AccessLevel.READ);
        documentIds.push(did);
    }

    // ------------------------------------------------------------------
    // Fuzzable actions (Echidna/Medusa call these with random arguments)
    // ------------------------------------------------------------------

    function fuzz_addDocument() external {
        uint256 did = vault.addDocument(vaultId, "fuzz-meta", "QmFuzzHash", SpooVault.AccessLevel.READ);
        documentIds.push(did);
    }

    function fuzz_request() external {
        if (documentIds.length == 0) return;
        uint256 did = documentIds[documentIds.length - 1];
        uint256 rid = vault.requestAccess(did);
        requestIds.push(rid);
    }

    function fuzz_approve(uint256 idx) external {
        if (idx < requestIds.length) {
            uint256 rid = requestIds[idx];
            vault.approveAccess(rid);
        }
    }

    function fuzz_mint() external {
        uint256 tid = vault.mintAccessToken(vaultId, msg.sender, "fuzz-token");
        trackedSupply += 1;
        mintedTokens.push(tid);
    }

    function fuzz_burn(uint256 idx) external {
        if (idx >= mintedTokens.length) return;
        uint256 tid = mintedTokens[idx];
        if (burnedTokens[tid]) return;
        vault.burnAccessToken(tid);
        burnedTokens[tid] = true;
        trackedSupply -= 1;
    }

    // ------------------------------------------------------------------
    // Invariant helpers
    // ------------------------------------------------------------------

    /// @dev Supply accounting: every mint (via fuzz_mint) increments
    ///      `trackedSupply` and every burn (via fuzz_burn) decrements it.
    ///      Because the fuzzer can only mint/burn through these wrappers,
    ///      `trackedSupply` must always equal the contract's own totalSupply().
    function _checkSupply() private view returns (bool) {
        return vault.totalSupply() == trackedSupply;
    }

    /// @dev Ownership accounting: every token this harness minted that has not
    ///      been burned is owned by a non-zero address.
    function _checkOwnership() private view returns (bool) {
        for (uint256 i = 0; i < mintedTokens.length; i++) {
            uint256 tid = mintedTokens[i];
            if (burnedTokens[tid]) continue;
            address owner = vault.ownerOf(tid);
            if (owner == address(0)) return false;
        }
        return true;
    }

    // ------------------------------------------------------------------
    // Property functions
    // ------------------------------------------------------------------

    function echidna_vault_balance_sum_equals_total_supply() public view returns (bool) {
        return _checkSupply();
    }

    function echidna_minted_tokens_remain_owned() public view returns (bool) {
        return _checkOwnership();
    }

    // Medusa uses the `invariant_*` convention (mirrors the echidna properties).
    function invariant_vault_balance_sum_equals_total_supply() public view returns (bool) {
        return _checkSupply();
    }

    function invariant_minted_tokens_remain_owned() public view returns (bool) {
        return _checkOwnership();
    }
}
