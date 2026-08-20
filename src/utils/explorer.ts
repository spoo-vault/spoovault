export type NetworkType = "avalanche" | "stellar";

const EXPLORER_BASE_URLS: Record<NetworkType, string> = {
  avalanche: "https://testnet.snowtrace.io",
  stellar: "https://testnet.bex.stellar.org",
};

export const getExplorerBaseUrl = (network?: NetworkType): string => {
  return EXPLORER_BASE_URLS[network || "avalanche"];
};

export const getExplorerTxUrl = (txHash: string, network?: NetworkType): string => {
  const base = getExplorerBaseUrl(network);
  return `${base}/tx/${txHash}`;
};

export const getExplorerTokenUrl = (
  tokenId: number,
  contractAddress: string,
  network?: NetworkType
): string => {
  const base = getExplorerBaseUrl(network);
  return `${base}/token/${contractAddress}?a=${tokenId}`;
};
