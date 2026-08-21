import {
  base64ToUint8Array,
  generateECIESKeyPairBase64,
  importECIESPublicKey,
  importECIESPrivateKey,
} from "../utils/crypto";

import { secretsService, PBKDF2_ITERATIONS } from "./secrets.service";

export interface KeyPairRecord {
  account: string;
  publicKey: string;
  encryptedPrivateKey: string;
  createdAt: number;
  updatedAt: number;
  hasPin: boolean;
}

export interface KeyPairBackupPayload {
  version: "spoovault-keyring-backup-v1";
  account: string;
  publicKey: string;
  encryptedPrivateKey: string;
  exportedAt: string;
}

const DB_NAME = "spoovault-keyring";
const DB_VERSION = 1;
const STORE_NAME = "keypairs";

// In-memory session cache for unlocked private keys during the active browser session
const sessionKeyCache = new Map<string, string>();

// Fallback in-memory store for environments without IndexedDB (e.g. Node tests without mock IDB)
const memoryStore = new Map<string, KeyPairRecord>();

const isIndexedDBAvailable = (): boolean => {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
};

const getEffectivePassphrase = (account: string, pinOrPassphrase?: string): { passphrase: string; isCustomPin: boolean } => {
  const trimmed = pinOrPassphrase?.trim();
  if (trimmed) {
    return { passphrase: trimmed, isCustomPin: true };
  }
  // Default account-bound deterministic derivation entropy for seamless zero-prompt mode
  const defaultSalt = `spoovault:keyring:default:${account.toLowerCase()}`;
  return { passphrase: defaultSalt, isCustomPin: false };
};

const openDatabase = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    if (!isIndexedDBAvailable()) {
      reject(new Error("IndexedDB is not available"));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "account" });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error || new Error("Failed to open IndexedDB"));
    };
  });
};

const idbGet = async (account: string): Promise<KeyPairRecord | null> => {
  const normalized = account.toLowerCase();
  if (!isIndexedDBAvailable()) {
    return memoryStore.get(normalized) || null;
  }

  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(normalized);

      request.onsuccess = () => {
        resolve(request.result || null);
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  } catch {
    return memoryStore.get(normalized) || null;
  }
};

const idbPut = async (record: KeyPairRecord): Promise<void> => {
  const normalized = record.account.toLowerCase();
  record.account = normalized;

  if (!isIndexedDBAvailable()) {
    memoryStore.set(normalized, record);
    return;
  }

  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(record);

      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  } catch {
    memoryStore.set(normalized, record);
  }
};

const idbDelete = async (account: string): Promise<void> => {
  const normalized = account.toLowerCase();
  if (!isIndexedDBAvailable()) {
    memoryStore.delete(normalized);
    return;
  }

  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(normalized);

      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  } catch {
    memoryStore.delete(normalized);
  }
};

const idbGetAllKeys = async (): Promise<string[]> => {
  if (!isIndexedDBAvailable()) {
    return Array.from(memoryStore.keys());
  }

  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAllKeys();

      request.onsuccess = () => {
        resolve((request.result as string[]) || []);
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  } catch {
    return Array.from(memoryStore.keys());
  }
};

