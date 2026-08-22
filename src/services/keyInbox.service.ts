import axios from "axios";
import CryptoJS from "crypto-js";
import { signProxyRequest } from "../utils/ipfsProxySignature";
import { ipfsService } from "./ipfs.service";

const PINATA_API_URL =
  import.meta.env.VITE_IPFS_API_URL || "https://api.pinata.cloud";
const PINATA_JWT = import.meta.env.VITE_PINATA_JWT;
const PINATA_API_KEY = import.meta.env.VITE_PINATA_API_KEY;
const PINATA_API_SECRET = import.meta.env.VITE_PINATA_API_SECRET;
const IPFS_GATEWAY =
  import.meta.env.VITE_IPFS_GATEWAY || "https://gateway.pinata.cloud/ipfs/";

const ENVELOPE_NAME = "spoovault-beneficiary-key-envelope";

export interface KeyEnvelopePayload {
  version: number;
  type: "beneficiary_key_envelope";
  app: "SpooVault";
  contract: string;
  chainId: number;
  vaultId: number;
  documentId: number;
  beneficiary: string;
  issuedBy: string;
  issuedAt: string;
  key: string;
}

interface PinRow {
  ipfs_pin_hash?: string;
  date_pinned?: string;
  metadata?: {
    name?: string;
    keyvalues?: Record<string, string>;
  };
}

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

const normalizeAddress = (value: string): string => value.trim().toLowerCase();

const hashAddress = (value: string): string =>
  CryptoJS.SHA256(normalizeAddress(value)).toString();

const getGatewayUrl = (hash: string): string => `${IPFS_GATEWAY}${hash}`;

const sendKeyEnvelope = async (
  payload: KeyEnvelopePayload
): Promise<string> => {
  if (!isConfigured()) {
    throw new Error("IPFS is not configured");
  }

  const beneficiary = normalizeAddress(payload.beneficiary);
  const contract = normalizeAddress(payload.contract);
  const issuedBy = normalizeAddress(payload.issuedBy);
  const beneficiaryHash = hashAddress(payload.beneficiary);
  const contractHash = hashAddress(payload.contract);
  const issuedByHash = hashAddress(payload.issuedBy);

  const content: KeyEnvelopePayload = {
    ...payload,
    beneficiary,
    contract,
    issuedBy,
  };

  let response;
  if (IPFS_PROXY_URL) {
    const body = JSON.stringify({
      pinataContent: content,
      pinataMetadata: {
        name: ENVELOPE_NAME,
        keyvalues: {
          type: "beneficiary_key_envelope",
          beneficiary: beneficiaryHash,
          contract: contractHash,
          chainId: String(content.chainId),
          documentId: String(content.documentId),
          vaultId: String(content.vaultId),
          issuedBy: issuedByHash,
          issuedAt: content.issuedAt,
        },
      },
    });
    const auth = await signProxyRequest({
      secret: getProxySecret(),
      method: "POST",
      path: "/api/ipfs/pin-json",
      body,
    });
    response = await axios.post(`${IPFS_PROXY_URL}/api/ipfs/pin-json`, body, {
      headers: {
        "Content-Type": "application/json",
        ...auth.headers,
      },
      timeout: 30000,
    });
  } else {
    response = await axios.post(
      `${PINATA_API_URL}/pinning/pinJSONToIPFS`,
      {
        pinataContent: content,
        pinataMetadata: {
          name: ENVELOPE_NAME,
          keyvalues: {
            type: "beneficiary_key_envelope",
            beneficiary: beneficiaryHash,
            contract: contractHash,
            chainId: String(content.chainId),
            documentId: String(content.documentId),
            vaultId: String(content.vaultId),
            issuedBy: issuedByHash,
            issuedAt: content.issuedAt,
          },
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          ...buildAuthHeaders(),
        },
        timeout: 30000,
      }
    );
  }

  const hash = String(response?.data?.IpfsHash || "");
  if (!hash) {
    throw new Error("Failed to publish key envelope");
  }
  return hash;
};

