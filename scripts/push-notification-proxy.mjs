/**
 * Push Protocol (EPNS) Notification Proxy Server
 *
 * A lightweight Express proxy that sends beneficiary push notifications on
 * emergency-mode/post-death-unlock state changes, while keeping the Push
 * Protocol channel signing key server-side.
 *
 * Usage (local dev):
 *   PUSH_CHANNEL_PRIVATE_KEY=your_channel_or_delegate_key SPOOVUALT_PROXY_SECRET=your_hmac_secret node scripts/push-notification-proxy.mjs
 *
 * Endpoints:
 *   POST /api/notifications/emergency-mode - Notify a vault's beneficiary that
 *     emergency mode was toggled ({ vaultId, beneficiary, enabled } JSON body).
 *
 * Auth:
 *   Requires `X-SpooVault-Signature: t=<unix>,v1=<hmac-sha256-hex>` (same scheme
 *   as the IPFS proxy). CORS is restricted to SPOOVUALT_ALLOWED_ORIGINS.
 *   Unauthorized callers receive 403 Forbidden.
 *
 * Setup prerequisite:
 *   Sending notifications requires a Push Protocol channel to already exist
 *   (see https://comms.push.org/docs/notifications/tutorials/create-your-channel/).
 *   PUSH_CHANNEL_PRIVATE_KEY must be the channel owner's key, or a wallet added
 *   as a delegate on that channel. There is no way to send notifications without
 *   a signer tied to a provisioned channel.
 *
 * For production:
 *   Deploy this file to a Cloud Run, Render, Railway, or similar service.
 *   Keep PUSH_CHANNEL_PRIVATE_KEY on the server only. Give the app
 *   VITE_SPOOVUALT_PROXY_SECRET (HMAC) plus VITE_PUSH_NOTIFICATION_PROXY_URL=https://your-proxy.example.com.
 */

import {
  authorizeIncomingRequest,
  isOriginAllowed,
  parseAllowedOrigins,
} from "./lib/ipfsProxyGuard.mjs";

let express, cors, ethers, PushAPI, CONSTANTS;
try {
  const expressModule = await import("express");
  express = expressModule.default;
} catch {
  console.error("❌ 'express' is not installed. Run:\n   npm install --save-dev express cors\n");
  process.exit(1);
}
try {
  const corsModule = await import("cors");
  cors = corsModule.default;
} catch {
  console.error("❌ 'cors' is not installed. Run:\n   npm install --save-dev cors\n");
  process.exit(1);
}
try {
  const ethersModule = await import("ethers");
  ethers = ethersModule.ethers ?? ethersModule;
} catch {
  console.error("❌ 'ethers' is not installed. Run:\n   npm install --save-dev ethers\n");
  process.exit(1);
}
try {
  const restapiModule = await import("@pushprotocol/restapi");
  PushAPI = restapiModule.PushAPI;
  CONSTANTS = restapiModule.CONSTANTS;
} catch {
  console.error(
    "❌ '@pushprotocol/restapi' is not installed. Run:\n   npm install --save-dev @pushprotocol/restapi\n"
  );
  process.exit(1);
}

const PUSH_CHANNEL_PRIVATE_KEY = process.env.PUSH_CHANNEL_PRIVATE_KEY || "";
const PUSH_ENV = process.env.PUSH_ENV || "staging";
const PROXY_SECRET =
  process.env.SPOOVUALT_PROXY_SECRET || process.env.VITE_SPOOVUALT_PROXY_SECRET || "";
const ALLOWED_ORIGINS = parseAllowedOrigins(
  process.env.SPOOVUALT_ALLOWED_ORIGINS || process.env.CORS_ALLOWED_ORIGINS
);
const PORT = Number(process.env.PORT) || 3002;

if (!PUSH_CHANNEL_PRIVATE_KEY) {
  console.error(
    "❌ Push Protocol channel credentials not found.\n" +
    "   Set PUSH_CHANNEL_PRIVATE_KEY to the channel owner's or a delegate's private key.\n" +
    "   A Push Protocol channel must already be provisioned - see\n" +
    "   https://comms.push.org/docs/notifications/tutorials/create-your-channel/\n"
  );
  process.exit(1);
}

if (!PROXY_SECRET) {
  console.error(
    "❌ SPOOVUALT_PROXY_SECRET is required so the proxy can reject unsigned requests.\n" +
    "   Set SPOOVUALT_PROXY_SECRET (and VITE_SPOOVUALT_PROXY_SECRET for the frontend).\n"
  );
  process.exit(1);
}

const isValidAddress = (value) => {
  try {
    return typeof value === "string" && ethers.isAddress(value);
  } catch {
    return false;
  }
};

const buildNotificationCopy = (vaultId, enabled) => ({
  title: enabled ? "Vault Emergency Mode Activated" : "Vault Emergency Mode Deactivated",
  body: enabled
    ? `Vault #${vaultId} has entered Emergency Mode. Review the vault for post-death unlock details.`
    : `Vault #${vaultId} has exited Emergency Mode.`,
});

let cachedUserAlice = null;
const getSigner = async () => {
  if (cachedUserAlice) {
    return cachedUserAlice;
  }
  const signer = new ethers.Wallet(PUSH_CHANNEL_PRIVATE_KEY);
  cachedUserAlice = await PushAPI.initialize(signer, {
    env: CONSTANTS.ENV[PUSH_ENV.toUpperCase()] || CONSTANTS.ENV.STAGING,
  });
  return cachedUserAlice;
};

const app = express();
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, isOriginAllowed(origin, ALLOWED_ORIGINS));
    },
    allowedHeaders: ["Content-Type", "X-SpooVault-Signature"],
    methods: ["POST", "OPTIONS"],
    maxAge: 600,
  })
);
app.use(
  express.json({
    limit: "16kb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

app.use("/api/notifications", async (req, res, next) => {
  const result = await authorizeIncomingRequest(
    {
      method: req.method,
      originalUrl: req.originalUrl,
      origin: req.headers.origin,
      signatureHeader: req.headers["x-spoovault-signature"],
      contentType: req.headers["content-type"],
      rawBody: req.rawBody,
    },
    { secret: PROXY_SECRET, allowedOrigins: ALLOWED_ORIGINS }
  );
  if (!result.ok) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return next();
});

/**
 * POST /api/notifications/emergency-mode
 * Body: { vaultId: number, beneficiary: string, enabled: boolean }
 */
app.post("/api/notifications/emergency-mode", async (req, res) => {
  try {
    const { vaultId, beneficiary, enabled } = req.body || {};

    if (!Number.isFinite(Number(vaultId))) {
      return res.status(400).json({ error: "vaultId is required" });
    }
    if (!isValidAddress(beneficiary)) {
      return res.status(400).json({ error: "beneficiary must be a valid address" });
    }
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }

    const userAlice = await getSigner();
    const { title, body } = buildNotificationCopy(vaultId, enabled);

    await userAlice.channel.send([beneficiary], {
      notification: { title, body },
    });

    return res.json({ status: "sent" });
  } catch (err) {
    console.error("emergency-mode notification error:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n✅ Push notification proxy running at http://localhost:${PORT}`);
  console.log("   CORS origins:", ALLOWED_ORIGINS.join(", "));
  console.log("   Auth: X-SpooVault-Signature required on /api/notifications/*");
  console.log("   Endpoints:");
  console.log("   POST /api/notifications/emergency-mode");
  console.log("   GET  /health\n");
});
