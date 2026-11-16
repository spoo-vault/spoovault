"use strict";
/**
 * @file relayer/config.ts
 * @description Environment-driven configuration for the guardian relayer.
 *
 * Loads `.env` from the repo root when present (no dotenv dependency) and
 * exposes typed settings with safe defaults. Every knob can also be injected
 * directly, which the integration test uses to run against local mock servers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
var node_fs_1 = require("node:fs");
var node_path_1 = require("node:path");
var node_url_1 = require("node:url");
var __dirname = (0, node_path_1.dirname)((0, node_url_1.fileURLToPath)(import.meta.url));
var REPO_ROOT = (0, node_path_1.resolve)(__dirname, "..");
function loadDotEnv(path) {
    if (!(0, node_fs_1.existsSync)(path))
        return;
    for (var _i = 0, _a = (0, node_fs_1.readFileSync)(path, "utf-8").split("\n"); _i < _a.length; _i++) {
        var line = _a[_i];
        var trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        var eqIdx = trimmed.indexOf("=");
        if (eqIdx < 0)
            continue;
        var key = trimmed.slice(0, eqIdx).trim();
        var value = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key])
            process.env[key] = value;
    }
}
function num(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function loadConfig(env) {
    if (env === void 0) { env = process.env; }
    loadDotEnv((0, node_path_1.resolve)(REPO_ROOT, ".env"));
    return {
        evmRpcUrl: env.RELAYER_EVM_RPC_URL || undefined,
        evmContractAddress: env.RELAYER_EVM_CONTRACT_ADDRESS || undefined,
        evmStartBlock: env.RELAYER_EVM_START_BLOCK ? Number(env.RELAYER_EVM_START_BLOCK) : undefined,
        sorobanRpcUrl: env.RELAYER_SOROBAN_RPC_URL || undefined,
        sorobanContractIds: (env.RELAYER_SOROBAN_CONTRACT_IDS || "")
            .split(",")
            .map(function (id) { return id.trim(); })
            .filter(Boolean),
        pollIntervalMs: num(env.RELAYER_POLL_INTERVAL_MS, 1500),
        guardianContactsUrl: env.RELAYER_GUARDIAN_CONTACTS_URL || undefined,
        guardianContactsToken: env.RELAYER_GUARDIAN_CONTACTS_TOKEN || undefined,
        telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
        emailWebhookUrl: env.RELAYER_EMAIL_WEBHOOK_URL || undefined,
        approvalUiBaseUrl: env.RELAYER_APPROVAL_UI_BASE_URL || "http://localhost:5173",
        stateDir: env.RELAYER_STATE_DIR || (0, node_path_1.resolve)(REPO_ROOT, "relayer", ".state"),
        maxAttempts: num(env.RELAYER_MAX_ATTEMPTS, 5),
        retryBaseMs: num(env.RELAYER_RETRY_BASE_MS, 500),
        retryMaxBackoffMs: num(env.RELAYER_RETRY_MAX_BACKOFF_MS, 30000),
        workerTickMs: num(env.RELAYER_WORKER_TICK_MS, 200),
        healthPort: env.RELAYER_HEALTH_PORT ? Number(env.RELAYER_HEALTH_PORT) : undefined,
    };
}