const listEnvelopeHashesForBeneficiary = async (
  beneficiaryAddress: string,
  options?: { limit?: number }
): Promise<string[]> => {
  if (!isConfigured()) {
    throw new Error("IPFS is not configured");
  }

  const target = hashAddress(beneficiaryAddress);
  const maxMatches = Math.max(1, Math.min(options?.limit ?? 30, 100));
  const pageLimit = 100;
  const maxPages = 6;
  const matches: string[] = [];

  for (let page = 0; page < maxPages && matches.length < maxMatches; page++) {
    let response;
    if (IPFS_PROXY_URL) {
      const query = new URLSearchParams({
        status: "pinned",
        pageLimit: String(pageLimit),
        pageOffset: String(page * pageLimit),
      });
      const path = `/api/ipfs/pin-list?${query.toString()}`;
      const auth = await signProxyRequest({
        secret: getProxySecret(),
        method: "GET",
        path,
      });
      response = await axios.get(`${IPFS_PROXY_URL}${path}`, {
        headers: auth.headers,
        timeout: 30000,
      });
    } else {
      response = await axios.get(`${PINATA_API_URL}/data/pinList`, {
        headers: buildAuthHeaders(),
        params: {
          status: "pinned",
          pageLimit,
          pageOffset: page * pageLimit,
        },
        timeout: 30000,
      });
    }

    const rows = Array.isArray(response?.data?.rows)
      ? (response.data.rows as PinRow[])
      : [];
    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const hash = String(row.ipfs_pin_hash || "");
      const metadataName = String(row.metadata?.name || "");
      const keyvalues = row.metadata?.keyvalues || {};
      const rowType = String(keyvalues.type || "");
      const rowBeneficiary = normalizeAddress(
        String(keyvalues.beneficiary || "")
      );
      if (!hash) {
        continue;
      }
      if (metadataName !== ENVELOPE_NAME) {
        continue;
      }
      if (rowType !== "beneficiary_key_envelope") {
        continue;
      }
      if (rowBeneficiary !== target) {
        continue;
      }
      matches.push(hash);
      if (matches.length >= maxMatches) {
        break;
      }
    }
  }

  return matches;
};

const fetchEnvelopeByHash = async (
  hash: string
): Promise<KeyEnvelopePayload | null> => {
  try {
    const response = await axios.get(getGatewayUrl(hash), { timeout: 30000 });
    if (!response?.data || typeof response.data !== "object") {
      return null;
    }
    return response.data as KeyEnvelopePayload;
  } catch {
    return null;
  }
};

const fetchBeneficiaryInbox = async (
  beneficiaryAddress: string,
  options?: { limit?: number }
): Promise<KeyEnvelopePayload[]> => {
  const hashes = await listEnvelopeHashesForBeneficiary(
    beneficiaryAddress,
    options
  );
  if (hashes.length === 0) {
    return [];
  }

  const envelopes = await Promise.all(
    hashes.map((hash) => fetchEnvelopeByHash(hash))
  );
  const normalizedRecipient = normalizeAddress(beneficiaryAddress);

  return envelopes
    .filter((item): item is KeyEnvelopePayload => item !== null)
    .filter(
      (item) => normalizeAddress(item.beneficiary) === normalizedRecipient
    )
    .sort((a, b) => {
      const aTime = Date.parse(a.issuedAt || "");
      const bTime = Date.parse(b.issuedAt || "");
      return (
        (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime)
      );
    });
};

const unpinKeyEnvelope = async (hash: string): Promise<boolean> => {
  return ipfsService.unpin(hash);
};

