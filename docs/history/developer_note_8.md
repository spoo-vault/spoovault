# MetaMask Integration & EVM Provider Configuration

MetaMask is used as the primary provider for EVM networks, configured to connect to the Avalanche Fuji Testnet.

## Web3 Context Setup

- Checks for `window.ethereum` provider.
- Configures default RPC (`VITE_AVALANCHE_RPC`).
- Listens to account and chain change events:
  ```javascript
  window.ethereum.on("accountsChanged", (accounts) =>
    handleAccountChange(accounts)
  );
  window.ethereum.on("chainChanged", (chainId) => handleChainChange(chainId));
  ```
- Validates the network chain ID matches target configuration to avoid cross-network execution errors.
