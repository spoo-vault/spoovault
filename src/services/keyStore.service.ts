const SESSION_PREFIX = "spoovault-doc-key-session-";
const LEGACY_PREFIX = "spoovault-doc-key-";

const getSessionKey = (documentId: number): string =>
  `${SESSION_PREFIX}${documentId}`;
const getLegacyKey = (documentId: number): string =>
  `${LEGACY_PREFIX}${documentId}`;

const canUseStorage = (): boolean => typeof window !== "undefined";

const safeGet = (storage: Storage, key: string): string | null => {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
};

const safeSet = (storage: Storage, key: string, value: string): boolean => {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};

const safeRemove = (storage: Storage, key: string): void => {
  try {
    storage.removeItem(key);
  } catch {
    // ignore storage errors
  }
};

const migrateLegacyKey = (documentId: number): string | null => {
  if (!canUseStorage()) return null;
  const legacyValue = safeGet(window.localStorage, getLegacyKey(documentId));
  if (!legacyValue) {
    return null;
  }

  safeSet(window.sessionStorage, getSessionKey(documentId), legacyValue);
  safeRemove(window.localStorage, getLegacyKey(documentId));
  return legacyValue;
};

/**
 * Stores document decryption keys in sessionStorage only.
 * Legacy localStorage entries are migrated on first read.
 */
export const keyStoreService = {
  get(documentId: number): string | null {
    if (!canUseStorage() || !Number.isFinite(documentId) || documentId <= 0) {
      return null;
    }

    const value = safeGet(window.sessionStorage, getSessionKey(documentId));
    if (value) {
      return value;
    }

    return migrateLegacyKey(documentId);
  },

  set(documentId: number, key: string): boolean {
    if (!canUseStorage() || !Number.isFinite(documentId) || documentId <= 0) {
      return false;
    }

    const normalized = key.trim();
    if (!normalized) {
      return false;
    }

    const didSave = safeSet(
      window.sessionStorage,
      getSessionKey(documentId),
      normalized
    );
    safeRemove(window.localStorage, getLegacyKey(documentId));
    return didSave;
  },

  remove(documentId: number): void {
    if (!canUseStorage() || !Number.isFinite(documentId) || documentId <= 0) {
      return;
    }

    safeRemove(window.sessionStorage, getSessionKey(documentId));
    safeRemove(window.localStorage, getLegacyKey(documentId));
  },
};
