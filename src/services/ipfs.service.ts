import axios from "axios";
import { ipfsGateway } from "./ipfsGateway";
import { signProxyRequest } from "../utils/ipfsProxySignature";

const PINATA_API_URL =
  import.meta.env.VITE_IPFS_API_URL || "https://api.pinata.cloud";
const PINATA_JWT = import.meta.env.VITE_PINATA_JWT;
const PINATA_API_KEY = import.meta.env.VITE_PINATA_API_KEY;
const PINATA_API_SECRET = import.meta.env.VITE_PINATA_API_SECRET;

const IPFS_PROXY_URL =
  (import.meta.env.VITE_IPFS_PROXY_URL as string | undefined)?.trim() || "";
const PROXY_SECRET =
  (import.meta.env.VITE_SPOOVUALT_PROXY_SECRET as string | undefined)?.trim() || "";

const isConfigured = (): boolean => {
  if (IPFS_PROXY_URL) {
    return !!PROXY_SECRET;
  }
  return !!PINATA_JWT || (!!PINATA_API_KEY && !!PINATA_API_SECRET);
};

const getProxySecret = (): string => {
  if (!PROXY_SECRET) {
    throw new Error("IPFS proxy signing secret is not configured");
  }
  return PROXY_SECRET;
};

const getURL = (hash: string): string => ipfsGateway.getURL(hash);

const fetchFile = (hash: string, init?: RequestInit): Promise<Response> =>
  ipfsGateway.fetchFile(hash, init);

const getGatewayPool = (): string[] => ipfsGateway.getGatewayPool();

const buildAuthHeaders = (): Record<string, string> => {
  if (PINATA_JWT) {
    return { Authorization: `Bearer ${PINATA_JWT}` };
  }
  if (PINATA_API_KEY && PINATA_API_SECRET) {
    return {
      pinata_api_key: PINATA_API_KEY,
      pinata_secret_api_key: PINATA_API_SECRET,
    };
  }
  return {};
};

const uploadFile = async (
  file: File,
  metadata: Record<string, any> = {},
  signal?: AbortSignal
): Promise<{ hash: string; size: number }> => {
  if (!isConfigured()) {
    throw new Error("IPFS is not configured");
  }

  const formData = new FormData();
  formData.append("file", file);

  if (metadata && Object.keys(metadata).length > 0) {
    const name = metadata.name || file.name;
    const keyvalues = metadata.keyvalues || metadata;
    formData.append("pinataMetadata", JSON.stringify({ name, keyvalues }));
  }

  try {
    let response;
    if (IPFS_PROXY_URL) {
      const auth = await signProxyRequest({
        secret: getProxySecret(),
        method: "POST",
        path: "/api/ipfs/pin-file",
        unsignedBody: true,
      });
      response = await axios.post(
        `${IPFS_PROXY_URL}/api/ipfs/pin-file`,
        formData,
        {
          headers: auth.headers,
          timeout: 90000,
          maxBodyLength: Infinity,
          signal,
        }
      );
    } else {
      response = await axios.post(
        `${PINATA_API_URL}/pinning/pinFileToIPFS`,
        formData,
        {
          headers: buildAuthHeaders(),
          timeout: 90000,
          maxBodyLength: Infinity,
          signal,
        }
      );
    }

    return {
      hash: response.data.IpfsHash,
      size: response.data.PinSize,
    };
  } catch (error: any) {
    const isCanceled = error?.code === "ERR_CANCELED";
    const isTimeout = error?.code === "ECONNABORTED";
    const message = isCanceled
      ? "IPFS upload canceled."
      : isTimeout
      ? "IPFS upload timed out. Try again with a smaller file or better network."
      : error?.response?.data?.error?.reason ||
        error?.response?.data?.error ||
        error?.message ||
        "IPFS upload failed";
    throw new Error(message);
  }
};

export const ipfsService = {
  isConfigured,
  getURL,
  fetchFile,
  getGatewayPool,
  uploadFile,
};