const listAllKeyEnvelopes = async (options?: {
  limit?: number;
  maxPages?: number;
}): Promise<Array<{ hash: string; row: PinRow }>> => {
  if (!isConfigured()) {
    throw new Error("IPFS is not configured");
  }

  const maxMatches = Math.max(1, Math.min(options?.limit ?? 200, 500));
  const pageLimit = 100;
  const maxPages = options?.maxPages ?? 10;
  const results: Array<{ hash: string; row: PinRow }> = [];

  for (let page = 0; page < maxPages && results.length < maxMatches; page++) {
    let response;
    if (IPFS_PROXY_URL) {
      const query = new URLSearchParams({
        status: "pinned",
        pageLimit: String(pageLimit),
        pageOffset: String(page * pageLimit),
      });
      const path = `/api/ipfs/pin-list?${query.toString()}`;
      const auth = await signProxyRequest({
        secret: getProxySecret(),
        method: "GET",
        path,
      });
      response = await axios.get(`${IPFS_PROXY_URL}${path}`, {
        headers: auth.headers,
        timeout: 30000,
      });
    } else {
      response = await axios.get(`${PINATA_API_URL}/data/pinList`, {
        headers: buildAuthHeaders(),
        params: {
          status: "pinned",
          pageLimit,
          pageOffset: page * pageLimit,
        },
        timeout: 30000,
      });
    }

    const rows = Array.isArray(response?.data?.rows)
      ? (response.data.rows as PinRow[])
      : [];
    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const hash = String(row.ipfs_pin_hash || "");
      const metadataName = String(row.metadata?.name || "");
      const keyvalues = row.metadata?.keyvalues || {};
      const rowType = String(keyvalues.type || "");
      if (
        !hash ||
        metadataName !== ENVELOPE_NAME ||
        rowType !== "beneficiary_key_envelope"
      ) {
        continue;
      }
      results.push({ hash, row });
      if (results.length >= maxMatches) {
        break;
      }
    }
  }

  return results;
};

const findEnvelopeHashesForBeneficiaryAndDoc = async (
  beneficiaryAddress: string,
  documentId: number,
  options?: { limit?: number }
): Promise<string[]> => {
  if (!isConfigured()) {
    throw new Error("IPFS is not configured");
  }

  const targetBeneficiary = hashAddress(beneficiaryAddress);
  const targetDocIdStr = String(documentId);
  const maxMatches = Math.max(1, Math.min(options?.limit ?? 30, 100));
  const pageLimit = 100;
  const maxPages = 6;
  const matches: string[] = [];

  for (let page = 0; page < maxPages && matches.length < maxMatches; page++) {
    let response;
    if (IPFS_PROXY_URL) {
      const query = new URLSearchParams({
        status: "pinned",
        pageLimit: String(pageLimit),
        pageOffset: String(page * pageLimit),
      });
      const path = `/api/ipfs/pin-list?${query.toString()}`;
      const auth = await signProxyRequest({
        secret: getProxySecret(),
        method: "GET",
        path,
      });
      response = await axios.get(`${IPFS_PROXY_URL}${path}`, {
        headers: auth.headers,
        timeout: 30000,
      });
    } else {
      response = await axios.get(`${PINATA_API_URL}/data/pinList`, {
        headers: buildAuthHeaders(),
        params: {
          status: "pinned",
          pageLimit,
          pageOffset: page * pageLimit,
        },
        timeout: 30000,
      });
    }

    const rows = Array.isArray(response?.data?.rows)
      ? (response.data.rows as PinRow[])
      : [];
    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const hash = String(row.ipfs_pin_hash || "");
      const metadataName = String(row.metadata?.name || "");
      const keyvalues = row.metadata?.keyvalues || {};
      const rowType = String(keyvalues.type || "");
      const rowBeneficiary = normalizeAddress(
        String(keyvalues.beneficiary || "")
      );
      const rowDocId = String(keyvalues.documentId || "");
      if (
        !hash ||
        metadataName !== ENVELOPE_NAME ||
        rowType !== "beneficiary_key_envelope"
      ) {
        continue;
      }
      if (rowBeneficiary === targetBeneficiary && rowDocId === targetDocIdStr) {
        matches.push(hash);
        if (matches.length >= maxMatches) {
          break;
        }
      }
    }
  }

  return matches;
};

const unpinEnvelopesForBeneficiaryAndDoc = async (
  beneficiaryAddress: string,
  documentId: number
): Promise<{ unpinned: string[]; failed: string[] }> => {
  const hashes = await findEnvelopeHashesForBeneficiaryAndDoc(
    beneficiaryAddress,
    documentId
  );
  const unpinned: string[] = [];
  const failed: string[] = [];

  for (const hash of hashes) {
    try {
      await unpinKeyEnvelope(hash);
      unpinned.push(hash);
    } catch {
      failed.push(hash);
    }
  }

  return { unpinned, failed };
};

export const keyInboxService = {
  isConfigured,
  sendKeyEnvelope,
  fetchBeneficiaryInbox,
  unpinKeyEnvelope,
  listAllKeyEnvelopes,
  findEnvelopeHashesForBeneficiaryAndDoc,
  unpinEnvelopesForBeneficiaryAndDoc,
  hashAddress,
};
