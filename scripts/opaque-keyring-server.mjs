/**
 * RFC 9807 OPAQUE server for client keyring PIN enrollment and verification.
 * The server stores only OPAQUE registration records; PINs and export keys never leave clients.
 */
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  OpaqueCredentialStore,
  createOpaqueKeyringProtocol,
  toOpaqueApiError,
} from "./lib/opaqueKeyringServer.mjs";

const PORT = Number(process.env.OPAQUE_PORT || process.env.PORT || 3010);
const SERVER_SETUP = process.env.OPAQUE_SERVER_SETUP || "";
const STORE_PATH = resolve(
  process.env.OPAQUE_CREDENTIAL_STORE_PATH || ".data/opaque-keyring-records.json"
);
const ALLOWED_ORIGINS = (
  process.env.OPAQUE_ALLOWED_ORIGINS ||
  "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!SERVER_SETUP) {
  console.error(
    "OPAQUE_SERVER_SETUP is required. Generate it with: npx @serenity-kit/opaque create-server-setup"
  );
  process.exit(1);
}

const protocol = await createOpaqueKeyringProtocol({
  serverSetup: SERVER_SETUP,
  store: new OpaqueCredentialStore(STORE_PATH),
});

const send = (res, status, body, origin) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
  });
  res.end(JSON.stringify(body));
};

const readJson = async (req) => {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16 * 1024) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Malformed JSON"), { status: 400, code: "INVALID_JSON" });
  }
};

const server = createServer(async (req, res) => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : "";
  if (origin && !allowedOrigin) return send(res, 403, { code: "ORIGIN_FORBIDDEN", error: "Forbidden" });
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    });
    return res.end();
  }

  try {
    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, { status: "ok", serverPublicKey: protocol.serverPublicKey }, allowedOrigin);
    }
    if (req.method === "POST" && req.url === "/v1/registration/start") {
      return send(res, 200, await protocol.startRegistration(await readJson(req)), allowedOrigin);
    }
    if (req.method === "POST" && req.url === "/v1/registration/finish") {
      return send(res, 200, await protocol.finishRegistration(await readJson(req)), allowedOrigin);
    }
    if (req.method === "POST" && req.url === "/v1/login/start") {
      return send(res, 200, await protocol.startLogin(await readJson(req)), allowedOrigin);
    }
    if (req.method === "POST" && req.url === "/v1/login/finish") {
      return send(res, 200, await protocol.finishLogin(await readJson(req)), allowedOrigin);
    }
    if (req.method === "DELETE" && req.url?.startsWith("/v1/credentials/")) {
      const account = decodeURIComponent(req.url.slice("/v1/credentials/".length));
      const authorization = req.headers.authorization || "";
      const managementToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      return send(
        res,
        200,
        await protocol.deleteCredential({ account, managementToken }),
        allowedOrigin
      );
    }
    return send(res, 404, { code: "NOT_FOUND", error: "Not found" }, allowedOrigin);
  } catch (error) {
    const response = toOpaqueApiError(error);
    console.error("OPAQUE request failed:", response.body.code);
    return send(res, response.status, response.body, allowedOrigin);
  }
});

server.listen(PORT, () => {
  console.log(`OPAQUE keyring server listening on http://localhost:${PORT}`);
  console.log(`OPAQUE server public key: ${protocol.serverPublicKey}`);
  console.log(`Credential store: ${STORE_PATH}`);
});
