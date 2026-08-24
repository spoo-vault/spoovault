/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONTRACT_ADDRESS?: string;
  readonly VITE_STELLAR_CONTRACT_ADDRESS?: string;
  readonly VITE_STELLAR_RPC_URL?: string;
  readonly VITE_PINATA_API_KEY?: string;
  readonly VITE_PINATA_API_SECRET?: string;
  readonly VITE_PINATA_JWT?: string;
  readonly VITE_AVALANCHE_RPC?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_CHAIN_NAME?: string;
  readonly VITE_IPFS_GATEWAY?: string;
  readonly VITE_IPFS_FALLBACK_GATEWAYS?: string;
  readonly VITE_IPFS_GATEWAY_TIMEOUT_MS?: string;
  readonly VITE_IPFS_API_URL?: string;
  readonly VITE_IPFS_PROXY_URL?: string;
  readonly VITE_SPOOVUALT_PROXY_SECRET?: string;
  readonly VITE_LOG_CHUNK_SIZE?: string;
  readonly VITE_CONTRACT_DEPLOY_BLOCK?: string;
  readonly VITE_PIR_ENABLED?: string;
  readonly VITE_PIR_USE_TOR?: string;
  readonly VITE_PIR_TOR_HOST?: string;
  readonly VITE_PIR_TOR_PORT?: string;
  readonly VITE_PIR_DUMMY_COUNT?: string;
  readonly VITE_PIR_BATCH_DELAY?: string;
  readonly VITE_SOROBAN_EVENT_RELAY_URL?: string;
  readonly VITE_LIGHTHOUSE_API_KEY?: string;
  readonly VITE_LIGHTHOUSE_GATEWAY_URL?: string;
  readonly VITE_ARWEAVE_NODE_URL?: string;
  readonly VITE_ARWEAVE_GATEWAY_URL?: string;
  readonly VITE_BACKUP_STORAGE_PROVIDERS?: string;
  readonly VITE_OPAQUE_SERVER_URL?: string;
  readonly VITE_OPAQUE_SERVER_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
