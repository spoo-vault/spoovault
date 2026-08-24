declare module "*opaqueKeyringServer.mjs" {
  export const OPAQUE_SERVER_ID: string;
  export const DEFAULT_SESSION_TTL_MS: number;
  export const DEFAULT_TOKEN_TTL_MS: number;

  export class OpaqueCredentialStore {
    constructor(filePath: string | null);
    get(account: string): Promise<{ registrationRecord: string } | null>;
    put(account: string, registrationRecord: string): Promise<void>;
    delete(account: string): Promise<void>;
  }

  export class InMemoryOpaqueCredentialStore extends OpaqueCredentialStore {
    constructor();
  }

  export function createOpaqueKeyringProtocol(options: {
    serverSetup: string;
    store: OpaqueCredentialStore;
    now?: () => number;
    sessionTtlMs?: number;
    tokenTtlMs?: number;
    rateLimitWindowMs?: number;
    rateLimitAttempts?: number;
  }): Promise<{
    serverPublicKey: string;
    startRegistration(input: { account: string; registrationRequest: string }): Promise<{ registrationResponse: string }>;
    finishRegistration(input: { account: string; registrationRecord: string; managementToken?: string }): Promise<{ managementToken: string }>;
    startLogin(input: { account: string; startLoginRequest: string }): Promise<{ loginId: string; loginResponse: string }>;
    finishLogin(input: { loginId: string; finishLoginRequest: string }): Promise<{ managementToken: string }>;
    deleteCredential(input: { account: string; managementToken: string }): Promise<{ deleted: boolean }>;
  }>;
}
