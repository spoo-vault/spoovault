# Troubleshooting Common Integration Issues

Answers to typical development issues when running SpooVault.

## Common Failures

1. **Freighter connection fails**: Verify Freighter has "Testnet" selected in its settings.
2. **Hardhat RPC timeout**: If Avalanche Fuji RPC times out, replace the endpoint URL in your `.env` file with an alternate public node.
3. **IPFS Upload fails**: Ensure the Pinata local proxy is running (`npm run proxy:pinata`) and the port matches your env config.
4. **MetaMask Transaction Rejected**: Verify Fuji Testnet token balance. Get free Fuji tokens from the official faucet.
