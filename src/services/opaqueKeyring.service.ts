export const OPAQUE_ENVELOPE_VERSION = "spoovault-opaque-rfc9807-v1" as const;

const OPAQUE_SERVER_ID = "spoovault-keyring-v1";
const OPAQUE_KDF_INFO = "spoovault opaque export key wrap v1";
const OPAQUE_AAD_PREFIX = "spoovault-keyring-private-key-v1";

export interface OpaqueKeyringEnvelope {
  version: typeof OPAQUE_ENVELOPE_VERSION;
  iv: string;
  ciphertext: string;
}

export interface OpaqueRegistrationStartResponse {
  registrationResponse: string;
}

export interface OpaqueRegistrationFinishResponse {
  managementToken: string;
}

export interface OpaqueLoginStartResponse {
  loginId: string;
  loginResponse: string;
}

export interface OpaqueLoginFinishResponse {
  managementToken: string;
}

export interface OpaqueTransport {
  startRegistration(
    account: string,
    registrationRequest: string
  ): Promise<OpaqueRegistrationStartResponse>;
  finishRegistration(
    account: string,
    registrationRecord: string,
    managementToken?: string
  ): Promise<OpaqueRegistrationFinishResponse>;
  startLogin(account: string, startLoginRequest: string): Promise<OpaqueLoginStartResponse>;
  finishLogin(loginId: string, finishLoginRequest: string): Promise<OpaqueLoginFinishResponse>;
  deleteCredential(account: string, managementToken: string): Promise<void>;
}

export class OpaqueTransportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(message);
    this.name = "OpaqueTransportError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const managementTokens = new Map<string, string>();

let injectedTransport: OpaqueTransport | null = null;
let injectedServerPublicKey: string | null = null;
let opaqueModulePromise: Promise<typeof import("@serenity-kit/opaque")> | null = null;

const getOpaque = async (): Promise<typeof import("@serenity-kit/opaque")> => {
  opaqueModulePromise ??= import("@serenity-kit/opaque");
  const opaque = await opaqueModulePromise;
  await opaque.ready;
  return opaque;
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

const readError = async (response: Response): Promise<OpaqueTransportError> => {
  let body: { error?: string; code?: string } = {};
  try {
    body = (await response.json()) as { error?: string; code?: string };
  } catch {
    // A non-JSON upstream error must still fail closed.
  }
  return new OpaqueTransportError(
    body.error || `OPAQUE server responded with ${response.status}`,
    body.code || "OPAQUE_SERVER_ERROR",
    response.status
  );
};

const postJson = async <T>(baseUrl: string, path: string, body: unknown): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new OpaqueTransportError(
      "OPAQUE verification server is unavailable",
      "OPAQUE_SERVER_UNAVAILABLE",
      0
    );
  }
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
};

const createFetchTransport = (baseUrl: string): OpaqueTransport => ({
  startRegistration: (account, registrationRequest) =>
    postJson(baseUrl, "/v1/registration/start", { account, registrationRequest }),
  finishRegistration: (account, registrationRecord, managementToken) =>
    postJson(baseUrl, "/v1/registration/finish", {
      account,
      registrationRecord,
      managementToken,
    }),
  startLogin: (account, startLoginRequest) =>
    postJson(baseUrl, "/v1/login/start", { account, startLoginRequest }),
  finishLogin: (loginId, finishLoginRequest) =>
    postJson(baseUrl, "/v1/login/finish", { loginId, finishLoginRequest }),
  async deleteCredential(account, managementToken) {
    const response = await fetch(`${baseUrl}/v1/credentials/${encodeURIComponent(account)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${managementToken}` },
    });
    if (!response.ok) throw await readError(response);
  },
});

const getTransport = (): OpaqueTransport => {
  if (injectedTransport) return injectedTransport;
  const baseUrl = normalizeBaseUrl(
    (import.meta.env.VITE_OPAQUE_SERVER_URL as string | undefined)?.trim() || ""
  );
  if (!baseUrl) {
    throw new OpaqueTransportError(
      "OPAQUE verification server is not configured",
      "OPAQUE_SERVER_NOT_CONFIGURED",
      0
    );
  }
  return createFetchTransport(baseUrl);
};

const getExpectedServerPublicKey = (): string => {
  const publicKey =
    injectedServerPublicKey ??
    (import.meta.env.VITE_OPAQUE_SERVER_PUBLIC_KEY as string | undefined)?.trim() ??
    "";
  if (!publicKey) {
    throw new Error("OPAQUE server public key is not configured");
  }
  return publicKey;
};

const assertServerIdentity = (actual: string): void => {
  if (actual !== getExpectedServerPublicKey()) {
    throw new Error("OPAQUE server identity verification failed");
  }
};

const base64UrlToBytes = (value: string): Uint8Array => {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const bytesToBase64Url = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const additionalData = (account: string, publicKey: string): Uint8Array =>
  encoder.encode(`${OPAQUE_AAD_PREFIX}|${account.toLowerCase()}|${publicKey}`);

const deriveWrappingKey = async (exportKey: string): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(exportKey) as BufferSource,
    "HKDF",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(OPAQUE_KDF_INFO),
      info: encoder.encode(OPAQUE_SERVER_ID),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
};

