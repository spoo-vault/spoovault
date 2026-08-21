/**
 * Pinata IPFS Proxy Server
 *
 * A lightweight Express proxy that forwards IPFS pin/fetch requests to Pinata
 * while keeping the API credentials server-side.
 *
 * Usage (local dev):
 *   PINATA_JWT=your_jwt SPOOVUALT_PROXY_SECRET=your_hmac_secret node scripts/pinata-proxy.mjs
 *   or
 *   PINATA_API_KEY=x PINATA_API_SECRET=y SPOOVUALT_PROXY_SECRET=your_hmac_secret node scripts/pinata-proxy.mjs
 *
 * Endpoints:
 *   POST /api/ipfs/pin-file   - Pin a file to IPFS (multipart/form-data with "file" field)
 *   POST /api/ipfs/pin-json   - Pin a JSON object to IPFS (application/json body)
 *   GET  /api/ipfs/pin-list   - List pinned files
 *
 * Auth:
 *   Pin/list routes require `X-SpooVault-Signature: t=<unix>,v1=<hmac-sha256-hex>`.
 *   CORS is restricted to SPOOVUALT_ALLOWED_ORIGINS (defaults to local Vite URLs).
 *   Unauthorized callers receive 403 Forbidden.
 *
 * For production:
 *   Deploy this file to a Cloud Run, Render, Railway, or similar service.
 *   Keep PINATA_JWT on the server only. Give the app VITE_SPOOVUALT_PROXY_SECRET
 *   (HMAC) plus VITE_IPFS_PROXY_URL=https://your-proxy.example.com.
 *
 * Note: For Firebase Functions deployment, see:
 *   functions/index.js (created separately)
 */

import {
  authorizeIncomingRequest,
  isOriginAllowed,
  parseAllowedOrigins,
} from "./lib/ipfsProxyGuard.mjs";

// Check for required dependencies
let express, multer, fetch, cors;
try {
  const expressModule = await import("express");
  express = expressModule.default;
} catch {
  console.error(
    "❌ 'express' is not installed. Run:\n   npm install --save-dev express multer cors\n"
  );
  process.exit(1);
}
try {
  const multerModule = await import("multer");
  multer = multerModule.default;
} catch {
  console.error(
    "❌ 'multer' is not installed. Run:\n   npm install --save-dev multer\n"
  );
  process.exit(1);
}
try {
  const corsModule = await import("cors");
  cors = corsModule.default;
} catch {
  console.error(
    "❌ 'cors' is not installed. Run:\n   npm install --save-dev cors\n"
  );
  process.exit(1);
}

const PINATA_JWT = process.env.PINATA_JWT || process.env.VITE_PINATA_JWT || "";
const PINATA_API_KEY = process.env.PINATA_API_KEY || process.env.VITE_PINATA_API_KEY || "";
const PINATA_API_SECRET = process.env.PINATA_API_SECRET || process.env.VITE_PINATA_API_SECRET || "";
const PROXY_SECRET =
  process.env.SPOOVUALT_PROXY_SECRET || process.env.VITE_SPOOVUALT_PROXY_SECRET || "";
const ALLOWED_ORIGINS = parseAllowedOrigins(
  process.env.SPOOVUALT_ALLOWED_ORIGINS || process.env.CORS_ALLOWED_ORIGINS
);
const PORT = Number(process.env.PORT) || 3001;

if (!PINATA_JWT && !(PINATA_API_KEY && PINATA_API_SECRET)) {
  console.error(
    "❌ Pinata credentials not found.\n" +
    "   Set PINATA_JWT (recommended) or PINATA_API_KEY + PINATA_API_SECRET environment variables.\n"
  );
  process.exit(1);
}

if (!PROXY_SECRET) {
  console.error(
    "❌ SPOOVUALT_PROXY_SECRET is required so the proxy can reject unsigned pin requests.\n" +
    "   Set SPOOVUALT_PROXY_SECRET (and VITE_SPOOVUALT_PROXY_SECRET for the frontend).\n"
  );
  process.exit(1);
}

const buildPinataHeaders = (includeContentType = false) => {
  const headers = {};
  if (PINATA_JWT) {
    headers["Authorization"] = `Bearer ${PINATA_JWT}`;
  } else {
    headers["pinata_api_key"] = PINATA_API_KEY;
    headers["pinata_api_secret"] = PINATA_API_SECRET;
  }
  if (includeContentType) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
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
    methods: ["GET", "POST", "OPTIONS"],
    maxAge: 600,
  })
);
app.use(
  express.json({
    limit: "50mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

app.use("/api/ipfs", async (req, res, next) => {
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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

/**
 * POST /api/ipfs/pin-file
 * Accepts multipart/form-data with:
 *   - file: the file to pin
 *   - pinataMetadata (optional): JSON string with {name, keyvalues}
 */
app.post("/api/ipfs/pin-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file provided" });
    }

    const { default: FormData } = await import("form-data");
    const formData = new FormData();
    formData.append("file", req.file.buffer, {
      filename: req.file.originalname || "file",
      contentType: req.file.mimetype || "application/octet-stream",
    });

    if (req.body.pinataMetadata) {
      formData.append("pinataMetadata", req.body.pinataMetadata);
    }
    if (req.body.pinataOptions) {
      formData.append("pinataOptions", req.body.pinataOptions);
    }

    const headers = buildPinataHeaders();
    Object.assign(headers, formData.getHeaders());

    const response = await globalThis.fetch(
      "https://api.pinata.cloud/pinning/pinFileToIPFS",
      { method: "POST", headers, body: formData }
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }
    return res.json(data);
  } catch (err) {
    console.error("pin-file error:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

/**
 * POST /api/ipfs/pin-json
 * Accepts JSON body with:
 *   - pinataContent: the object to pin
 *   - pinataMetadata (optional): {name, keyvalues}
 */
app.post("/api/ipfs/pin-json", async (req, res) => {
  try {
    const { pinataContent, pinataMetadata, pinataOptions } = req.body;
    if (!pinataContent) {
      return res.status(400).json({ error: "pinataContent is required" });
    }

    const body = JSON.stringify({ pinataContent, pinataMetadata, pinataOptions });
    const response = await globalThis.fetch(
      "https://api.pinata.cloud/pinning/pinJSONToIPFS",
      { method: "POST", headers: buildPinataHeaders(true), body }
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }
    return res.json(data);
  } catch (err) {
    console.error("pin-json error:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

/**
 * GET /api/ipfs/pin-list
 * Returns a list of pins from the Pinata account.
 */
app.get("/api/ipfs/pin-list", async (req, res) => {
  try {
    const queryParams = new URLSearchParams();
    if (req.query.status) queryParams.set("status", String(req.query.status));
    if (req.query.pageLimit) queryParams.set("pageLimit", String(req.query.pageLimit));
    if (req.query.pageOffset) queryParams.set("pageOffset", String(req.query.pageOffset));

    const url = `https://api.pinata.cloud/data/pinList?${queryParams.toString()}`;
    const response = await globalThis.fetch(url, {
      method: "GET",
      headers: buildPinataHeaders(),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }
    return res.json(data);
  } catch (err) {
    console.error("pin-list error:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n✅ Pinata proxy running at http://localhost:${PORT}`);
  console.log("   CORS origins:", ALLOWED_ORIGINS.join(", "));
  console.log("   Auth: X-SpooVault-Signature required on /api/ipfs/*");
  console.log("   Endpoints:");
  console.log("   POST /api/ipfs/pin-file");
  console.log("   POST /api/ipfs/pin-json");
  console.log("   GET  /api/ipfs/pin-list");
  console.log("   GET  /health\n");
});
