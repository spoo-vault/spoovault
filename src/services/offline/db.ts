import Dexie, { type Table } from "dexie";

export type OfflineNetwork = "avalanche" | "stellar";

export interface CachedVault {
  key: string;
  account: string;
  network: OfflineNetwork;
  id: number;
  creator: string;
  name: string;
  description: string;
  guardians: string[];
  approvalThreshold: number;
  isActive: boolean;
  createdAt: number;
  cachedAt: number;
}

export interface CachedDocument {
  key: string;
  account: string;
  network: OfflineNetwork;
  id: number;
  vaultId: number;
  encryptedMetadata: string;
  ipfsHash: string;
  uploadedBy: string;
  uploadedAt: number;
  requiredAccess: number;
  cachedAt: number;
}

export interface CachedInvite {
  id?: number;
  account: string;
  network: OfflineNetwork;
  guardian: string;
  vaultId: number;
  accepted: boolean;
  expiresAt: number;
  cachedAt: number;
}

export interface CachedPublicKey {
  key: string;
  address: string;
  network: OfflineNetwork;
  publicKey: string;
  cachedAt: number;
}

export type PendingActionKind =
  | "create-vault"
  | "create-document-draft"
  | "add-document"
  | "register-public-key"
  | "request-access";

export type PendingActionStatus = "pending" | "processing" | "synced" | "failed";

export interface PendingActionRecord {
  id?: number;
  kind: PendingActionKind;
  label: string;
  payload: unknown;
  status: PendingActionStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  network: OfflineNetwork;
}

interface VaultRow extends CachedVault {}
interface DocumentRow extends CachedDocument {}

class SpooVaultOfflineDB extends Dexie {
  vaults!: Table<VaultRow, string>;
  documents!: Table<DocumentRow, string>;
  invites!: Table<CachedInvite, number>;
  keyring!: Table<CachedPublicKey, string>;
  actions!: Table<PendingActionRecord, number>;

  constructor(options?: { indexedDB?: IDBFactory }) {
    super("spoovault-offline", options);

    this.version(1).stores({
      vaults: "key, account, network, cachedAt, [account+network]",
      documents: "key, account, network, vaultId, cachedAt, [account+network]",
      invites: "++id, account, network, [account+network]",
      keyring: "key, address, network",
      actions: "++id, status, kind, createdAt",
    });
  }
}

const entityKey = (...parts: Array<string | number>): string =>
  parts.map((part) => String(part).toLowerCase()).join("::");

let dexieInstance: SpooVaultOfflineDB | null = null;
let injectedFactory: IDBFactory | null = null;
let injectedKeyRange: unknown = null;

const memoryVaults = new Map<string, CachedVault>();
const memoryDocuments = new Map<string, CachedDocument>();
const memoryInvites: CachedInvite[] = [];
const memoryKeyring = new Map<string, CachedPublicKey>();
const memoryActions: PendingActionRecord[] = [];
let memoryActionSeq = 1;

const resolveFactory = (): IDBFactory | undefined => {
  if (injectedFactory) return injectedFactory;
  return typeof globalThis.indexedDB !== "undefined"
    ? globalThis.indexedDB
    : undefined;
};

const getDb = (): SpooVaultOfflineDB | null => {
  const factory = resolveFactory();
  if (!factory) return null;

  if (!dexieInstance) {
    try {
      const keyRange =
        injectedKeyRange ??
        (typeof globalThis.IDBKeyRange !== "undefined"
          ? globalThis.IDBKeyRange
          : undefined);
      dexieInstance = new SpooVaultOfflineDB({
        indexedDB: factory,
        IDBKeyRange: keyRange,
      } as never);
    } catch {
      return null;
    }
  }
  return dexieInstance;
};

/**
 * Test-only hook: swap the IndexedDB factory backing the offline database.
 * Passing null forces the in-memory fallback used by non-browser environments.
 */
