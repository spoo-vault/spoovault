import { beforeEach, describe, expect, it } from "vitest";
import * as opaque from "@serenity-kit/opaque";
import {
  InMemoryOpaqueCredentialStore,
  OPAQUE_SERVER_ID,
  createOpaqueKeyringProtocol,
} from "../../scripts/lib/opaqueKeyringServer.mjs";

const account = "0x71c838936352937a71e976bbe84e941e79409932";
const password = "server-integration-pin";
const identifiers = { client: account, server: OPAQUE_SERVER_ID };

describe("OPAQUE keyring server protocol", { timeout: 120_000 }, () => {
  let serverSetup: string;
  let store: InMemoryOpaqueCredentialStore;

  beforeEach(async () => {
    await opaque.ready;
    serverSetup = opaque.server.createSetup();
    store = new InMemoryOpaqueCredentialStore();
  });

  const register = async () => {
    const protocol = await createOpaqueKeyringProtocol({ serverSetup, store });
    const started = opaque.client.startRegistration({ password });
    const response = await protocol.startRegistration({
      account,
      registrationRequest: started.registrationRequest,
    });
    const finished = opaque.client.finishRegistration({
      clientRegistrationState: started.clientRegistrationState,
      registrationResponse: response.registrationResponse,
      password,
      identifiers,
      keyStretching: "memory-constrained",
    });
    const persisted = await protocol.finishRegistration({
      account,
      registrationRecord: finished.registrationRecord,
    });
    return { protocol, finished, persisted };
  };

  it("keeps the registration record server-side and completes mutual proof verification", async () => {
    const { protocol, finished } = await register();
    expect((await store.get(account))?.registrationRecord).toBe(finished.registrationRecord);

    const started = opaque.client.startLogin({ password });
    const response = await protocol.startLogin({
      account,
      startLoginRequest: started.startLoginRequest,
    });
    const clientResult = opaque.client.finishLogin({
      clientLoginState: started.clientLoginState,
      loginResponse: response.loginResponse,
      password,
      identifiers,
      keyStretching: "memory-constrained",
    });
    expect(clientResult).toBeDefined();
    await expect(
      protocol.finishLogin({
        loginId: response.loginId,
        finishLoginRequest: clientResult!.finishLoginRequest,
      })
    ).resolves.toHaveProperty("managementToken");
  });

  it("does not produce an export key when the PIN proof is wrong", async () => {
    const { protocol } = await register();
    const started = opaque.client.startLogin({ password: "wrong-pin" });
    const response = await protocol.startLogin({
      account,
      startLoginRequest: started.startLoginRequest,
    });
    const clientResult = opaque.client.finishLogin({
      clientLoginState: started.clientLoginState,
      loginResponse: response.loginResponse,
      password: "wrong-pin",
      identifiers,
      keyStretching: "memory-constrained",
    });
    expect(clientResult).toBeUndefined();
  });

  it("rejects credential replacement without a verified management token", async () => {
    const { protocol, finished } = await register();
    await expect(
      protocol.finishRegistration({
        account,
        registrationRecord: finished.registrationRecord,
      })
    ).rejects.toMatchObject({ status: 409, code: "OPAQUE_CREDENTIAL_EXISTS" });
  });

  it("rate-limits repeated online guesses per account", async () => {
    const protocol = await createOpaqueKeyringProtocol({
      serverSetup,
      store,
      rateLimitAttempts: 1,
    });
    const first = opaque.client.startLogin({ password });
    await protocol.startLogin({ account, startLoginRequest: first.startLoginRequest });
    const second = opaque.client.startLogin({ password });
    await expect(
      protocol.startLogin({ account, startLoginRequest: second.startLoginRequest })
    ).rejects.toMatchObject({ status: 429, code: "OPAQUE_RATE_LIMITED" });
  });
});
