# Hosting Deployment to Firebase & Testnets

SpooVault is built for serverless hosting environments.

## Frontend Deployment (Firebase Hosting)

1. Build the production application bundle:
   ```bash
   npm run build
   ```
2. Deploy hosting resources:
   ```bash
   firebase deploy --only hosting
   ```

## Contract Deployments

- **Solidity**: Deployed on Avalanche Fuji Testnet via `npm run deploy:contract`.
- **Soroban**: Compiled to WASM and deployed using Soroban CLI to Stellar Testnet.