export const __setOfflineDbFactoryForTests = (
  factory: IDBFactory | null,
  idbKeyRange?: unknown
): void => {
  if (dexieInstance) {
    try {
      dexieInstance.close();
    } catch {
      // ignore close errors on stale connections
    }
  }
  dexieInstance = null;
  injectedFactory = factory;
  injectedKeyRange = idbKeyRange ?? null;
  memoryVaults.clear();
  memoryDocuments.clear();
  memoryInvites.length = 0;
  memoryKeyring.clear();
  memoryActions.length = 0;
  memoryActionSeq = 1;
};

const now = (): number => Date.now();

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

export const putVaults = async (
  account: string,
  network: OfflineNetwork,
  vaults: Array<Omit<CachedVault, "key" | "account" | "network" | "cachedAt">>
): Promise<void> => {
  if (!account) return;
  const normalizedAccount = account.toLowerCase();
  const rows: CachedVault[] = vaults.map((vault) => ({
    ...vault,
    guardians: [...(vault.guardians ?? [])],
    key: entityKey(normalizedAccount, network, vault.id),
    account: normalizedAccount,
    network,
    cachedAt: now(),
  }));

  const db = getDb();
  if (!db) {
    rows.forEach((row) => memoryVaults.set(row.key, row));
    return;
  }
  await db.vaults.bulkPut(rows);
};

export const getCachedVaults = async (
  account: string,
  network: OfflineNetwork
): Promise<CachedVault[]> => {
  if (!account) return [];
  const normalizedAccount = account.toLowerCase();

  const db = getDb();
  if (!db) {
    return [...memoryVaults.values()]
      .filter(
        (row) => row.account === normalizedAccount && row.network === network
      )
      .sort((a, b) => a.id - b.id);
  }
  return db.vaults
    .where("[account+network]")
    .equals([normalizedAccount, network])
    .toArray()
    .then((rows) => rows.sort((a, b) => a.id - b.id));
};

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const putDocuments = async (
  account: string,
  network: OfflineNetwork,
  documents: Array<Omit<CachedDocument, "key" | "account" | "network" | "cachedAt">>
): Promise<void> => {
  if (!account) return;
  const normalizedAccount = account.toLowerCase();
  const rows: CachedDocument[] = documents.map((doc) => ({
    ...doc,
    key: entityKey(normalizedAccount, network, doc.id),
    account: normalizedAccount,
    network,
    cachedAt: now(),
  }));

  const db = getDb();
  if (!db) {
    rows.forEach((row) => memoryDocuments.set(row.key, row));
    return;
  }
  await db.documents.bulkPut(rows);
};

export const getCachedDocuments = async (
  account: string,
  network: OfflineNetwork
): Promise<CachedDocument[]> => {
  if (!account) return [];
  const normalizedAccount = account.toLowerCase();

  const db = getDb();
  if (!db) {
    return [...memoryDocuments.values()]
      .filter(
        (row) => row.account === normalizedAccount && row.network === network
      )
      .sort((a, b) => a.id - b.id);
  }
  return db.documents
    .where("[account+network]")
    .equals([normalizedAccount, network])
    .toArray()
    .then((rows) => rows.sort((a, b) => a.id - b.id));
};

// ---------------------------------------------------------------------------
// Guardian invites
// ---------------------------------------------------------------------------

export const putInvites = async (
  account: string,
  network: OfflineNetwork,
  invites: Array<Omit<CachedInvite, "id" | "account" | "network" | "cachedAt">>
): Promise<void> => {
  if (!account) return;
  const normalizedAccount = account.toLowerCase();
  const stamped = invites.map((invite) => ({
    ...invite,
    account: normalizedAccount,
    network,
    cachedAt: now(),
  }));

  const db = getDb();
  if (!db) {
    memoryInvites.length = 0;
    stamped.forEach((invite) => memoryInvites.push(invite));
    return;
  }

  await db.transaction("rw", db.invites, async () => {
    const existing = await db.invites
      .where("[account+network]")
      .equals([normalizedAccount, network])
      .toArray();
    await db.invites.bulkDelete(existing.map((row) => row.id!).filter(Boolean));
    await db.invites.bulkAdd(stamped);
  });
};

