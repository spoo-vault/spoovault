import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_MAX_SKEW_SEC,
  SIGNATURE_HEADER,
  UNSIGNED_PAYLOAD,
  authorizeIncomingRequest,
  authorizeProxyRequest,
  canonicalize,
  formatSignatureHeader,
  hmacSha256Hex,
  isMultipartContentType,
  isOriginAllowed,
  parseAllowedOrigins,
  parseSignatureHeader,
  resolveBodyHash,
  sha256Hex,
  signProxyRequest,
  timingSafeEqualHex,
  toHex,
} from "../../scripts/lib/ipfsProxyGuard.mjs";
import { signProxyRequest as signFromClient } from "../utils/ipfsProxySignature";

const SECRET = "test-proxy-hmac-secret";
const ORIGINS = ["https://app.spoovault.io", "http://localhost:5173"];
const PATH = "/api/ipfs/pin-json";
const BODY = JSON.stringify({ pinataContent: { hello: "vault" } });

const authorize = (
  overrides: Partial<Parameters<typeof authorizeProxyRequest>[0]> = {}
) =>
  authorizeProxyRequest({
    method: "POST",
    path: PATH,
    origin: "https://app.spoovault.io",
    body: BODY,
    secret: SECRET,
    allowedOrigins: ORIGINS,
    now: () => 1_700_000_000,
    ...overrides,
  });

describe("IPFS proxy CORS origin allowlist", () => {
  it("defaults to local Vite origins when env is empty", () => {
    expect(parseAllowedOrigins(undefined)).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(parseAllowedOrigins("")).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(parseAllowedOrigins(" , ")).toEqual(DEFAULT_ALLOWED_ORIGINS);
  });

  it("parses comma-separated authorized app domains", () => {
    expect(
      parseAllowedOrigins("https://app.spoovault.io, https://spoovault.io")
    ).toEqual(["https://app.spoovault.io", "https://spoovault.io"]);
  });

  it("allows missing Origin (non-browser) and exact allowlist matches", () => {
    expect(isOriginAllowed(undefined, ORIGINS)).toBe(true);
    expect(isOriginAllowed("https://app.spoovault.io", ORIGINS)).toBe(true);
    expect(isOriginAllowed("https://evil.example", ORIGINS)).toBe(false);
    expect(isOriginAllowed("https://evil.example", ["*"])).toBe(true);
  });
});

