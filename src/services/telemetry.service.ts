export type TelemetryLevel = "info" | "warning" | "error";

export interface TelemetryEntry {
  id: string;
  level: TelemetryLevel;
  context: string;
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

const STORAGE_KEY = "spoovault-telemetry-log";
const MAX_STORED_EVENTS = 120;

const getWebhookUrl = (): string => {
  return (
    (import.meta.env.VITE_TELEMETRY_WEBHOOK as string | undefined)?.trim() || ""
  );
};

const sanitize = (value: unknown): unknown => {
  if (typeof value === "string") {
    return value.slice(0, 4000);
  }
  return value;
};

const toMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message || "Unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
};

const readStored = (): TelemetryEntry[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as TelemetryEntry[];
  } catch {
    return [];
  }
};

const writeStored = (entries: TelemetryEntry[]) => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(entries.slice(-MAX_STORED_EVENTS))
    );
  } catch {
    // ignore storage errors
  }
};

const sendWebhook = async (entry: TelemetryEntry) => {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
      keepalive: true,
    });
  } catch {
    // avoid throwing from telemetry pipeline
  }
};

export const captureTelemetry = (
  level: TelemetryLevel,
  context: string,
  message: string,
  metadata?: Record<string, unknown>
) => {
  const entry: TelemetryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    level,
    context,
    message: toMessage(message),
    timestamp: new Date().toISOString(),
    metadata: metadata
      ? (Object.fromEntries(
          Object.entries(metadata).map(([key, value]) => [key, sanitize(value)])
        ) as Record<string, unknown>)
      : undefined,
  };

  const current = readStored();
  current.push(entry);
  writeStored(current);
  sendWebhook(entry);
};

export const captureError = (
  context: string,
  error: unknown,
  metadata?: Record<string, unknown>
) => {
  captureTelemetry("error", context, toMessage(error), metadata);
};

export const getTelemetryEntries = (): TelemetryEntry[] => {
  return readStored();
};
