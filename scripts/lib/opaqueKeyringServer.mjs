import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as opaque from "@serenity-kit/opaque";

export const OPAQUE_SERVER_ID = "spoovault-keyring-v1";
export const DEFAULT_SESSION_TTL_MS = 60_000;
export const DEFAULT_TOKEN_TTL_MS = 15 * 60_000;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_ATTEMPTS = 5;

const STORE_VERSION = "spoovault-opaque-credential-store-v1";
const ACCOUNT_PATTERN = /^[a-zA-Z0-9:._-]{3,128}$/;
const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9_-]+$/;

const normalizeAccount = (account) => {
  const normalized = typeof account === "string" ? account.trim().toLowerCase() : "";
  if (!ACCOUNT_PATTERN.test(normalized)) throw apiError(400, "INVALID_ACCOUNT", "Invalid account");
  return normalized;
};

const validateOpaqueValue = (value, field, maxLength = 4096) => {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > maxLength ||
    !OPAQUE_VALUE_PATTERN.test(value)
  ) {
    throw apiError(400, "INVALID_OPAQUE_MESSAGE", `Invalid ${field}`);
  }
  return value;
};

const apiError = (status, code, message) => Object.assign(new Error(message), { status, code });

const tokenValue = () => randomBytes(32).toString("base64url");

