/**
 * HMAC request authentication and CORS origin checks for the Pinata IPFS proxy.
 *
 * Browser callers send `X-SpooVault-Signature: t=<unix>,v1=<hex>` where v1 is
 * HMAC-SHA256(secret, `${timestamp}.${METHOD}.${path}.${bodyHash}`).
 * Multipart pin-file uploads use the literal body hash UNSIGNED-PAYLOAD because
 * the client cannot canonicalize the browser-generated multipart boundary.
 */

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const SIGNATURE_HEADER = "X-SpooVault-Signature";
export const DEFAULT_MAX_SKEW_SEC = 300;
export const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:4173",
];

const encoder = new TextEncoder();

export const parseAllowedOrigins = (
  raw,
  fallback = DEFAULT_ALLOWED_ORIGINS
) => {
  if (raw == null || String(raw).trim() === "") {
    return [...fallback];
  }
  const parsed = String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
};

export const isOriginAllowed = (origin, allowedOrigins) => {
  if (!origin) {
    return true;
  }
  if (allowedOrigins.includes("*")) {
    return true;
  }
  return allowedOrigins.includes(origin);
};

export const isMultipartContentType = (contentType) => {
  return String(contentType || "")
    .toLowerCase()
    .includes("multipart/form-data");
};

export const toHex = (buffer) => {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const sha256Hex = async (data) => {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
};

export const canonicalize = ({ timestamp, method, path, bodyHash }) => {
  return `${timestamp}.${String(method).toUpperCase()}.${path}.${bodyHash}`;
};

export const hmacSha256Hex = async (secret, message) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message)
  );
  return toHex(signature);
};

export const formatSignatureHeader = (timestamp, hex) => {
  return `t=${timestamp},v1=${hex}`;
};

export const parseSignatureHeader = (value) => {
  if (!value || typeof value !== "string") {
    return null;
  }
  const parts = {};
  for (const piece of value.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator < 0) {
      parts[trimmed] = "";
      continue;
    }
    parts[trimmed.slice(0, separator).trim()] = trimmed
      .slice(separator + 1)
      .trim();
  }
  const timestamp = Number(parts.t);
  const v1 = String(parts.v1 || "").toLowerCase();
  if (!Number.isFinite(timestamp) || !v1) {
    return null;
  }
  return { timestamp, v1 };
};

export const timingSafeEqualHex = (left, right) => {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    left.length !== right.length
  ) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
};

export const resolveBodyHash = async ({
  body = "",
  unsignedBody = false,
} = {}) => {
  if (unsignedBody) {
    return UNSIGNED_PAYLOAD;
  }
  return sha256Hex(body ?? "");
};

export const signProxyRequest = async ({
  secret,
  method,
  path,
  body = "",
  unsignedBody = false,
  timestamp,
  now = () => Math.floor(Date.now() / 1000),
}) => {
  if (!secret) {
    throw new Error("IPFS proxy signing secret is not configured");
  }
  const ts = timestamp ?? now();
  const bodyHash = await resolveBodyHash({ body, unsignedBody });
  const canonical = canonicalize({ timestamp: ts, method, path, bodyHash });
  const v1 = await hmacSha256Hex(secret, canonical);
  const signature = formatSignatureHeader(ts, v1);
  return {
    timestamp: ts,
    signature,
    headers: {
      [SIGNATURE_HEADER]: signature,
    },
  };
};

const forbidden = { ok: false, status: 403, error: "Forbidden" };

export const authorizeProxyRequest = async ({
  method,
  path,
  origin,
  signatureHeader,
  body = "",
  unsignedBody = false,
  secret,
  allowedOrigins,
  now = () => Math.floor(Date.now() / 1000),
  maxSkewSec = DEFAULT_MAX_SKEW_SEC,
}) => {
  if (String(method || "").toUpperCase() === "OPTIONS") {
    return { ok: true };
  }
  if (!secret) {
    return forbidden;
  }
  if (!isOriginAllowed(origin, allowedOrigins)) {
    return forbidden;
  }
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    return forbidden;
  }
  if (Math.abs(now() - parsed.timestamp) > maxSkewSec) {
    return forbidden;
  }
  const bodyHash = await resolveBodyHash({ body, unsignedBody });
  const canonical = canonicalize({
    timestamp: parsed.timestamp,
    method,
    path,
    bodyHash,
  });
  const expected = await hmacSha256Hex(secret, canonical);
  if (!timingSafeEqualHex(expected, parsed.v1)) {
    return forbidden;
  }
  return { ok: true };
};

export const authorizeIncomingRequest = async (request, env) => {
  const unsignedBody = isMultipartContentType(request.contentType);
  return authorizeProxyRequest({
    method: request.method,
    path: String(request.originalUrl || request.path || "").split("#")[0],
    origin: request.origin,
    signatureHeader: request.signatureHeader,
    body: unsignedBody ? "" : request.rawBody ?? "",
    unsignedBody,
    secret: env.secret,
    allowedOrigins: env.allowedOrigins,
    now: env.now,
    maxSkewSec: env.maxSkewSec,
  });
};
