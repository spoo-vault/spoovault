/**
 * Multi-storage provider adapter for permanent vault document archival.
 *
 * Pinata IPFS pinning is a single point of failure (expired subscriptions,
 * offline gateways). This module adds Filecoin (via Lighthouse.storage) and
 * Arweave (via Irys/Bundlr nodes) as permanent backup providers:
 *   1. uploadToProvider / backupDocument — replicate encrypted payloads to
 *      every configured secondary provider after the primary IPFS pin
 *   2. checkProofOfStorage — inspect Filecoin storage deals / Arweave
 *      transaction status to confirm permanent archival
 *   3. fetchDocument — read via the IPFS gateway pool first, then fall back
 *      to Arweave and Filecoin when every IPFS gateway fails
 *
 * Backup references are persisted locally keyed by the primary IPFS CID so
 * any retrieval path can locate the archival copies without contract changes.
 */

import { ipfsService } from "./ipfs.service";
import { encryptFileStream, collectStream } from "./streamingCrypto.service";

export type StorageProviderId = "ipfs" | "filecoin" | "arweave";

export const PRIMARY_STORAGE_PROVIDER: StorageProviderId = "ipfs";
export const DEFAULT_BACKUP_PROVIDERS: StorageProviderId[] = [
  "filecoin",
  "arweave",
];

const LIGHTHOUSE_UPLOAD_URL = "https://upload.lighthouse.storage/api/v0/upload";
const LIGHTHOUSE_DEAL_STATUS_URL =
  "https://api.lighthouse.storage/api/lighthouse/get_deal_status";
const DEFAULT_LIGHTHOUSE_GATEWAY = "https://gateway.lighthouse.storage/ipfs/";
const DEFAULT_ARWEAVE_NODE = "https://node2.irys.xyz";
const DEFAULT_ARWEAVE_GATEWAY = "https://arweave.net/";

export const BACKUP_REFS_STORAGE_KEY = "spoovault-storage-backup-refs-v1";

export type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export interface StorageRefRecord {
  arweave?: string;
  filecoin?: string;
}

export interface StorageUploadResult {
  provider: StorageProviderId;
  reference: string;
  size: number;
  /** True when the provider archives permanently by design (Filecoin deals / Arweave chain). */
  permanent: boolean;
}

export interface StorageProofStatus {
  provider: StorageProviderId;
  reference: string;
  /** Proof of storage confirmed (Filecoin deal active / Arweave tx confirmed). */
  archived: boolean;
  detail?: string;
  raw?: unknown;
}

export interface StorageUploadFailure {
  provider: StorageProviderId;
  error: string;
}

export interface BackupDocumentOptions {
  ipfsHash: string;
  filename?: string;
  /** Plaintext payload + hex key — encrypted here before replication. */
  plaintext?: Blob | Uint8Array | ArrayBuffer;
  keyHex?: string;
  /** Pre-encrypted payload, used directly when provided. */
  ciphertext?: Uint8Array | Blob;
  providers?: StorageProviderId[];
  signal?: AbortSignal;
}

export interface BackupDocumentReport {
  ipfsHash: string;
  backups: StorageUploadResult[];
  failures: StorageUploadFailure[];
}

interface RefStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export class StorageProviderFetchError extends Error {
  readonly code = "STORAGE_FETCH_FAILED" as const;

  constructor(
    public readonly reference: string,
    public readonly attempts: string[]
  ) {
    super(
      `Failed to fetch stored content (${reference}) from all providers. ${attempts.join(
        "; "
      )}`
    );
    this.name = "StorageProviderFetchError";
  }
}