const wrapPrivateKey = async (
  exportKey: string,
  account: string,
  publicKey: string,
  privateKey: string
): Promise<OpaqueKeyringEnvelope> => {
  const key = await deriveWrappingKey(exportKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: additionalData(account, publicKey) as BufferSource,
    },
    key,
    encoder.encode(privateKey) as BufferSource
  );
  return {
    version: OPAQUE_ENVELOPE_VERSION,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
};

const unwrapPrivateKey = async (
  exportKey: string,
  account: string,
  publicKey: string,
  envelope: OpaqueKeyringEnvelope
): Promise<string> => {
  const key = await deriveWrappingKey(exportKey);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(envelope.iv) as BufferSource,
        additionalData: additionalData(account, publicKey) as BufferSource,
      },
      key,
      base64UrlToBytes(envelope.ciphertext) as BufferSource
    );
    return decoder.decode(plaintext);
  } catch {
    throw new Error("OPAQUE keyring envelope verification failed");
  }
};

const identifiersFor = (account: string) => ({
  client: account.toLowerCase(),
  server: OPAQUE_SERVER_ID,
});

const login = async (
  account: string,
  pin: string
): Promise<{ exportKey: string; managementToken: string }> => {
  const opaque = await getOpaque();
  const normalized = account.toLowerCase();
  const transport = getTransport();
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password: pin });
  const { loginId, loginResponse } = await transport.startLogin(normalized, startLoginRequest);
  const result = opaque.client.finishLogin({
    clientLoginState,
    loginResponse,
    password: pin,
    identifiers: identifiersFor(normalized),
    keyStretching: "memory-constrained",
  });
  if (!result) throw new Error("OPAQUE_VERIFICATION_FAILED");
  assertServerIdentity(result.serverStaticPublicKey);

  // The export key is not used until the server has verified the client's KE3 proof.
  const { managementToken } = await transport.finishLogin(loginId, result.finishLoginRequest);
  managementTokens.set(normalized, managementToken);
  return { exportKey: result.exportKey, managementToken };
};

const register = async (
  account: string,
  pin: string
): Promise<{ exportKey: string; managementToken: string }> => {
  const opaque = await getOpaque();
  const normalized = account.toLowerCase();
  const transport = getTransport();
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password: pin });
  const { registrationResponse } = await transport.startRegistration(
    normalized,
    registrationRequest
  );
  const result = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse,
    password: pin,
    identifiers: identifiersFor(normalized),
    keyStretching: "memory-constrained",
  });
  assertServerIdentity(result.serverStaticPublicKey);
  const { managementToken } = await transport.finishRegistration(
    normalized,
    result.registrationRecord,
    managementTokens.get(normalized)
  );
  managementTokens.set(normalized, managementToken);
  return { exportKey: result.exportKey, managementToken };
};

export const isOpaqueKeyringEnvelope = (value: unknown): value is OpaqueKeyringEnvelope =>
  !!value &&
  typeof value === "object" &&
  (value as OpaqueKeyringEnvelope).version === OPAQUE_ENVELOPE_VERSION &&
  typeof (value as OpaqueKeyringEnvelope).iv === "string" &&
  typeof (value as OpaqueKeyringEnvelope).ciphertext === "string";

export const opaqueKeyringService = {
  async enrollAndWrap(
    account: string,
    pin: string,
    publicKey: string,
    privateKey: string
  ): Promise<OpaqueKeyringEnvelope> {
    if (!pin.trim()) throw new Error("A PIN or passphrase is required for OPAQUE enrollment");
    let authentication: { exportKey: string; managementToken: string };
    try {
      authentication = await register(account, pin.trim());
    } catch (error) {
      if (!(error instanceof OpaqueTransportError) || error.code !== "OPAQUE_CREDENTIAL_EXISTS") {
        throw error;
      }
      authentication = await login(account, pin.trim());
    }
    return wrapPrivateKey(authentication.exportKey, account, publicKey, privateKey);
  },

  async verifyAndUnwrap(
    account: string,
    pin: string,
    publicKey: string,
    envelope: OpaqueKeyringEnvelope
  ): Promise<string> {
    if (!pin.trim()) throw new Error("OPAQUE_VERIFICATION_FAILED");
    const { exportKey } = await login(account, pin.trim());
    return unwrapPrivateKey(exportKey, account, publicKey, envelope);
  },

  async deleteCredential(account: string): Promise<void> {
    const normalized = account.toLowerCase();
    const token = managementTokens.get(normalized);
    if (!token) return;
    await getTransport().deleteCredential(normalized, token);
    managementTokens.delete(normalized);
  },

  clearSession(): void {
    managementTokens.clear();
  },

  lockAccount(account: string): void {
    managementTokens.delete(account.toLowerCase());
  },
};

export const __opaqueKeyringTestHooks = {
  configure(transport: OpaqueTransport, serverPublicKey: string): void {
    injectedTransport = transport;
    injectedServerPublicKey = serverPublicKey;
    managementTokens.clear();
  },
  reset(): void {
    injectedTransport = null;
    injectedServerPublicKey = null;
    managementTokens.clear();
  },
};
