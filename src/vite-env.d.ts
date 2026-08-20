/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONTRACT_ADDRESS?: string;
  readonly VITE_PINATA_API_KEY?: string;
  readonly VITE_PINATA_API_SECRET?: string;
  readonly VITE_PINATA_JWT?: string;
  readonly VITE_AVALANCHE_RPC?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_CHAIN_NAME?: string;
  readonly VITE_IPFS_GATEWAY?: string;
  readonly VITE_IPFS_API_URL?: string;
  readonly VITE_LOG_CHUNK_SIZE?: string;
  readonly VITE_CONTRACT_DEPLOY_BLOCK?: string;
  readonly VITE_STELLAR_CONTRACT_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
