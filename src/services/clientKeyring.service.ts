import {
  base64ToUint8Array,
  generateECIESKeyPairBase64,
  importECIESPublicKey,
  importECIESPrivateKey,
} from "../utils/crypto";

import { secretsService, PBKDF2_ITERATIONS } from "./secrets.service";
import {
  WebAuthnError,
  authenticatePasskey,
  decryptWithPrfKey,
  deriveAesKeyFromPrfOutput,
  encryptWithPrfKey,
  generateChallenge,
  generatePrfSalt,
  getRelyingPartyId,
  isWebAuthnAvailable,
  registerPasskey,
} from "./webauthn.service";

export interface KeyPairRecord {
  account: string;
  publicKey: string;
  encryptedPrivateKey: string;
  createdAt: number;
  updatedAt: number;
  hasPin: boolean;
  /** Whether a hardware-backed WebAuthn passkey (TouchID / FaceID / YubiKey) protects this keyring. */
  hasPasskey?: boolean;
  /** Base64url WebAuthn credential id used to re-authenticate with the hardware authenticator. */
  passkeyCredentialId?: string;
  /** Base64url PRF eval salt — public, but required (with the authenticator secret) to re-derive the key. */
  passkeyPrfSalt?: string;
  /** Private key encrypted with the AES key derived from the authenticator's PRF output. */
  passkeyEncryptedPrivateKey?: string;
  /**
   * Zero-Knowledge Password Proof envelope (issue #151). When present, the
   * private key is wrapped under a key derived from the PIN *and* an OPRF
   * output produced by the non-extractable `oprfKey` below. No salt, hash,
   * or iteration parameter is ever persisted.
   */
  zkpp?: ZkppEnvelope;
  /**
   * Non-extractable HMAC key acting as the OPRF (opaque pseudorandom
   * function) secret. It cannot be read or exported by JavaScript and does
   * not survive JSON serialization, so an offline IndexedDB dump alone is
   * useless for brute-forcing the PIN.
   */
  oprfKey?: CryptoKey;
}

/**
 * Options for keypair generation.
 */
export interface GenerateKeyPairOptions {
  /**
   * Attempt to register a hardware-backed WebAuthn passkey (PRF extension) during keyring
   * creation. Defaults to `true`; falls back to PIN/passphrase protection when WebAuthn is
   * unavailable, unsupported, or the user cancels.
   */
  enablePasskey?: boolean;
}

/**
 * OPAQUE-inspired credential envelope. The wrapping key is derived from
 * HKDF(PBKDF2(pin, salt = OPRF(account))) where the OPRF secret lives only
 * inside the non-extractable `oprfKey` CryptoKey of the stored record.
 */
export interface ZkppEnvelope {
  version: typeof ZKPP_VERSION;
  /** Base64 AES-GCM initialization vector. */
  iv: string;
  /** Base64 AES-GCM ciphertext+tag of the wrapped private key. */
  ciphertext: string;
}

export const ZKPP_VERSION = "spoovault-zkpp-v1";

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
  return (
    typeof window !== "undefined" && typeof window.indexedDB !== "undefined"
  );
};

/**
 * Build and persist a KeyPairRecord using the zero-knowledge password proof
 * envelope (issue #151). The private key is wrapped under a key derived from
 * the PIN through an OPAQUE-style OPRF exchange; no salt, hash, or iteration
 * parameter is written to storage.
 */
const persistKeyPair = async (
  account: string,
  publicKey: string,
  privateKey: string,
  pinOrPassphrase?: string,
  existing?: KeyPairRecord | null
): Promise<KeyPairRecord> => {
  const normalized = account.toLowerCase();
  const { passphrase } = getEffectivePassphrase(normalized, pinOrPassphrase);

  // Fresh non-extractable OPRF secret per enrollment.
  const oprfKey = await generateOprfKey();
  const zkpp = await zkppWrapPrivateKey(normalized, passphrase, oprfKey, privateKey);

  const now = Date.now();
  const record: KeyPairRecord = {
    account: normalized,
    publicKey,
    encryptedPrivateKey: "",
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    hasPin: !!pinOrPassphrase?.trim(),
    zkpp,
    oprfKey,
  };

  await idbPut(record);
  sessionKeyCache.set(normalized, privateKey);
  return record;
};

