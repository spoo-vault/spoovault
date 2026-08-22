# IPFS Storage & Serverless Pinata Proxy Setup

IPFS (InterPlanetary File System) provides decentralized storage for encrypted document payloads.

## Pinata Proxy Architecture

To avoid exposing Pinata API keys on the client-side, SpooVault routes upload traffic through a local/serverless gateway proxy.

- **Local Dev Proxy**: Starts via `npm run proxy:pinata` on port 5001.
- **Client Configuration**: Set `VITE_IPFS_PROXY_URL=http://localhost:5001/api/upload`.
- **IPFS Pinning**: The proxy handles the Pinata authentication and returns the unique CID (Content Identifier) and gateway path back to the client.
