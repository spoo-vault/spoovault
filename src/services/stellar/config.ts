export const STELLAR_CONFIG = {
  network: import.meta.env.VITE_STELLAR_NETWORK || "testnet",
  rpc: import.meta.env.VITE_SOROBAN_RPC || "https://soroban-testnet.stellar.org",
  contractId: import.meta.env.VITE_SOROBAN_CONTRACT_ID || "CCYKK34DEO2BJABJQ7DW5MZ6PYFC7MRJYTZL2QPKBFCXHR4P347EUFZL",
  activeVaultId: Number(import.meta.env.VITE_ACTIVE_VAULT_ID || 2),
  activeDocId: Number(import.meta.env.VITE_ACTIVE_DOC_ID || 1),
  explorer: import.meta.env.VITE_STELLAR_EXPLORER,
} as const;
