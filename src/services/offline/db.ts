import { openDB, type IDBPDatabase, type DBSchema } from "idb";

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

interface SpooVaultDBSchema extends DBSchema {
  vaults: {
    key: string;
    value: CachedVault;
    indexes: { "account+network": [string, OfflineNetwork] };
  };
  documents: {
    key: string;
    value: CachedDocument;
    indexes: { "account+network": [string, OfflineNetwork] };
  };
  invites: {
    key: number;
    value: CachedInvite;
    indexes: { "account+network": [string, OfflineNetwork] };
  };
  keyring: {
    key: string;
    value: CachedPublicKey;
  };
  actions: {
    key: number;
    value: PendingActionRecord;
    indexes: { "status": PendingActionStatus };
  };
}

const entityKey = (...parts: Array<string | number>): string =>
  parts.map((part) => String(part).toLowerCase()).join("::");

let dbInstancePromise: Promise<IDBPDatabase<SpooVaultDBSchema>> | null = null;
let injectedFactory: IDBFactory | null = null;

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

const getDb = async (): Promise<IDBPDatabase<SpooVaultDBSchema> | null> => {
  const factory = resolveFactory();
  if (!factory) return null;

  if (!dbInstancePromise) {
    dbInstancePromise = openDB<SpooVaultDBSchema>("spoovault-offline", 1, {
      upgrade(db) {
        const vaultsStore = db.createObjectStore("vaults", { keyPath: "key" });
        vaultsStore.createIndex("account+network", ["account", "network"]);

        const docsStore = db.createObjectStore("documents", { keyPath: "key" });
        docsStore.createIndex("account+network", ["account", "network"]);

        const invitesStore = db.createObjectStore("invites", { keyPath: "id", autoIncrement: true });
        invitesStore.createIndex("account+network", ["account", "network"]);

        db.createObjectStore("keyring", { keyPath: "key" });

        const actionsStore = db.createObjectStore("actions", { keyPath: "id", autoIncrement: true });
        actionsStore.createIndex("status", "status");
      },
    }).catch(() => {
      dbInstancePromise = null;
      return null as any;
    });
  }
  return dbInstancePromise;
};

export const __setOfflineDbFactoryForTests = (
  factory: IDBFactory | null,
  _idbKeyRange?: unknown
): void => {
  dbInstancePromise = null;
  injectedFactory = factory;
  memoryVaults.clear();
  memoryDocuments.clear();
  memoryInvites.length = 0;
  memoryKeyring.clear();
  memoryActions.length = 0;
  memoryActionSeq = 1;
};

const now = (): number => Date.now();

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

  const db = await getDb();
  if (!db) {
    rows.forEach((row) => memoryVaults.set(row.key, row));
    return;
  }
  const tx = db.transaction("vaults", "readwrite");
  await Promise.all(rows.map((row) => tx.store.put(row)));
  await tx.done;
};

export const getCachedVaults = async (
  account: string,
  network: OfflineNetwork
): Promise<CachedVault[]> => {
  if (!account) return [];
  const normalizedAccount = account.toLowerCase();

  const db = await getDb();
  if (!db) {
    return [...memoryVaults.values()]
      .filter((row) => row.account === normalizedAccount && row.network === network)
      .sort((a, b) => a.id - b.id);
  }
  const rows = await db.getAllFromIndex("vaults", "account+network", [normalizedAccount, network]);
  return rows.sort((a, b) => a.id - b.id);
};

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

  const db = await getDb();
  if (!db) {
    rows.forEach((row) => memoryDocuments.set(row.key, row));
    return;
  }
  const tx = db.transaction("documents", "readwrite");
  await Promise.all(rows.map((row) => tx.store.put(row)));
  await tx.done;
};