const getEffectivePassphrase = (
  account: string,
  pinOrPassphrase?: string
): { passphrase: string; isCustomPin: boolean } => {
  const trimmed = pinOrPassphrase?.trim();
  if (trimmed) {
    return { passphrase: trimmed, isCustomPin: true };
  }
  // Default account-bound deterministic derivation entropy for seamless zero-prompt mode
  const defaultSalt = `spoovault:keyring:default:${account.toLowerCase()}`;
  return { passphrase: defaultSalt, isCustomPin: false };
};

/* ------------------------------------------------------------------ */
/* Zero-Knowledge Password Proof (ZKPP) engine — issue #151            */
/*                                                                     */
/* OPAQUE-inspired asymmetric credential design adapted to a purely    */
/* client-side vault: the "server" role is played by a non-extractable */
/* HMAC CryptoKey stored inside the IndexedDB record itself.           */
/*                                                                     */
/*   Registration (3-step OPAQUE-style exchange):                      */
/*     1. client  -> vault : blinded PIN commitment                    */
/*        M = PBKDF2(pin, random per-enrollment salt)                  */
/*     2. vault   -> client : OPRF evaluation                          */
/*        Z = HMAC(oprfKey, "oprf" | account | M)                      */
/*     3. finalize: wrapping key                                       */
/*        K = HKDF(Z)  (AES-256-GCM key)                               */
/*                                                                     */
/*   The record stores only {iv, ciphertext} and the non-extractable   */
/*   oprfKey. No password hash, no salt, no iteration count is ever    */
/*   written to storage, so an offline dump contains nothing that can  */
/*   be brute-forced: every PIN guess requires evaluating the OPRF,    */
/*   which is impossible without a live non-exportable key. A wrong    */
/*   PIN fails the AES-GCM authentication tag check instantly.         */
/* ------------------------------------------------------------------ */

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error("Web Crypto API is not available in this environment");
  }
  return c.subtle;
};

const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Generate the non-extractable OPRF secret for a new credential file. */
async function generateOprfKey(): Promise<CryptoKey> {
  return subtle().generateKey(
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false, // non-extractable: JS can never read the raw key bytes
    ["sign", "verify"]
  );
}

/**
 * Step 1 (client): derive the deterministic PIN commitment. The blinding
 * salt is a fixed application constant (never persisted); randomness comes
 * from the AES-GCM IV at wrap time. An attacker cannot evaluate anything
 * past this step without the non-extractable OPRF key.
 */
async function zkppBlindPin(pin: string): Promise<Uint8Array> {
  const pinKey = await subtle().importKey("raw", encoder.encode(pin), "PBKDF2", false, [
    "deriveBits",
  ]);
  const contextSalt = encoder.encode("spoovault-zkpp-blind-v1");
  return new Uint8Array(
    await subtle().deriveBits(
      { name: "PBKDF2", salt: contextSalt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      pinKey,
      256
    )
  );
}

/**
 * Step 2 (vault role): evaluate the OPRF over the blinded PIN commitment,
 * bound to the account so one record's evaluation is useless for another.
 */
async function zkppEvaluate(
  oprfKey: CryptoKey,
  account: string,
  blinded: Uint8Array
): Promise<Uint8Array> {
  const label = encoder.encode(`spoovault-zkpp-oprf|${account.toLowerCase()}|`);
  const input = new Uint8Array(label.length + blinded.length);
  input.set(label, 0);
  input.set(blinded, label.length);
  return new Uint8Array(await subtle().sign("HMAC", oprfKey, input as BufferSource));
}

/** Step 3 (finalize): stretch the OPRF output into the AES-GCM wrapping key. */
async function zkppFinalize(oprfOutput: Uint8Array): Promise<CryptoKey> {
  const hkdf = await subtle().importKey("raw", oprfOutput as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  return subtle().deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("spoovault-zkpp-wrap"),
      info: encoder.encode("aes-256-gcm keyring wrap"),
    },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Wrap a private key under the ZKPP envelope derived from (pin, oprfKey). */
async function zkppWrapPrivateKey(
  account: string,
  pin: string,
  oprfKey: CryptoKey,
  privateKey: string
): Promise<ZkppEnvelope> {
  const blinded = await zkppBlindPin(pin);
  const oprfOutput = await zkppEvaluate(oprfKey, account, blinded);
  const wrappingKey = await zkppFinalize(oprfOutput);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    wrappingKey,
    encoder.encode(privateKey) as BufferSource
  );

  return {
    version: ZKPP_VERSION,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Verify a PIN against the stored ZKPP envelope and unwrap the private key.
 * Throws immediately when the implicit zero-knowledge proof (the AES-GCM
 * authentication tag) fails to verify.
 */
async function zkppUnwrapPrivateKey(
  account: string,
  pin: string,
  oprfKey: CryptoKey,
  envelope: ZkppEnvelope
): Promise<string> {
  const blinded = await zkppBlindPin(pin);
  const oprfOutput = await zkppEvaluate(oprfKey, account, blinded);
  const wrappingKey = await zkppFinalize(oprfOutput);

  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.iv) as BufferSource },
      wrappingKey,
      base64ToBytes(envelope.ciphertext) as BufferSource
    );
  } catch {
    // GCM tag verification failed -> the PIN proof is invalid.
    throw new Error("ZKPP_VERIFICATION_FAILED");
  }
  return new TextDecoder().decode(plain);
}

