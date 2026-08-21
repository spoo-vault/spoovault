// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title VDFVerifier
 * @notice On-chain Wesolowski VDF proof verifier using the EIP-198 modexp precompile.
 * @dev Operates over a 256-bit RSA modulus so verification stays under 200,000 gas.
 *
 *      Statement: y = x^(2^T) mod N
 *      Proof:     (π, ℓ) with ℓ = FS(x, y, T, N) and π = x^⌊2^T / ℓ⌋ mod N
 *      Check:     π^ℓ · x^r ≡ y (mod N) where r = 2^T mod ℓ
 *
 *      Computing r = 2^T mod ℓ is O(log T) via modexp. Relayers can also drive
 *      Pietrzak-style halving rounds via {verifyPietrzakRound}.
 */
contract VDFVerifier {
    uint256 public constant CHALLENGE_BITS = 128;
    uint256 public constant MAX_VERIFY_GAS_TARGET = 200_000;

    error InvalidModulus();
    error InvalidProof();
    error InvalidDelay();
    error ChallengeMismatch();

    event VdfProofVerified(bytes32 indexed commitment, uint64 T, bytes32 yHash);

    /**
     * @notice Verify a Wesolowski VDF proof over a 256-bit modulus.
     * @param x Base group element
     * @param y Alleged output x^(2^T) mod N
     * @param pi Wesolowski proof element
     * @param N RSA modulus (must fit in uint256, N > 1)
     * @param T Sequential squaring delay
     * @param l Fiat–Shamir challenge (must match on-chain recomputation)
     */
    function verifyWesolowski(
        uint256 x,
        uint256 y,
        uint256 pi,
        uint256 N,
        uint64 T,
        uint256 l
    ) external returns (bool) {
        _validate(x, y, pi, N, T, l);
        if (_fiatShamir(x, y, T, N) != l) revert ChallengeMismatch();
        if (!_check(x, y, pi, N, T, l)) revert InvalidProof();

        emit VdfProofVerified(keccak256(abi.encodePacked(x, N, T)), T, bytes32(y));
        return true;
    }

    /**
     * @notice View-only verification (no event) — preferred for gas metering.
     */
    function verifyWesolowskiView(
        uint256 x,
        uint256 y,
        uint256 pi,
        uint256 N,
        uint64 T,
        uint256 l
    ) external view returns (bool) {
        if (!_inputsOk(x, y, pi, N, T, l)) return false;
        if (_fiatShamir(x, y, T, N) != l) return false;
        return _check(x, y, pi, N, T, l);
    }

    /**
     * @notice One Pietrzak halving round. Call log₂(T) times to fully verify.
     */
    function verifyPietrzakRound(
        uint256 x,
        uint256 y,
        uint256 mu,
        uint256 N,
        uint64 T
    ) external view returns (uint256 newX, uint256 newY, uint64 newT) {
        if (N < 3) revert InvalidModulus();
        if (T < 2 || (T & (T - 1)) != 0) revert InvalidDelay();
        if (x == 0 || y == 0 || mu == 0 || x >= N || y >= N || mu >= N) {
            revert InvalidProof();
        }

        uint256 r = _pietrzakChallenge(x, y, mu, T, N);
        newX = mulmod(modExp(x, r, N), mu, N);
        newY = mulmod(modExp(mu, r, N), y, N);
        newT = T >> 1;
    }

    // ─── Core checks ───────────────────────────────────────────────────────

    function _check(
        uint256 x,
        uint256 y,
        uint256 pi,
        uint256 N,
        uint64 T,
        uint256 l
    ) private view returns (bool) {
        // r = 2^T mod ℓ  (O(log T))
        uint256 r = modExp(2, T, l);
        // π^ℓ · x^r ≡ y (mod N)
        uint256 left = mulmod(modExp(pi, l, N), modExp(x, r, N), N);
        return left == y;
    }

    function _validate(
        uint256 x,
        uint256 y,
        uint256 pi,
        uint256 N,
        uint64 T,
        uint256 l
    ) private pure {
        if (!_inputsOk(x, y, pi, N, T, l)) {
            if (N < 3) revert InvalidModulus();
            if (T == 0) revert InvalidDelay();
            revert InvalidProof();
        }
    }

    function _inputsOk(
        uint256 x,
        uint256 y,
        uint256 pi,
        uint256 N,
        uint64 T,
        uint256 l
    ) private pure returns (bool) {
        if (N < 3) return false;
        if (T == 0) return false;
        if (x == 0 || y == 0 || pi == 0) return false;
        if (x >= N || y >= N || pi >= N) return false;
        if (l < 3 || l % 2 == 0) return false;
        return true;
    }

    /**
     * @dev Fiat–Shamir: keccak256(abi.encodePacked(x,y,T,N)) masked to CHALLENGE_BITS,
     *      forced odd and ≥ 3. Matches the off-chain encoder in src/utils/vdf.ts when
     *      values are packed as 32-byte big-endian words.
     */
    function _fiatShamir(
        uint256 x,
        uint256 y,
        uint64 T,
        uint256 N
    ) private pure returns (uint256) {
        bytes32 digest = keccak256(abi.encodePacked(x, y, T, N));
        uint256 mask = (uint256(1) << CHALLENGE_BITS) - 1;
        uint256 challenge = uint256(digest) & mask;
        if (challenge < 3) challenge = 3;
        if (challenge % 2 == 0) challenge += 1;
        return challenge;
    }

    function _pietrzakChallenge(
        uint256 x,
        uint256 y,
        uint256 mu,
        uint64 T,
        uint256 N
    ) private pure returns (uint256) {
        bytes32 digest = keccak256(abi.encodePacked(x, y, mu, T, N));
        uint256 r = uint256(digest) & ((uint256(1) << 128) - 1);
        if (r == 0) r = 1;
        return r;
    }

    /**
     * @notice EIP-198 modular exponentiation: base^exponent mod modulus.
     */
    function modExp(
        uint256 base,
        uint256 exponent,
        uint256 modulus
    ) public view returns (uint256 result) {
        if (modulus == 0) revert InvalidModulus();
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x20)
            mstore(add(ptr, 0x20), 0x20)
            mstore(add(ptr, 0x40), 0x20)
            mstore(add(ptr, 0x60), base)
            mstore(add(ptr, 0x80), exponent)
            mstore(add(ptr, 0xa0), modulus)
            let success := staticcall(gas(), 0x05, ptr, 0xc0, ptr, 0x20)
            if iszero(success) {
                revert(0, 0)
            }
            result := mload(ptr)
        }
    }
}