const safeTokenEqual = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export class OpaqueCredentialStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.records = new Map();
    this.loaded = false;
    this.pendingWrite = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (parsed.version !== STORE_VERSION || typeof parsed.records !== "object") {
        throw new Error("Unsupported OPAQUE credential store format");
      }
      for (const [account, value] of Object.entries(parsed.records)) {
        if (value && typeof value.registrationRecord === "string") {
          this.records.set(account, value);
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async get(account) {
    await this.load();
    return this.records.get(account) ?? null;
  }

  async put(account, registrationRecord) {
    await this.load();
    const previous = this.records.get(account);
    const now = new Date().toISOString();
    this.records.set(account, {
      registrationRecord,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    });
    await this.persist();
  }

  async delete(account) {
    await this.load();
    this.records.delete(account);
    await this.persist();
  }

  async persist() {
    if (!this.filePath) return;
    const snapshot = JSON.stringify(
      { version: STORE_VERSION, records: Object.fromEntries(this.records) },
      null,
      2
    );
    this.pendingWrite = this.pendingWrite.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${snapshot}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    await this.pendingWrite;
  }
}

export class InMemoryOpaqueCredentialStore extends OpaqueCredentialStore {
  constructor() {
    super(null);
  }
}

export const createOpaqueKeyringProtocol = async ({
  serverSetup,
  store,
  now = () => Date.now(),
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  tokenTtlMs = DEFAULT_TOKEN_TTL_MS,
  rateLimitWindowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
  rateLimitAttempts = DEFAULT_RATE_LIMIT_ATTEMPTS,
}) => {
  if (!serverSetup) throw new Error("OPAQUE_SERVER_SETUP is required");
  if (!store) throw new Error("An OPAQUE credential store is required");
  await opaque.ready;

  const logins = new Map();
  const managementTokens = new Map();
  const attempts = new Map();

  const cleanup = () => {
    const current = now();
    for (const [id, value] of logins) if (value.expiresAt <= current) logins.delete(id);
    for (const [token, value] of managementTokens) {
      if (value.expiresAt <= current) managementTokens.delete(token);
    }
    for (const [account, value] of attempts) {
      if (value.resetAt <= current) attempts.delete(account);
    }
  };

  const issueManagementToken = (account) => {
    cleanup();
    const token = tokenValue();
    managementTokens.set(token, { account, expiresAt: now() + tokenTtlMs });
    return token;
  };

  const revokeManagementTokens = (account) => {
    for (const [token, value] of managementTokens) {
      if (value.account === account) managementTokens.delete(token);
    }
  };

  const authorizeManagement = (account, token) => {
    cleanup();
    for (const [candidate, value] of managementTokens) {
      if (
        value.account === account &&
        value.expiresAt > now() &&
        safeTokenEqual(candidate, token)
      ) {
        return true;
      }
    }
    return false;
  };

  const consumeAttempt = (account) => {
    cleanup();
    const current = attempts.get(account);
    if (!current || current.resetAt <= now()) {
      attempts.set(account, { count: 1, resetAt: now() + rateLimitWindowMs });
      return;
    }
    if (current.count >= rateLimitAttempts) {
      throw apiError(429, "OPAQUE_RATE_LIMITED", "Too many OPAQUE login attempts");
    }
    current.count += 1;
  };

  return {
    serverPublicKey: opaque.server.getPublicKey(serverSetup),

    async startRegistration({ account, registrationRequest }) {
      const normalized = normalizeAccount(account);
      validateOpaqueValue(registrationRequest, "registrationRequest");
      const { registrationResponse } = opaque.server.createRegistrationResponse({
        serverSetup,
        userIdentifier: normalized,
        registrationRequest,
      });
      return { registrationResponse };
    },

    async finishRegistration({ account, registrationRecord, managementToken }) {
      const normalized = normalizeAccount(account);
      validateOpaqueValue(registrationRecord, "registrationRecord");
      const existing = await store.get(normalized);
      if (existing && !authorizeManagement(normalized, managementToken)) {
        throw apiError(409, "OPAQUE_CREDENTIAL_EXISTS", "OPAQUE credential already exists");
      }
      await store.put(normalized, registrationRecord);
      revokeManagementTokens(normalized);
      return { managementToken: issueManagementToken(normalized) };
    },

    async startLogin({ account, startLoginRequest }) {
      const normalized = normalizeAccount(account);
      validateOpaqueValue(startLoginRequest, "startLoginRequest");
      consumeAttempt(normalized);
      const credential = await store.get(normalized);
      const { serverLoginState, loginResponse } = opaque.server.startLogin({
        serverSetup,
        registrationRecord: credential?.registrationRecord,
        startLoginRequest,
        userIdentifier: normalized,
        identifiers: { client: normalized, server: OPAQUE_SERVER_ID },
      });
      const loginId = tokenValue();
      logins.set(loginId, {
        account: normalized,
        serverLoginState,
        expiresAt: now() + sessionTtlMs,
      });
      return { loginId, loginResponse };
    },

    async finishLogin({ loginId, finishLoginRequest }) {
      validateOpaqueValue(loginId, "loginId", 256);
      validateOpaqueValue(finishLoginRequest, "finishLoginRequest");
      cleanup();
      const login = logins.get(loginId);
      logins.delete(loginId);
      if (!login || login.expiresAt <= now()) {
        throw apiError(401, "OPAQUE_LOGIN_EXPIRED", "OPAQUE login expired");
      }
      try {
        opaque.server.finishLogin({
          finishLoginRequest,
          serverLoginState: login.serverLoginState,
          identifiers: { client: login.account, server: OPAQUE_SERVER_ID },
        });
      } catch {
        throw apiError(401, "OPAQUE_VERIFICATION_FAILED", "OPAQUE proof verification failed");
      }
      attempts.delete(login.account);
      return { managementToken: issueManagementToken(login.account) };
    },

    async deleteCredential({ account, managementToken }) {
      const normalized = normalizeAccount(account);
      if (!authorizeManagement(normalized, managementToken)) {
        throw apiError(401, "OPAQUE_MANAGEMENT_UNAUTHORIZED", "Credential authorization failed");
      }
      await store.delete(normalized);
      for (const [token, value] of managementTokens) {
        if (value.account === normalized) managementTokens.delete(token);
      }
      return { deleted: true };
    },
  };
};

export const toOpaqueApiError = (error) => ({
  status: Number.isInteger(error?.status) ? error.status : 500,
  body: {
    code: typeof error?.code === "string" ? error.code : "OPAQUE_SERVER_ERROR",
    error: Number.isInteger(error?.status) ? error.message : "Internal server error",
  },
});
