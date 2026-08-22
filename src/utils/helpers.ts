import CryptoJS from "crypto-js";
import { ipfsService } from "../services/ipfs.service";

/**
 * Shorten Ethereum address
 */
export const shortenAddress = (address: string, chars = 4): string => {
  if (!address || address.length < chars * 2 + 2) return address || "";
  return `${address.substring(0, chars + 2)}...${address.substring(
    address.length - chars
  )}`;
};

/**
 * Generate a random encryption key
 */
export const generateEncryptionKey = (): string => {
  const array = new Uint8Array(32);
  window.crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
};

/**
 * Encrypt data using AES-256
 */
export const encryptData = (data: string, key: string): string => {
  return CryptoJS.AES.encrypt(data, key).toString();
};

/**
 * Decrypt data using AES-256
 */
export const decryptData = (encryptedData: string, key: string): string => {
  const bytes = CryptoJS.AES.decrypt(encryptedData, key);
  return bytes.toString(CryptoJS.enc.Utf8);
};

/**
 * Upload file to IPFS (wrapper for ipfsService)
 */
export const uploadToIPFS = async (
  file: File,
  metadata: any = {},
  signal?: AbortSignal
): Promise<{ hash: string; size: number }> => {
  return ipfsService.uploadFile(file, metadata, signal);
};

/**
 * Format file size
 */
export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (
    Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
  );
};

/**
 * Format date
 */
export const formatDate = (timestamp: number): string => {
  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * Validate EVM address format (0x...)
 */
export const isValidEVMAddress = (address: string): boolean => {
  if (!address || typeof address !== "string") return false;
  return /^0x[a-fA-F0-9]{40}$/.test(address.trim());
};

/**
 * Validate Stellar address format (G... or C...)
 */
export const isValidStellarAddress = (address: string): boolean => {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  return /^G[A-Z2-7]{55}$/.test(trimmed) || /^C[A-Z2-7]{55}$/.test(trimmed);
};

/**
 * Validate address format on either EVM or Stellar networks
 */
export const isValidAddress = (
  address: string,
  ecosystem?: "avalanche" | "stellar"
): boolean => {
  if (ecosystem === "stellar") {
    return isValidStellarAddress(address);
  }
  if (ecosystem === "avalanche") {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }
  return /^0x[a-fA-F0-9]{40}$/.test(address) || isValidStellarAddress(address);
};

/**
 * Get a deterministic IPFS gateway URL (primary gateway, for display/copy).
 */
export const getIPFSURL = (hash: string): string => {
  return ipfsService.getURL(hash);
};

/**
 * Download IPFS content with multi-gateway race fetch and circuit breaker.
 * Failover is automatic on HTTP 429, timeouts, and other gateway errors.
 */
export const fetchFromIPFS = (
  hash: string,
  init?: RequestInit
): Promise<Response> => {
  return ipfsService.fetchFile(hash, init);
};

/**
 * Split encryption key among guardians (simplified)
 */
export const splitKeyAmongGuardians = (
  key: string,
  guardians: string[]
): string[] => {
  // Note: In production, use Shamir's Secret Sharing
  const parts: string[] = [];
  const keyLength = key.length;
  const partSize = Math.ceil(keyLength / guardians.length);

  for (let i = 0; i < guardians.length; i++) {
    const start = i * partSize;
    const end = Math.min(start + partSize, keyLength);
    parts.push(key.slice(start, end));
  }

  return parts;
};

/**
 * Reconstruct key from guardian parts
 */
export const reconstructKey = (parts: string[]): string => {
  return parts.join("");
};

/**
 * Generate a unique request ID
 */
export const generateRequestId = (): string => {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
};

/**
 * Get current year for footer
 */
export const getCurrentYear = (): number => {
  return new Date().getFullYear();
};

/**
 * Format composite global vault identifier (VaultGID)
 * e.g. "43113:1" or "stellar-testnet:1"
 */
export const toVaultGID = (
  chainIdentifier: number | string,
  vaultId: number | string
): string => {
  return `${chainIdentifier}:${vaultId}`;
};

/**
 * Parse a composite global vault identifier (VaultGID)
 */
export const parseVaultGID = (
  gid: string
): { chainId: string; vaultId: number } => {
  const parts = gid.split(":");
  if (parts.length >= 2) {
    const chainId = parts[0];
    const vaultId = Number.parseInt(parts[1], 10);
    return { chainId, vaultId: Number.isNaN(vaultId) ? 0 : vaultId };
  }
  const numeric = Number.parseInt(gid, 10);
  return { chainId: "43113", vaultId: Number.isNaN(numeric) ? 0 : numeric };
};

/**
 * Get standard VaultGID based on active ecosystem and chainId
 */
export const getVaultGID = (
  ecosystem: "avalanche" | "stellar",
  chainId: number | null,
  vaultId: number
): string => {
  if (ecosystem === "stellar") {
    return toVaultGID("stellar-testnet", vaultId);
  }
  return toVaultGID(chainId || 43113, vaultId);
};

/**
 * Build a document-count map keyed by VaultGID (not raw numeric vault id),
 * so documents from same-numbered vaults on different chains never merge.
 */
export const buildVaultDocumentCounts = (
  ecosystem: "avalanche" | "stellar",
  chainId: number | null,
  vaults: { id: number }[],
  docs: { vaultId: number }[]
): Record<string, number> => {
  const visibleGidSet = new Set(
    vaults.map((vault) => getVaultGID(ecosystem, chainId, vault.id))
  );
  const counts: Record<string, number> = {};
  docs.forEach((doc) => {
    const gid = getVaultGID(ecosystem, chainId, doc.vaultId);
    if (visibleGidSet.has(gid)) {
      counts[gid] = (counts[gid] || 0) + 1;
    }
  });
  return counts;
};

/**
 * Re-key a raw numeric-vault-id-keyed record (e.g. release states from the
 * contract) onto VaultGID, so state from same-numbered vaults on different
 * chains never overwrites or falls back onto each other.
 */
export const keyRecordByVaultGID = <T>(
  ecosystem: "avalanche" | "stellar",
  chainId: number | null,
  recordByRawId: Record<string, T>
): Record<string, T> => {
  const result: Record<string, T> = {};
  Object.entries(recordByRawId).forEach(([rawIdStr, value]) => {
    const numId = Number(rawIdStr);
    const gid = getVaultGID(ecosystem, chainId, numId);
    result[gid] = value;
  });
  return result;
};

/**
 * Check if IPFS is configured
 */
export const isIPFSConfigured = (): boolean => {
  return ipfsService.isConfigured();
};