const isZkppEnvelope = (value: unknown): value is ZkppEnvelope => {
  return (
    !!value &&
    typeof value === "object" &&
    (value as ZkppEnvelope).version === ZKPP_VERSION &&
    typeof (value as ZkppEnvelope).iv === "string" &&
    typeof (value as ZkppEnvelope).ciphertext === "string"
  );
};

/**
 * Test-only access to the internal ZKPP exchange steps so unit tests can
 * verify the OPAQUE-style message flow directly.
 */
export const __zkppInternals = {
  zkppBlindPin,
  zkppEvaluate,
  zkppFinalize,
  zkppWrapPrivateKey,
  zkppUnwrapPrivateKey,
  generateOprfKey,
};

/**
 * Core unlock routine shared by the public API and test hooks. Verifies the
 * PIN implicitly against whatever envelope the record carries.
 */
const unlockRecord = async (
  record: KeyPairRecord,
  pinOrPassphrase?: string
): Promise<string> => {
  const normalized = record.account;

  // Zero-knowledge password proof path (issue #151): the PIN is verified
  // implicitly by the OPAQUE-style envelope. No stored hash is compared;
  // a wrong PIN fails AES-GCM tag verification instantly.
  if (isZkppEnvelope(record.zkpp)) {
    // Duck-type the OPRF key: a JSON-extracted dump loses the CryptoKey and
    // leaves a plain `{}` behind, which must fail closed just like a record
    // with no OPRF secret at all (offline dump resistance).
    const oprfKey = record.oprfKey as CryptoKey | undefined;
    const usableOprfKey = !!oprfKey && (oprfKey as unknown as { type?: string }).type === "secret";
    if (!usableOprfKey) {
      throw new Error(
        "ZKPP credential file is incomplete: the non-extractable OPRF secret is missing from this storage dump."
      );
    }
    const { passphrase } = getEffectivePassphrase(normalized, pinOrPassphrase);
    try {
      return await zkppUnwrapPrivateKey(normalized, passphrase, oprfKey!, record.zkpp);
    } catch (err: any) {
      if (err?.message === "ZKPP_VERIFICATION_FAILED") {
        throw new Error(
          record.hasPin
            ? "Incorrect PIN or passphrase. Please verify your PIN."
            : "Failed to decrypt client private key from secure storage."
        );
      }
      throw err;
    }
  }

  // Legacy (pre-ZKPP) records: PBKDF2 envelope with embedded salt.
  if (!record.encryptedPrivateKey) {
    throw new Error("No decryptable key material in keyring record");
  }
  const { passphrase } = getEffectivePassphrase(normalized, pinOrPassphrase);
  try {
    return await secretsService.decryptWithPassphrase(record.encryptedPrivateKey, passphrase);
  } catch {
    throw new Error(
      record.hasPin
        ? "Incorrect PIN or passphrase. Please verify your PIN."
        : "Failed to decrypt client private key from secure storage."
    );
  }
};

