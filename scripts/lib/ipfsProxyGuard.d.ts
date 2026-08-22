export const UNSIGNED_PAYLOAD: string;
export const SIGNATURE_HEADER: string;
export const DEFAULT_MAX_SKEW_SEC: number;
export const DEFAULT_ALLOWED_ORIGINS: string[];

export function parseAllowedOrigins(
  raw?: string | null,
  fallback?: string[]
): string[];
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: string[]
): boolean;
export function isMultipartContentType(contentType?: string): boolean;
export function toHex(buffer: BufferSource): string;
export function sha256Hex(data: string | BufferSource): Promise<string>;
export function canonicalize(input: {
  timestamp: number;
  method: string;
  path: string;
  bodyHash: string;
}): string;
export function hmacSha256Hex(secret: string, message: string): Promise<string>;
export function formatSignatureHeader(timestamp: number, hex: string): string;
export function parseSignatureHeader(
  value: unknown
): { timestamp: number; v1: string } | null;
export function timingSafeEqualHex(left: unknown, right: unknown): boolean;
export function resolveBodyHash(input?: {
  body?: string;
  unsignedBody?: boolean;
}): Promise<string>;
export function signProxyRequest(input: {
  secret: string;
  method: string;
  path: string;
  body?: string;
  unsignedBody?: boolean;
  timestamp?: number;
  now?: () => number;
}): Promise<{
  timestamp: number;
  signature: string;
  headers: Record<string, string>;
}>;
export function authorizeProxyRequest(input: {
  method: string;
  path: string;
  origin?: string;
  signatureHeader?: string;
  body?: string;
  unsignedBody?: boolean;
  secret?: string;
  allowedOrigins: string[];
  now?: () => number;
  maxSkewSec?: number;
}): Promise<{ ok: boolean; status?: number; error?: string }>;
export function authorizeIncomingRequest(
  request: {
    method?: string;
    originalUrl?: string;
    path?: string;
    origin?: string;
    signatureHeader?: string;
    contentType?: string;
    rawBody?: string;
  },
  env: {
    secret?: string;
    allowedOrigins: string[];
    now?: () => number;
    maxSkewSec?: number;
  }
): Promise<{ ok: boolean; status?: number; error?: string }>;