export const getCachedInvites = async (
  account: string,
  network: OfflineNetwork
): Promise<CachedInvite[]> => {
  if (!account) return [];
  const normalizedAccount = account.toLowerCase();

  const db = getDb();
  if (!db) {
    return memoryInvites.filter(
      (row) => row.account === normalizedAccount && row.network === network
    );
  }
  return db.invites
    .where("[account+network]")
    .equals([normalizedAccount, network])
    .toArray();
};

// ---------------------------------------------------------------------------
// Public key ring (address -> registered on-chain public key)
// ---------------------------------------------------------------------------

export const putPublicKey = async (
  address: string,
  publicKey: string,
  network: OfflineNetwork
): Promise<void> => {
  if (!address) return;
  const normalized = address.toLowerCase();
  const row: CachedPublicKey = {
    key: entityKey(normalized, network),
    address: normalized,
    network,
    publicKey: publicKey ?? "",
    cachedAt: now(),
  };

  const db = getDb();
  if (!db) {
    memoryKeyring.set(row.key, row);
    return;
  }
  await db.keyring.put(row);
};

export const getCachedPublicKey = async (
  address: string,
  network: OfflineNetwork
): Promise<string | null> => {
  if (!address) return null;
  const key = entityKey(address.toLowerCase(), network);

  const db = getDb();
  if (!db) {
    return memoryKeyring.get(key)?.publicKey ?? null;
  }
  const row = await db.keyring.get(key);
  return row ? row.publicKey : null;
};

// ---------------------------------------------------------------------------
// Pending action queue
// ---------------------------------------------------------------------------

export const insertAction = async (
  record: Omit<PendingActionRecord, "id">
): Promise<PendingActionRecord> => {
  const db = getDb();
  if (!db) {
    const withId: PendingActionRecord = {
      ...record,
      id: memoryActionSeq++,
    };
    memoryActions.push(withId);
    return withId;
  }
  const id = await db.actions.add(record as PendingActionRecord);
  return { ...record, id };
};

export const listActionsByStatus = async (
  statuses: PendingActionStatus[]
): Promise<PendingActionRecord[]> => {
  const db = getDb();
  if (!db) {
    return memoryActions
      .filter((row) => statuses.includes(row.status))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id ?? 0) - (b.id ?? 0));
  }

  const rows = await db.actions.toArray();
  return rows
    .filter((row) => statuses.includes(row.status))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id ?? 0) - (b.id ?? 0));
};

export const updateAction = async (
  id: number,
  changes: Partial<Omit<PendingActionRecord, "id">>
): Promise<void> => {
  const db = getDb();
  if (!db) {
    const index = memoryActions.findIndex((row) => row.id === id);
    if (index >= 0) {
      memoryActions[index] = { ...memoryActions[index], ...changes };
    }
    return;
  }
  await db.actions.update(id, changes);
};

export const deleteActionsByStatus = async (
  statuses: PendingActionStatus[]
): Promise<void> => {
  const db = getDb();
  if (!db) {
    for (let i = memoryActions.length - 1; i >= 0; i -= 1) {
      if (statuses.includes(memoryActions[i].status)) {
        memoryActions.splice(i, 1);
      }
    }
    return;
  }

  const rows = await db.actions.toArray();
  const ids = rows
    .filter((row) => statuses.includes(row.status))
    .map((row) => row.id!)
    .filter(Boolean);
  await db.actions.bulkDelete(ids);
};

export const countActionsByStatus = async (): Promise<
  Record<PendingActionStatus, number>
> => {
  const db = getDb();
  const empty = { pending: 0, processing: 0, synced: 0, failed: 0 };

  if (!db) {
    return memoryActions.reduce((acc, row) => {
      acc[row.status] += 1;
      return acc;
    }, empty);
  }

  const rows = await db.actions.toArray();
  return rows.reduce((acc, row) => {
    acc[row.status] += 1;
    return acc;
  }, empty);
};