export const getCachedDocuments = async (
  account: string,
  network: OfflineNetwork
): Promise<CachedDocument[]> => {
  if (!account) return [];
  const normalizedAccount = account.toLowerCase();

  const db = await getDb();
  if (!db) {
    return [...memoryDocuments.values()]
      .filter((row) => row.account === normalizedAccount && row.network === network)
      .sort((a, b) => a.id - b.id);
  }
  const rows = await db.getAllFromIndex("documents", "account+network", [normalizedAccount, network]);
  return rows.sort((a, b) => a.id - b.id);
};

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

  const db = await getDb();
  if (!db) {
    memoryInvites.length = 0;
    stamped.forEach((invite) => memoryInvites.push(invite as CachedInvite));
    return;
  }

  const tx = db.transaction("invites", "readwrite");
  const existing = await tx.store.index("account+network").getAll([normalizedAccount, network]);
  await Promise.all(existing.map((row) => row.id && tx.store.delete(row.id)));
  await Promise.all(stamped.map((invite) => tx.store.add(invite as CachedInvite)));
  await tx.done;
};

export const getCachedInvites = async (
  account: string,
  network: OfflineNetwork
): Promise<CachedInvite[]> => {
  if (!account) return [];
  const normalizedAccount = account.toLowerCase();

  const db = await getDb();
  if (!db) {
    return memoryInvites.filter(
      (row) => row.account === normalizedAccount && row.network === network
    );
  }
  return db.getAllFromIndex("invites", "account+network", [normalizedAccount, network]);
};

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

  const db = await getDb();
  if (!db) {
    memoryKeyring.set(row.key, row);
    return;
  }
  await db.put("keyring", row);
};

export const getCachedPublicKey = async (
  address: string,
  network: OfflineNetwork
): Promise<string | null> => {
  if (!address) return null;
  const key = entityKey(address.toLowerCase(), network);

  const db = await getDb();
  if (!db) {
    return memoryKeyring.get(key)?.publicKey ?? null;
  }
  const row = await db.get("keyring", key);
  return row ? row.publicKey : null;
};

export const insertAction = async (
  record: Omit<PendingActionRecord, "id">
): Promise<PendingActionRecord> => {
  const db = await getDb();
  if (!db) {
    const withId: PendingActionRecord = {
      ...record,
      id: memoryActionSeq++,
    };
    memoryActions.push(withId);
    return withId;
  }
  const id = await db.add("actions", record as PendingActionRecord);
  return { ...record, id };
};

export const listActionsByStatus = async (
  statuses: PendingActionStatus[]
): Promise<PendingActionRecord[]> => {
  const db = await getDb();
  if (!db) {
    return memoryActions
      .filter((row) => statuses.includes(row.status))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id ?? 0) - (b.id ?? 0));
  }

  const rows = await db.getAll("actions");
  return rows
    .filter((row) => statuses.includes(row.status))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id ?? 0) - (b.id ?? 0));
};

export const updateAction = async (
  id: number,
  changes: Partial<Omit<PendingActionRecord, "id">>
): Promise<void> => {
  const db = await getDb();
  if (!db) {
    const index = memoryActions.findIndex((row) => row.id === id);
    if (index >= 0) {
      memoryActions[index] = { ...memoryActions[index], ...changes };
    }
    return;
  }
  const existing = await db.get("actions", id);
  if (existing) {
    await db.put("actions", { ...existing, ...changes });
  }
};

export const deleteActionsByStatus = async (
  statuses: PendingActionStatus[]
): Promise<void> => {
  const db = await getDb();
  if (!db) {
    for (let i = memoryActions.length - 1; i >= 0; i -= 1) {
      if (statuses.includes(memoryActions[i].status)) {
        memoryActions.splice(i, 1);
      }
    }
    return;
  }

  const rows = await db.getAll("actions");
  const tx = db.transaction("actions", "readwrite");
  const ids = rows
    .filter((row) => statuses.includes(row.status))
    .map((row) => row.id!)
    .filter(Boolean);
  
  await Promise.all(ids.map(id => tx.store.delete(id)));
  await tx.done;
};

export const countActionsByStatus = async (): Promise<
  Record<PendingActionStatus, number>
> => {
  const db = await getDb();
  const empty = { pending: 0, processing: 0, synced: 0, failed: 0 };

  if (!db) {
    return memoryActions.reduce((acc, row) => {
      acc[row.status] += 1;
      return acc;
    }, empty);
  }

  const rows = await db.getAll("actions");
  return rows.reduce((acc, row) => {
    acc[row.status] += 1;
    return acc;
  }, empty);
};