export const clientKeyringService = {
  /**
   * Check if a keypair exists locally in IndexedDB for the given account.
   */
  async hasKeyPair(account: string): Promise<boolean> {
    if (!account) return false;
    const record = await idbGet(account);
    return !!record?.publicKey && !!record?.encryptedPrivateKey;
  },

  /**
   * Retrieve the stored keypair metadata record for an account.
   */
  async getKeyPairRecord(account: string): Promise<KeyPairRecord | null> {
    if (!account) return null;
    return idbGet(account);
  },

  /**
   * Retrieve the stored public key string (Base64 SPKI) without requiring PIN decryption.
   */
  async getStoredPublicKey(account: string): Promise<string | null> {
    if (!account) return null;
    const record = await idbGet(account);
    return record?.publicKey || null;
  },

  /**
   * Generate a new Web Crypto ECDH P-256 keypair, encrypt the private key with user PIN/passphrase,
   * and store in IndexedDB. Caches the unlocked private key in memory for the active session.
   */
  async generateAndSaveKeyPair(
    account: string,
    pinOrPassphrase?: string
  ): Promise<{ publicKey: string }> {
    if (!account) {
      throw new Error("Account address is required to generate a keypair");
    }

    const normalized = account.toLowerCase();
    const { publicKey, privateKey } = await generateECIESKeyPairBase64();
    const { passphrase, isCustomPin } = getEffectivePassphrase(normalized, pinOrPassphrase);

    // Encrypt private key with PBKDF2-SHA256 (600,000 iterations) + AES-256-GCM
    const encryptedPrivateKey = await secretsService.encryptWithPassphrase(
      privateKey,
      passphrase,
      PBKDF2_ITERATIONS
    );

    const now = Date.now();
    const record: KeyPairRecord = {
      account: normalized,
      publicKey,
      encryptedPrivateKey,
      createdAt: now,
      updatedAt: now,
      hasPin: isCustomPin,
    };

    await idbPut(record);
    sessionKeyCache.set(normalized, privateKey);

    return { publicKey };
  },

  /**
   * Save an existing private and public key pair into the IndexedDB keyring.
   */
  async saveKeyPair(
    account: string,
    publicKey: string,
    privateKey: string,
    pinOrPassphrase?: string
  ): Promise<void> {
    if (!account || !publicKey || !privateKey) {
      throw new Error("Account, publicKey, and privateKey are required");
    }

    // Validate keys by attempting to import them
    await importECIESPublicKey(publicKey);
    await importECIESPrivateKey(privateKey);

    const normalized = account.toLowerCase();
    const { passphrase, isCustomPin } = getEffectivePassphrase(normalized, pinOrPassphrase);

    const encryptedPrivateKey = await secretsService.encryptWithPassphrase(
      privateKey,
      passphrase,
      PBKDF2_ITERATIONS
    );

    const existing = await idbGet(normalized);
    const now = Date.now();
    const record: KeyPairRecord = {
      account: normalized,
      publicKey,
      encryptedPrivateKey,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      hasPin: isCustomPin,
    };

    await idbPut(record);
    sessionKeyCache.set(normalized, privateKey);
  },

  /**
   * Retrieve and decrypt the client-side private key (Base64 PKCS#8) from IndexedDB.
   * If already unlocked in session cache, returns immediately.
   */
  async getDecryptedPrivateKey(
    account: string,
    pinOrPassphrase?: string
  ): Promise<string> {
    if (!account) {
      throw new Error("Account address is required");
    }

    const normalized = account.toLowerCase();
    const cached = sessionKeyCache.get(normalized);
    if (cached) {
      return cached;
    }

    const record = await idbGet(normalized);
    if (!record || !record.encryptedPrivateKey) {
      throw new Error(
        `No local encryption keypair found for wallet ${account}. Please generate one in your Profile page.`
      );
    }

    const { passphrase } = getEffectivePassphrase(normalized, pinOrPassphrase);

    try {
      const privateKey = await secretsService.decryptWithPassphrase(
        record.encryptedPrivateKey,
        passphrase
      );
      sessionKeyCache.set(normalized, privateKey);
      return privateKey;
    } catch {
      throw new Error(
        record.hasPin
          ? "Incorrect PIN or passphrase. Please verify your PIN."
          : "Failed to decrypt client private key from secure storage."
      );
    }
  },

  /**
   * Check if the private key for an account is currently unlocked in the memory session.
   */
  isUnlocked(account: string): boolean {
    if (!account) return false;
    return sessionKeyCache.has(account.toLowerCase());
  },

  /**
   * Lock an account by removing its decrypted private key from the in-memory session cache.
   */
  lockAccount(account: string): void {
    if (account) {
      sessionKeyCache.delete(account.toLowerCase());
    }
  },

  /**
   * Clear all unlocked session keys from memory.
   */
  clearSessionCache(): void {
    sessionKeyCache.clear();
  },

  /**
   * Delete the keypair for an account from IndexedDB and session cache.
   */
  async deleteKeyPair(account: string): Promise<void> {
    if (!account) return;
    const normalized = account.toLowerCase();
    sessionKeyCache.delete(normalized);
    await idbDelete(normalized);
  },

  /**
   * Export a secure, passphrase-encrypted JSON backup of the keypair.
   */
  async exportKeyBackup(
    account: string,
    backupPassphrase: string,
    currentPin?: string
  ): Promise<string> {
    if (!account) throw new Error("Account is required");
    if (!backupPassphrase || !backupPassphrase.trim()) {
      throw new Error("A secure backup passphrase is required");
    }

    const normalized = account.toLowerCase();
    const privateKey = await this.getDecryptedPrivateKey(normalized, currentPin);
    const publicKey = (await this.getStoredPublicKey(normalized)) || "";

    const encryptedForBackup = await secretsService.encryptWithPassphrase(
      privateKey,
      backupPassphrase.trim(),
      PBKDF2_ITERATIONS
    );

    const backupPayload: KeyPairBackupPayload = {
      version: "spoovault-keyring-backup-v1",
      account: normalized,
      publicKey: publicKey || "",
      encryptedPrivateKey: encryptedForBackup,
      exportedAt: new Date().toISOString(),
    };

    return JSON.stringify(backupPayload, null, 2);
  },

  /**
   * Import a keypair from a passphrase-protected backup file.
   */
  async importKeyBackup(
    account: string,
    backupJson: string,
    backupPassphrase: string,
    newPin?: string
  ): Promise<{ publicKey: string }> {
    if (!account) throw new Error("Account is required");
    if (!backupPassphrase) throw new Error("Backup passphrase is required");

    let parsed: KeyPairBackupPayload;
    try {
      parsed = JSON.parse(backupJson);
    } catch {
      throw new Error("Invalid backup file: Malformed JSON");
    }

    if (parsed.version !== "spoovault-keyring-backup-v1") {
      throw new Error(`Unsupported backup format version: ${parsed.version}`);
    }

    const normalized = account.toLowerCase();
    if (parsed.account && parsed.account.toLowerCase() !== normalized) {
      throw new Error(
        `Backup file was created for wallet ${parsed.account}, but active account is ${account}`
      );
    }

    let decryptedPrivateKey: string;
    try {
      decryptedPrivateKey = await secretsService.decryptWithPassphrase(
        parsed.encryptedPrivateKey,
        backupPassphrase
      );
    } catch {
      throw new Error("Failed to decrypt backup: Incorrect backup passphrase");
    }

    await this.saveKeyPair(
      normalized,
      parsed.publicKey,
      decryptedPrivateKey,
      newPin
    );

    return { publicKey: parsed.publicKey };
  },

  /**
   * List all accounts currently stored in the keyring.
   */
  async listAccounts(): Promise<string[]> {
    return idbGetAllKeys();
  },

  /**
   * Return the accounts that currently have a decrypted private key held in
   * the in-memory session cache.
   */
  getUnlockedAccounts(): string[] {
    return Array.from(sessionKeyCache.keys());
  },

  /**
   * Return the raw bytes of a currently-cached decrypted private key (Base64
   * decoded), or null when the account is not unlocked. Used by the session
   * lock manager to zero key material from memory on lock.
   */
  getCachedPrivateKeyBytes(account: string): Uint8Array | null {
    if (!account) return null;
    const cached = sessionKeyCache.get(account.toLowerCase());
    if (!cached) return null;
    try {
      return base64ToUint8Array(cached);
    } catch {
      return null;
    }
  },
};
