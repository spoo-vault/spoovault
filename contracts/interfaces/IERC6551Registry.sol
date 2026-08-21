// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC6551Registry {
    /**
     * @dev Emitted when a Token Bound Account is created
     */
    event ERC6551AccountCreated(
        address account,
        address indexed implementation,
        bytes32 salt,
        uint256 chainId,
        address indexed tokenContract,
        uint256 indexed tokenId
    );

    /**
     * @dev Creates a Token Bound Account for a specific token
     *
     * @param implementation The address of the account implementation
     * @param salt           A random salt for CREATE2
     * @param chainId        The chain ID of the token contract
     * @param tokenContract  The address of the token contract
     * @param tokenId        The ID of the token
     *
     * @return account       The address of the newly created account
     */
    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address account);

    /**
     * @dev Returns the computed address of a Token Bound Account
     *
     * @param implementation The address of the account implementation
     * @param salt           A random salt for CREATE2
     * @param chainId        The chain ID of the token contract
     * @param tokenContract  The address of the token contract
     * @param tokenId        The ID of the token
     *
     * @return account       The computed address of the account
     */
    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external view returns (address);
}