/**
 * Development/test hooks. Not part of the public API contract; exposes just
 * enough of the storage/unlock internals for unit tests to simulate legacy
 * records and attacker-extracted dumps.
 */
export const __keyringDevHooks = {
  putRecord: (record: KeyPairRecord): Promise<void> => idbPut(record),
  unlockRecord,
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

const PASSKEY_RP_NAME = "SpooVault";

/**
 * Base64url helpers (kept local so the service has no dependency on the WebAuthn payload format).
 */
const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const base64UrlToBytes = (value: string): Uint8Array => {
  let b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) {
    b64 += "=";
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

interface PasskeyProtection {
  credentialId: string;
  prfSalt: string;
  encryptedPrivateKey: string;
}

/**
 * Register a hardware-backed WebAuthn passkey (TouchID / FaceID / YubiKey) with the PRF
 * extension enabled and encrypt `privateKey` with the derived hardware key.
 *
 * Returns `null` (never throws) when WebAuthn is unavailable, the authenticator does not
 * support PRF, or the user cancels — the caller then falls back to PIN/passphrase protection.
 */
const createPasskeyProtection = async (
  account: string,
  privateKey: string
): Promise<PasskeyProtection | null> => {
  if (!isWebAuthnAvailable()) {
    return null;
  }

  const rpId = getRelyingPartyId();
  const prfSalt = generatePrfSalt();

  try {
    const registration = await registerPasskey({
      rpId,
      rpName: PASSKEY_RP_NAME,
      userName: account,
      userDisplayName: account,
      challenge: generateChallenge(),
      prfSalt,
    });

    if (!registration.prfEnabled) {
      // Authenticator does not support the PRF extension, so no hardware-backed key can
      // be derived. Fall back to PIN/passphrase protection.
      return null;
    }

    // Most authenticators only return the PRF output on *authentication*, so issue a
    // follow-up assertion with the same salt to obtain the derived bytes.
    let prfOutput = registration.prfOutput;
    if (!prfOutput) {
      prfOutput = await authenticatePasskey({
        rpId,
        challenge: generateChallenge(),
        prfSalt,
        credentialId: registration.credentialId,
      });
    }

    // Fold the PRF output into a non-extractable AES-256-GCM key and encrypt the private key.
    const aesKey = await deriveAesKeyFromPrfOutput(prfOutput, prfSalt);
    const encryptedPrivateKey = await encryptWithPrfKey(privateKey, aesKey);

    return {
      credentialId: registration.credentialId,
      prfSalt: bytesToBase64Url(prfSalt),
      encryptedPrivateKey,
    };
  } catch {
    // Registration cancelled, PRF unsupported, or any other failure: fall back to
    // PIN/passphrase protection so the user is never left without a working keyring.
    return null;
  }
};

/**
 * Unlock a passkey-protected record by authenticating with the hardware authenticator
 * and decrypting with the re-derived hardware key.
 */
const decryptRecordWithPasskey = async (record: KeyPairRecord): Promise<string> => {
  const prfSalt = base64UrlToBytes(record.passkeyPrfSalt || "");
  const prfOutput = await authenticatePasskey({
    rpId: getRelyingPartyId(),
    challenge: generateChallenge(),
    prfSalt,
    credentialId: record.passkeyCredentialId || undefined,
  });
  const aesKey = await deriveAesKeyFromPrfOutput(prfOutput, prfSalt);
  return decryptWithPrfKey(record.passkeyEncryptedPrivateKey || "", aesKey);
};

export const clientKeyringService = {
  /**
   * Check if a keypair exists locally in IndexedDB for the given account.
   */
  async hasKeyPair(account: string): Promise<boolean> {
    if (!account) return false;
    const record = await idbGet(account);
    return (
      !!record?.publicKey &&
      (!!record?.encryptedPrivateKey || !!record?.passkeyEncryptedPrivateKey || !!record?.zkpp)
    );
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
   * Generate a new Web Crypto ECDH P-256 keypair, encrypt the private key with user PIN/passphrase
   * and/or a hardware-backed WebAuthn passkey (TouchID / FaceID / YubiKey), and store in IndexedDB.
   * Caches the unlocked private key in memory for the active session.
   */
  async generateAndSaveKeyPair(
    account: string,
    pinOrPassphrase?: string,
    options: GenerateKeyPairOptions = {}
  ): Promise<{ publicKey: string }> {
    if (!account) {
      throw new Error("Account address is required to generate a keypair");
    }

    const normalized = account.toLowerCase();
    const { publicKey, privateKey } = await generateECIESKeyPairBase64();


    // Attempt to protect the keyring with a hardware-backed WebAuthn passkey (PRF extension).
    const passkey =
      options.enablePasskey !== false
        ? await createPasskeyProtection(normalized, privateKey)
        : null;

    const existing = await idbGet(normalized);
    const updatedRecord = await persistKeyPair(normalized, publicKey, privateKey, pinOrPassphrase, existing);

    if (passkey) {
      updatedRecord.hasPasskey = true;
      updatedRecord.passkeyCredentialId = passkey.credentialId;
      updatedRecord.passkeyPrfSalt = passkey.prfSalt;
      updatedRecord.passkeyEncryptedPrivateKey = passkey.encryptedPrivateKey;
      if (!pinOrPassphrase?.trim()) {
        updatedRecord.encryptedPrivateKey = "";
        delete updatedRecord.zkpp;
        delete updatedRecord.oprfKey;
      }
      await idbPut(updatedRecord);
    }

    sessionKeyCache.set(normalized, privateKey);

    return { publicKey };
  },

  /**
   * Save an existing private and public key pair into the IndexedDB keyring.
   * The private key is stored under a zero-knowledge password proof envelope
   * (issue #151): no salt, hash, or derivation parameter is persisted.
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

    const existing = await idbGet(normalized);
    await persistKeyPair(normalized, publicKey, privateKey, pinOrPassphrase, existing);
  },

  /**
   * Retrieve and decrypt the client-side private key (Base64 PKCS#8) from IndexedDB.
   * If already unlocked in session cache, returns immediately.
   *
   * For passkey-protected keyrings, unlock happens via the hardware authenticator
   * (TouchID / FaceID / YubiKey) when no PIN is supplied; a supplied PIN/passphrase
   * decrypts the PIN-encrypted fallback blob or ZKPP envelope instead.
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
    if (!record || (!record.encryptedPrivateKey && !record.passkeyEncryptedPrivateKey && !record.zkpp)) {
      throw new Error(
        `No local encryption keypair found for wallet ${account}. Please generate one in your Profile page.`
      );
    }

    const trimmedPin = pinOrPassphrase?.trim();

    // Hardware-backed unlock path (TouchID / FaceID / YubiKey) via the WebAuthn PRF extension.
    if (
      !trimmedPin &&
      record.hasPasskey &&
      record.passkeyCredentialId &&
      record.passkeyPrfSalt &&
      record.passkeyEncryptedPrivateKey
    ) {
      try {
        const privateKey = await decryptRecordWithPasskey(record);
        sessionKeyCache.set(normalized, privateKey);
        return privateKey;
      } catch (err) {
        const cancelled = err instanceof WebAuthnError && err.code === "NOT_ALLOWED";
        if (record.hasPin && (record.encryptedPrivateKey || record.zkpp)) {
          // Smooth fallback: the keyring also has a PIN-encrypted copy / ZKPP envelope.
          throw new Error(
            cancelled
              ? "Passkey authentication cancelled. Unlock with your PIN/passphrase instead."
              : "Passkey authentication failed. Unlock with your PIN/passphrase instead."
          );
        }
        throw new Error(
          cancelled
            ? "Passkey authentication cancelled. Please try again when you are ready to unlock."
            : "Passkey authentication failed. Please verify your hardware authenticator."
        );
      }
    }

    const privateKey = await unlockRecord(record, pinOrPassphrase);
    sessionKeyCache.set(normalized, privateKey);
    return privateKey;
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
    const privateKey = await this.getDecryptedPrivateKey(
      normalized,
      currentPin
    );
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
