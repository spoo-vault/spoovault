import * as opaque from "@serenity-kit/opaque";
import {
  InMemoryOpaqueCredentialStore,
  createOpaqueKeyringProtocol,
} from "../../../scripts/lib/opaqueKeyringServer.mjs";
import {
  OpaqueTransport,
  OpaqueTransportError,
  __opaqueKeyringTestHooks,
} from "../../services/opaqueKeyring.service";

const translateError = (error: unknown): never => {
  const value = error as { message?: string; code?: string; status?: number };
  throw new OpaqueTransportError(
    value.message || "OPAQUE test server error",
    value.code || "OPAQUE_SERVER_ERROR",
    value.status || 500
  );
};

export const installOpaqueServerMock = async (): Promise<{
  transport: OpaqueTransport;
  serverPublicKey: string;
}> => {
  await opaque.ready;
  const serverSetup = opaque.server.createSetup();
  const protocol = await createOpaqueKeyringProtocol({
    serverSetup,
    store: new InMemoryOpaqueCredentialStore(),
    rateLimitAttempts: 100,
  });

  const transport: OpaqueTransport = {
    async startRegistration(account, registrationRequest) {
      try {
        return await protocol.startRegistration({ account, registrationRequest });
      } catch (error) {
        return translateError(error);
      }
    },
    async finishRegistration(account, registrationRecord, managementToken) {
      try {
        return await protocol.finishRegistration({
          account,
          registrationRecord,
          managementToken,
        });
      } catch (error) {
        return translateError(error);
      }
    },
    async startLogin(account, startLoginRequest) {
      try {
        return await protocol.startLogin({ account, startLoginRequest });
      } catch (error) {
        return translateError(error);
      }
    },
    async finishLogin(loginId, finishLoginRequest) {
      try {
        return await protocol.finishLogin({ loginId, finishLoginRequest });
      } catch (error) {
        return translateError(error);
      }
    },
    async deleteCredential(account, managementToken) {
      try {
        await protocol.deleteCredential({ account, managementToken });
      } catch (error) {
        return translateError(error);
      }
    },
  };

  __opaqueKeyringTestHooks.configure(transport, protocol.serverPublicKey);
  return { transport, serverPublicKey: protocol.serverPublicKey };
};
