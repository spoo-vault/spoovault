# Freighter Wallet Integration Guide for Stellar

Freighter is the native browser extension wallet for Stellar. It allows signing Soroban transactions safely.

## Client Integration Steps

1. **Installation**: Check for Freighter extension availability.
2. **Initialization**: Initialize Freighter API and get active account address.
3. **Lazy SDK Loading**: Import `@stellar/freighter-api` dynamically to minimize bundle footprint:
   ```typescript
   const freighter = await import("@stellar/freighter-api");
   const address = await freighter.getAddress();
   ```
4. **Transaction Signing**: Submit transaction envelopes (XDR) to Freighter for client signature.