const envString = (name: string): string | undefined => {
  const value = import.meta.env[name as keyof ImportMetaEnv];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const normalizeTrailingSlash = (url: string): string =>
  url.endsWith("/") ? url : `${url}/`;

const toBlob = (data: Uint8Array | Blob): Blob =>
  data instanceof Blob ? data : new Blob([data as BlobPart]);

const parseResponseBody = async (
  response: Response
): Promise<Record<string, unknown> | string | unknown[]> => {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const extractDealList = (raw: unknown): unknown[] => {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const candidate =
      record.dealInfo ?? record.deals ?? record.data ?? record.dealData;
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
};

const isActiveFilecoinDeal = (deal: unknown): boolean => {
  if (!deal || typeof deal !== "object") {
    return false;
  }
  const record = deal as Record<string, unknown>;
  const rawStatus =
    record.status ??
    record.dealStatus ??
    record.state ??
    record.Status ??
    record.DealStatus;
  const status =
    typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : "";
  if (!status) {
    return false;
  }
  return [
    "active",
    "dealactive",
    "storageactive",
    "sealing",
    "proving",
  ].includes(status);
};

const hasConfirmedArweaveBlock = (raw: unknown): boolean => {
  if (!raw || typeof raw !== "object") {
    return false;
  }
  const record = raw as Record<string, unknown>;
  const confirmed = record.confirmed;
  if (confirmed && typeof confirmed === "object") {
    const blockHeight = Number(
      (confirmed as Record<string, unknown>).block_height ??
        (confirmed as Record<string, unknown>).blockHeight
    );
    return Number.isFinite(blockHeight) && blockHeight > 0;
  }
  const blockHeight = Number(record.block_height ?? record.blockHeight);
  return Number.isFinite(blockHeight) && blockHeight > 0;
};

export interface StorageProviderServiceOptions {
  fetchFn?: FetchLike;
  lighthouseApiKey?: string;
  lighthouseGatewayUrl?: string;
  arweaveNodeUrl?: string;
  arweaveGatewayUrl?: string;
  backupProviders?: StorageProviderId[];
  refStore?: RefStore;
}

export const createStorageProviderService = (
  options: StorageProviderServiceOptions = {}
) => {
  const fetchFn: FetchLike = options.fetchFn ?? ((input, init) => fetch(input, init));

  const getLighthouseApiKey = (): string =>
    options.lighthouseApiKey ?? envString("VITE_LIGHTHOUSE_API_KEY") ?? "";

  const getLighthouseGateway = (): string =>
    normalizeTrailingSlash(
      options.lighthouseGatewayUrl ??
        envString("VITE_LIGHTHOUSE_GATEWAY_URL") ??
        DEFAULT_LIGHTHOUSE_GATEWAY
    );

  const getArweaveNodeUrl = (): string =>
    normalizeTrailingSlash(
      options.arweaveNodeUrl ??
        envString("VITE_ARWEAVE_NODE_URL") ??
        DEFAULT_ARWEAVE_NODE
    );

  const getArweaveGateway = (): string =>
    normalizeTrailingSlash(
      options.arweaveGatewayUrl ??
        envString("VITE_ARWEAVE_GATEWAY_URL") ??
        DEFAULT_ARWEAVE_GATEWAY
    );

  const getConfiguredBackupProviders = (): StorageProviderId[] => {
    let requested = options.backupProviders;
    if (!requested) {
      const raw = envString("VITE_BACKUP_STORAGE_PROVIDERS");
      if (raw !== undefined) {
        requested = raw
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter((item): item is StorageProviderId =>
            item === "filecoin" || item === "arweave"
          );
      }
    }
    const candidates = requested ?? DEFAULT_BACKUP_PROVIDERS;
    return candidates.filter(isConfigured);
  };

  const isConfigured = (provider: StorageProviderId): boolean => {
    switch (provider) {
      case "ipfs":
        return ipfsService.isConfigured();
      case "filecoin":
        return !!getLighthouseApiKey();
      case "arweave":
        return true;
      default:
        return false;
    }
  };

  const listProviders = (): StorageProviderId[] => [
    PRIMARY_STORAGE_PROVIDER,
    ...DEFAULT_BACKUP_PROVIDERS,
  ];

  const uploadToProvider = async (
    provider: StorageProviderId,
    data: Uint8Array | Blob,
    filename: string,
    signal?: AbortSignal
  ): Promise<StorageUploadResult> => {
    if (!isConfigured(provider)) {
      throw new Error(`Storage provider ${provider} is not configured`);
    }

    if (provider === "filecoin") {
      const form = new FormData();
      form.append("file", toBlob(data), filename);
      const response = await fetchFn(LIGHTHOUSE_UPLOAD_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${getLighthouseApiKey()}` },
        body: form,
        signal,
      });
      const payload = await parseResponseBody(response);
      const hash =
        (payload as Record<string, unknown>)?.Hash ??
        (payload as Record<string, unknown>)?.hash;
      if (!response.ok || typeof hash !== "string" || !hash) {
        throw new Error(
          `Filecoin upload failed (${response.status}): ${
            typeof payload === "string"
              ? payload.slice(0, 200)
              : JSON.stringify(payload).slice(0, 200)
          }`
        );
      }
      const size =
        Number((payload as Record<string, unknown>).Size) ||
        toBlob(data).size;
      return { provider, reference: hash, size, permanent: true };
    }

    if (provider === "arweave") {
      const response = await fetchFn(`${getArweaveNodeUrl()}tx`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: toBlob(data),
        signal,
      });
      const payload = await parseResponseBody(response);
      const id =
        typeof payload === "string"
          ? payload.trim()
          : String(
              (payload as Record<string, unknown>)?.id ??
                (payload as Record<string, unknown>)?.transactionId ??
                ""
            ).trim();
      if (!response.ok || !id) {
        throw new Error(
          `Arweave upload failed (${response.status}): ${
            typeof payload === "string"
              ? payload.slice(0, 200)
              : JSON.stringify(payload).slice(0, 200)
          }`
        );
      }
      return {
        provider,
        reference: id,
        size: toBlob(data).size,
        permanent: true,
      };
    }

    throw new Error(`Provider ${provider} is the primary IPFS pin; use ipfsService`);
  };

  const checkProofOfStorage = async (
    provider: StorageProviderId,
    reference: string
  ): Promise<StorageProofStatus> => {
    const base = { provider, reference };
    if (!reference) {
      return { ...base, archived: false, detail: "missing reference" };
    }

    if (provider === "filecoin") {
      try {
        const response = await fetchFn(
          `${LIGHTHOUSE_DEAL_STATUS_URL}?cid=${encodeURIComponent(reference)}`
        );
        if (!response.ok) {
          return {
            ...base,
            archived: false,
            detail: `deal status HTTP ${response.status}`,
          };
        }
        const raw = await parseResponseBody(response);
        const deals = extractDealList(raw);
        const activeDeals = deals.filter(isActiveFilecoinDeal);
        return {
          ...base,
          archived: activeDeals.length > 0,
          detail:
            activeDeals.length > 0
              ? undefined
              : deals.length > 0
                ? "Filecoin deals found, but none are active yet"
                : "no Filecoin storage deals found for CID",
          raw,
        };
      } catch (error) {
        return {
          ...base,
          archived: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (provider === "arweave") {
      try {
        const response = await fetchFn(
          `${getArweaveGateway()}tx/${encodeURIComponent(reference)}/status`
        );
        if (!response.ok) {
          return {
            ...base,
            archived: false,
            detail: `tx status HTTP ${response.status}`,
          };
        }
        const raw = await parseResponseBody(response);
        const status = Number((raw as Record<string, unknown>)?.status);
        const confirmed = status === 200 && hasConfirmedArweaveBlock(raw);
        return {
          ...base,
          archived: confirmed,
          detail:
            confirmed
              ? undefined
              : status === 200
                ? "Arweave tx accepted but not anchored in a block yet"
                : `Arweave tx not confirmed yet (status ${status})`,
          raw,
        };
      } catch (error) {
        return {
          ...base,
          archived: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (provider === "ipfs") {
      try {
        const response = await ipfsService.fetchFile(reference);
        return {
          ...base,
          archived: response.ok,
          detail: response.ok ? undefined : `gateway HTTP ${response.status}`,
        };
      } catch (error) {
        return {
          ...base,
          archived: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return { ...base, archived: false, detail: "unknown provider" };
  };

  // ── Backup reference registry ────────────────────────────────────────────

  const getRefStore = (): RefStore =>
    options.refStore ??
    (typeof window !== "undefined"
      ? window.localStorage
      : {
          getItem: () => null,
          setItem: () => undefined,
        });

  const readAllRefs = (): Record<string, StorageRefRecord> => {
    try {
      const raw = getRefStore().getItem(BACKUP_REFS_STORAGE_KEY);
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, StorageRefRecord>)
        : {};
    } catch {
      return {};
    }
  };

  const writeAllRefs = (refs: Record<string, StorageRefRecord>): void => {
    getRefStore().setItem(BACKUP_REFS_STORAGE_KEY, JSON.stringify(refs));
  };

  const getBackupRefs = (ipfsHash: string): StorageRefRecord | null => {
    const refs = readAllRefs();
    return refs[ipfsHash] ?? null;
  };

  const recordBackupRefs = (
    ipfsHash: string,
    refs: StorageRefRecord
  ): StorageRefRecord => {
    const all = readAllRefs();
    const merged: StorageRefRecord = {
      ...(all[ipfsHash] ?? {}),
      ...(refs.arweave ? { arweave: refs.arweave } : {}),
      ...(refs.filecoin ? { filecoin: refs.filecoin } : {}),
    };
    all[ipfsHash] = merged;
    writeAllRefs(all);
    return merged;
  };

  // ── Automated fallback (replication) upload ─────────────────────────────

  const resolveCiphertext = async (
    opts: BackupDocumentOptions
  ): Promise<{ bytes: Uint8Array | Blob }> => {
    if (opts.ciphertext) {
      return { bytes: opts.ciphertext };
    }
    if (opts.plaintext && opts.keyHex) {
      const source =
        opts.plaintext instanceof Blob
          ? opts.plaintext
          : new Blob([opts.plaintext as BlobPart]);
      // Backup providers (Filecoin/Arweave) require Blob — buffering is unavoidable.
      // Warn for large files since this runs in the background after the primary streaming upload.
      if (source.size > 500 * 1024 * 1024) {
        console.warn(
          `[storageProvider] Backup replication buffering ${(source.size / 1024 / 1024).toFixed(0)}MB ciphertext in memory. ` +
          `Primary upload streamed efficiently; this runs in the background.`
        );
      }
      const encryptedStream = await encryptFileStream(source, opts.keyHex);
      return { bytes: await collectStream(encryptedStream) };
    }
    throw new Error("backupDocument requires ciphertext or plaintext+keyHex");
  };

  const backupDocument = async (
    opts: BackupDocumentOptions
  ): Promise<BackupDocumentReport> => {
    if (!opts.ipfsHash) {
      throw new Error("backupDocument requires the primary ipfsHash");
    }
    const providers =
      opts.providers ?? getConfiguredBackupProviders();
    const report: BackupDocumentReport = {
      ipfsHash: opts.ipfsHash,
      backups: [],
      failures: [],
    };
    if (providers.length === 0) {
      return report;
    }

    const { bytes } = await resolveCiphertext(opts);
    const filename = opts.filename || "document.svsc";

    for (const provider of providers) {
      try {
        const result = await uploadToProvider(
          provider,
          bytes,
          filename,
          opts.signal
        );
        report.backups.push(result);
        recordBackupRefs(opts.ipfsHash, {
          [provider]: result.reference,
        });
      } catch (error) {
        report.failures.push({
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return report;
  };

  // ── Fallback retrieval ───────────────────────────────────────────────────

  const fetchFromProvider = async (
    provider: Exclude<StorageProviderId, "ipfs">,
    reference: string,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      provider === "arweave"
        ? `${getArweaveGateway()}${encodeURIComponent(reference)}`
        : `${getLighthouseGateway()}${encodeURIComponent(reference)}`;
    const response = await fetchFn(url, { method: "GET", ...init });
    if (!response.ok) {
      throw new Error(`${provider} fetch HTTP ${response.status}`);
    }
    return response;
  };

  const fetchDocument = async (
    ipfsHash: string,
    init?: RequestInit,
    decoyCids?: string[]
  ): Promise<Response> => {
    if (!ipfsHash) {
      throw new Error("IPFS CID is required");
    }
    const attempts: string[] = [];

    try {
      // Routes through PIR when VITE_PIR_ENABLED is set; a no-op passthrough
      // to the plain gateway fetch otherwise. `decoyCids` (e.g. sibling
      // documents in the same vault) let PIR batch real, indistinguishable
      // decoys alongside the real request.
      return await ipfsService.fetchFileWithPIR(ipfsHash, init, decoyCids);
    } catch (error) {
      attempts.push(
        `ipfs -> ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const refs = getBackupRefs(ipfsHash) ?? {};
    const order: Array<Exclude<StorageProviderId, "ipfs">> = [
      "arweave",
      "filecoin",
    ];
    for (const provider of order) {
      const reference = refs[provider];
      if (!reference) {
        continue;
      }
      try {
        return await fetchFromProvider(provider, reference, init);
      } catch (error) {
        attempts.push(
          `${provider} -> ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    throw new StorageProviderFetchError(ipfsHash, attempts);
  };

  const verifyArchival = async (
    ipfsHash: string
  ): Promise<{
    ipfsHash: string;
    statuses: Partial<Record<StorageProviderId, StorageProofStatus>>;
  }> => {
    const refs = getBackupRefs(ipfsHash) ?? {};
    const statuses: Partial<Record<StorageProviderId, StorageProofStatus>> = {};

    const checks: Array<Promise<void>> = [];
    const runCheck = async (
      provider: StorageProviderId,
      reference: string
    ): Promise<void> => {
      statuses[provider] = await checkProofOfStorage(provider, reference);
    };

    checks.push(runCheck(PRIMARY_STORAGE_PROVIDER, ipfsHash));
    for (const provider of ["filecoin", "arweave"] as const) {
      const reference = refs[provider];
      if (reference) {
        checks.push(runCheck(provider, reference));
      }
    }
    await Promise.all(checks);

    return { ipfsHash, statuses };
  };

  return {
    isConfigured,
    listProviders,
    getBackupProviders: getConfiguredBackupProviders,
    uploadToProvider,
    checkProofOfStorage,
    backupDocument,
    getBackupRefs,
    recordBackupRefs,
    fetchFromProvider,
    fetchDocument,
    verifyArchival,
  };
};

export type StorageProviderService = ReturnType<
  typeof createStorageProviderService
>;

export const storageProviderService = createStorageProviderService();
