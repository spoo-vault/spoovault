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
  (import.meta.env.VITE_SPOOVUALT_PROXY_SECRET as string | undefined)?.trim() ||
  "";

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

const textEncoder = new TextEncoder();

const sanitizeMultipartFilename = (filename: string): string => {
  return filename.replace(/[\r\n"]/g, "_");
};

/**
 * Build a multipart/form-data ReadableStream around a file body stream so the
 * ciphertext never has to be buffered as a Blob/File before upload.
 */
export const createMultipartFileStream = (
  fileStream: ReadableStream<Uint8Array>,
  options: {
    filename: string;
    contentType?: string;
    metadata?: Record<string, unknown>;
    boundary?: string;
  }
): { body: ReadableStream<Uint8Array>; contentType: string; boundary: string } => {
  const boundary =
    options.boundary ??
    `----SpooVaultFormBoundary${cryptoRandomBoundary()}`;
  const filename = sanitizeMultipartFilename(options.filename);
  const contentType = options.contentType || "application/octet-stream";

  const preambleParts = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`,
    `Content-Type: ${contentType}\r\n\r\n`,
  ];

  let metadataPart = "";
  if (options.metadata && Object.keys(options.metadata).length > 0) {
    const name =
      (typeof options.metadata.name === "string" && options.metadata.name) ||
      filename;
    const keyvalues =
      (options.metadata.keyvalues as Record<string, unknown> | undefined) ||
      options.metadata;
    const pinataMetadata = JSON.stringify({ name, keyvalues });
    metadataPart =
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="pinataMetadata"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${pinataMetadata}`;
  }

  const epilogue = `${metadataPart}\r\n--${boundary}--\r\n`;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(textEncoder.encode(preambleParts.join("")));
        const reader = fileStream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            controller.enqueue(value);
          }
        }
        controller.enqueue(textEncoder.encode(epilogue));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return {
    body,
    boundary,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};

const cryptoRandomBoundary = (): string => {
  const bytes = new Uint8Array(12);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

type UploadStreamOptions = {
  filename: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
};

/**
 * Stream a ReadableStream file body to Pinata (or the local proxy) as multipart
 * form-data without buffering the full payload in memory.
 */
const uploadStream = async (
  fileStream: ReadableStream<Uint8Array>,
  options: UploadStreamOptions
): Promise<{ hash: string; size: number }> => {
  if (!isConfigured()) {
    throw new Error("IPFS is not configured");
  }

  const { body, contentType } = createMultipartFileStream(fileStream, {
    filename: options.filename,
    contentType: options.contentType,
    metadata: options.metadata,
  });

  const endpoint = IPFS_PROXY_URL
    ? `${IPFS_PROXY_URL}/api/ipfs/pin-file`
    : `${PINATA_API_URL}/pinning/pinFileToIPFS`;

  const headers: Record<string, string> = {
    ...(!IPFS_PROXY_URL ? buildAuthHeaders() : {}),
    "Content-Type": contentType,
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: options.signal,
      // Required by Fetch for streaming request bodies (Chromium / undici).
      duplex: "half",
    } as RequestInit);

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        (data as any)?.error?.reason ||
        (data as any)?.error ||
        (data as any)?.message ||
        `IPFS upload failed (${response.status})`;
      throw new Error(typeof message === "string" ? message : "IPFS upload failed");
    }

    if (!(data as any)?.IpfsHash) {
      throw new Error("IPFS upload succeeded but no IpfsHash was returned");
    }

    return {
      hash: (data as any).IpfsHash,
      size: Number((data as any).PinSize) || 0,
    };
  } catch (error: any) {
    if (options.signal?.aborted || error?.name === "AbortError") {
      throw new Error("IPFS upload canceled.");
    }
    throw new Error(error?.message || "IPFS upload failed");
  }
};

const unpin = async (hash: string, signal?: AbortSignal): Promise<boolean> => {
  if (!hash || typeof hash !== "string" || !hash.trim()) {
    throw new Error("IPFS hash is required for unpinning");
  }

  if (!isConfigured()) {
    throw new Error("IPFS is not configured");
  }

  const cleanHash = hash.trim();

  try {
    if (IPFS_PROXY_URL) {
      const path = `/api/ipfs/unpin/${encodeURIComponent(cleanHash)}`;
      const auth = await signProxyRequest({
        secret: getProxySecret(),
        method: "DELETE",
        path,
      });
      await axios.delete(`${IPFS_PROXY_URL}${path}`, {
        headers: auth.headers,
        timeout: 30000,
        signal,
      });
    } else {
      await axios.delete(
        `${PINATA_API_URL}/pinning/unpin/${encodeURIComponent(cleanHash)}`,
        {
          headers: buildAuthHeaders(),
          timeout: 30000,
          signal,
        }
      );
    }
    return true;
  } catch (error: any) {
    if (error?.response?.status === 404) {
      return true;
    }
    const isCanceled = error?.code === "ERR_CANCELED";
    const isTimeout = error?.code === "ECONNABORTED";
    const message = isCanceled
      ? "IPFS unpin canceled."
      : isTimeout
      ? "IPFS unpin timed out."
      : error?.response?.data?.error?.reason ||
        error?.response?.data?.error ||
        error?.message ||
        "IPFS unpin failed";
    throw new Error(message);
  }
};

export const ipfsService = {
  isConfigured,
  getURL,
  fetchFile,
  getGatewayPool,
  uploadFile,
  uploadStream,
  createMultipartFileStream,
  unpin,
};