describe("IPFS proxy HMAC signatures", () => {
  it("builds canonical strings and SHA-256 body hashes", async () => {
    expect(
      canonicalize({
        timestamp: 1700000000,
        method: "post",
        path: PATH,
        bodyHash: "abc",
      })
    ).toBe(`1700000000.POST.${PATH}.abc`);
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(await resolveBodyHash({ unsignedBody: true })).toBe(
      UNSIGNED_PAYLOAD
    );
    expect(await resolveBodyHash({ body: "" })).toBe(await sha256Hex(""));
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });

  it("signs requests with X-SpooVault-Signature t=,v1= and verifies them", async () => {
    const signed = await signProxyRequest({
      secret: SECRET,
      method: "POST",
      path: PATH,
      body: BODY,
      timestamp: 1_700_000_000,
    });
    expect(signed.headers[SIGNATURE_HEADER]).toMatch(
      /^t=1700000000,v1=[0-9a-f]+$/
    );

    const result = await authorize({ signatureHeader: signed.signature });
    expect(result).toEqual({ ok: true });
  });

  it("rejects missing, malformed, and wrong signatures with 403 Forbidden", async () => {
    const signed = await signProxyRequest({
      secret: SECRET,
      method: "POST",
      path: PATH,
      body: BODY,
      timestamp: 1_700_000_000,
    });

    await expect(authorize({ signatureHeader: undefined })).resolves.toEqual({
      ok: false,
      status: 403,
      error: "Forbidden",
    });
    await expect(
      authorize({ signatureHeader: "not-a-signature" })
    ).resolves.toMatchObject({
      status: 403,
      error: "Forbidden",
    });
    await expect(
      authorize({ signatureHeader: "t=1700000000,v1=" })
    ).resolves.toMatchObject({
      status: 403,
    });
    await expect(
      authorize({ signatureHeader: signed.signature.replace(/v1=/, "v1=dead") })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      authorize({
        signatureHeader: signed.signature,
        secret: "other-secret",
      })
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      authorize({ signatureHeader: signed.signature, secret: "" })
    ).resolves.toMatchObject({
      status: 403,
    });
  });

  it("rejects tampered JSON bodies and expired timestamps", async () => {
    const signed = await signProxyRequest({
      secret: SECRET,
      method: "POST",
      path: PATH,
      body: BODY,
      timestamp: 1_700_000_000,
    });

    await expect(
      authorize({
        signatureHeader: signed.signature,
        body: '{"pinataContent":{"hello":"nope"}}',
      })
    ).resolves.toMatchObject({ status: 403 });

    await expect(
      authorize({
        signatureHeader: signed.signature,
        now: () => 1_700_000_000 + DEFAULT_MAX_SKEW_SEC + 1,
      })
    ).resolves.toMatchObject({ status: 403 });
  });

  it("rejects unauthorized CORS origins even when the HMAC is valid", async () => {
    const signed = await signProxyRequest({
      secret: SECRET,
      method: "POST",
      path: PATH,
      body: BODY,
      timestamp: 1_700_000_000,
    });

    await expect(
      authorize({
        signatureHeader: signed.signature,
        origin: "https://evil.example",
      })
    ).resolves.toEqual({ ok: false, status: 403, error: "Forbidden" });
  });

  it("allows non-browser callers with no Origin when the signature is valid", async () => {
    const signed = await signProxyRequest({
      secret: SECRET,
      method: "POST",
      path: PATH,
      body: BODY,
      timestamp: 1_700_000_000,
    });
    await expect(
      authorize({ signatureHeader: signed.signature, origin: undefined })
    ).resolves.toEqual({ ok: true });
  });

  it("uses UNSIGNED-PAYLOAD for multipart pin-file requests", async () => {
    const signed = await signProxyRequest({
      secret: SECRET,
      method: "POST",
      path: "/api/ipfs/pin-file",
      unsignedBody: true,
      timestamp: 1_700_000_000,
    });
    const result = await authorizeIncomingRequest(
      {
        method: "POST",
        originalUrl: "/api/ipfs/pin-file",
        origin: "http://localhost:5173",
        signatureHeader: signed.signature,
        contentType: "multipart/form-data; boundary=----browser",
        rawBody: "should-be-ignored",
      },
      {
        secret: SECRET,
        allowedOrigins: ORIGINS,
        now: () => 1_700_000_000,
      }
    );
    expect(result).toEqual({ ok: true });
    expect(isMultipartContentType("Multipart/Form-Data; boundary=x")).toBe(
      true
    );
    expect(isMultipartContentType("application/json")).toBe(false);
  });

  it("signs GET pin-list query strings and skips OPTIONS preflight", async () => {
    const path = "/api/ipfs/pin-list?status=pinned&pageLimit=100&pageOffset=0";
    const signed = await signProxyRequest({
      secret: SECRET,
      method: "GET",
      path,
      timestamp: 1_700_000_000,
    });
    const result = await authorizeIncomingRequest(
      {
        method: "GET",
        originalUrl: `${path}#ignored`,
        origin: "http://localhost:5173",
        signatureHeader: signed.signature,
        contentType: "application/json",
        rawBody: "",
      },
      {
        secret: SECRET,
        allowedOrigins: ORIGINS,
        now: () => 1_700_000_000,
      }
    );
    expect(result).toEqual({ ok: true });
    await expect(
      authorizeProxyRequest({
        method: "OPTIONS",
        path: "/api/ipfs/pin-file",
        allowedOrigins: ORIGINS,
        secret: "",
      })
    ).resolves.toEqual({ ok: true });
  });

  it("parses signature headers and compares hex in constant time", () => {
    expect(parseSignatureHeader(null)).toBeNull();
    expect(parseSignatureHeader(12)).toBeNull();
    expect(parseSignatureHeader("")).toBeNull();
    expect(parseSignatureHeader("t=1,,v1=aa")).toEqual({
      timestamp: 1,
      v1: "aa",
    });
    expect(parseSignatureHeader("t=12,v1=ab")).toEqual({
      timestamp: 12,
      v1: "ab",
    });
    expect(parseSignatureHeader("v1=AB, t=12")).toEqual({
      timestamp: 12,
      v1: "ab",
    });
    expect(parseSignatureHeader("orphan,t=1,v1=aa")).toEqual({
      timestamp: 1,
      v1: "aa",
    });
    expect(formatSignatureHeader(12, "ab")).toBe("t=12,v1=ab");
    expect(timingSafeEqualHex("aa", "aa")).toBe(true);
    expect(timingSafeEqualHex("aa", "ab")).toBe(false);
    expect(timingSafeEqualHex("aa", "aaa")).toBe(false);
    expect(timingSafeEqualHex(1, "1")).toBe(false);
  });

  it("signs with the default clock and accepts a live timestamp", async () => {
    const signed = await signProxyRequest({
      secret: SECRET,
      method: "POST",
      path: PATH,
      body: BODY,
    });
    await expect(
      authorizeProxyRequest({
        method: "POST",
        path: PATH,
        origin: "https://app.spoovault.io",
        signatureHeader: signed.signature,
        body: BODY,
        secret: SECRET,
        allowedOrigins: ORIGINS,
      })
    ).resolves.toEqual({ ok: true });
    await expect(
      authorizeProxyRequest({
        method: "",
        path: PATH,
        origin: "https://app.spoovault.io",
        allowedOrigins: ORIGINS,
        secret: SECRET,
      })
    ).resolves.toMatchObject({ status: 403 });
    expect(isMultipartContentType(undefined)).toBe(false);
  });

  it("rejects unsigned JSON pin-json calls with 403 Forbidden", async () => {
    const result = await authorizeIncomingRequest(
      {
        method: "POST",
        path: PATH,
        origin: "https://app.spoovault.io",
        contentType: "application/json",
        rawBody: BODY,
      },
      {
        secret: SECRET,
        allowedOrigins: ORIGINS,
        now: () => 1_700_000_000,
      }
    );
    expect(result).toEqual({ ok: false, status: 403, error: "Forbidden" });
  });

  it("throws when the client signing secret is missing", async () => {
    await expect(
      signProxyRequest({ secret: "", method: "POST", path: PATH })
    ).rejects.toThrow("IPFS proxy signing secret is not configured");
  });

  it("matches HMAC output between the proxy guard and the frontend helper", async () => {
    const input = {
      secret: SECRET,
      method: "POST",
      path: PATH,
      body: BODY,
      timestamp: 1_700_000_000,
    };
    const fromGuard = await signProxyRequest(input);
    const fromClient = await signFromClient(input);
    expect(fromClient).toEqual(fromGuard);

    const expected = await hmacSha256Hex(
      SECRET,
      canonicalize({
        timestamp: 1_700_000_000,
        method: "POST",
        path: PATH,
        bodyHash: await sha256Hex(BODY),
      })
    );
    expect(fromGuard.signature).toBe(`t=1700000000,v1=${expected}`);
  });

  it("signs and authorizes DELETE /api/ipfs/unpin/:hash requests", async () => {
    const unpinPath = "/api/ipfs/unpin/QmUnpinTestCID123";
    const signed = await signProxyRequest({
      secret: SECRET,
      method: "DELETE",
      path: unpinPath,
      timestamp: 1_700_000_000,
    });

    const result = await authorizeProxyRequest({
      method: "DELETE",
      path: unpinPath,
      origin: "https://app.spoovault.io",
      signatureHeader: signed.signature,
      secret: SECRET,
      allowedOrigins: ORIGINS,
      now: () => 1_700_000_000,
    });

    expect(result).toEqual({ ok: true });

    const incomingResult = await authorizeIncomingRequest(
      {
        method: "DELETE",
        originalUrl: unpinPath,
        origin: "https://app.spoovault.io",
        signatureHeader: signed.signature,
      },
      {
        secret: SECRET,
        allowedOrigins: ORIGINS,
        now: () => 1_700_000_000,
      }
    );

    expect(incomingResult).toEqual({ ok: true });
  });
});
