"use strict";
/**
 * @file relayer/main.ts
 * @description SpooVault guardian notification relayer entrypoint.
 *
 * Listens for AccessRequested events across EVM and Soroban chains, resolves
 * guardian contacts, and dispatches encrypted Push/Email/Telegram
 * notifications through a durable retry queue.
 *
 * Usage: node relayer/main.ts   (Node >= 22.6 runs TS natively)
 * Configuration: see .env.example (RELAYER_* variables).
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRelayer = createRelayer;
var node_http_1 = require("node:http");
var node_path_1 = require("node:path");
var node_url_1 = require("node:url");
var config_ts_1 = require("./config.ts");
var guardianResolver_ts_1 = require("./guardianResolver.ts");
var listeners_ts_1 = require("./listeners.ts");
var notifier_ts_1 = require("./notifier.ts");
var queue_ts_1 = require("./queue.ts");
/** Wires all relayer components together; also used by the integration test. */
function createRelayer(config) {
    var startedAtMs = Date.now();
    var eventsDetected = 0;
    var notificationsQueued = 0;
    var notifier = new notifier_ts_1.NotificationService({
        approvalUiBaseUrl: config.approvalUiBaseUrl,
        telegramBotToken: config.telegramBotToken,
        emailWebhookUrl: config.emailWebhookUrl,
    });
    var resolver = config.guardianContactsUrl
        ? new guardianResolver_ts_1.GuardianResolver({
            contactsUrl: config.guardianContactsUrl,
            token: config.guardianContactsToken,
        })
        : null;
    var queue = new queue_ts_1.DurableRelayQueue({
        name: "guardian-notifications",
        stateDir: config.stateDir,
        maxAttempts: config.maxAttempts,
        retryBaseMs: config.retryBaseMs,
        retryMaxBackoffMs: config.retryMaxBackoffMs,
        tickMs: config.workerTickMs,
        handler: function (job) { return notifier.dispatch(job); },
    });
    var listener = new listeners_ts_1.MultiChainListener({
        pollIntervalMs: config.pollIntervalMs,
        onError: function (source, err) {
            return console.error("[listener:".concat(source, "]"), err instanceof Error ? err.message : err);
        },
        onEvent: function (event) { return void handleEvent(event); },
    });
    if (config.evmRpcUrl && config.evmContractAddress) {
        listener.addEvm(config.evmRpcUrl, config.evmContractAddress, config.evmStartBlock);
    }
    if (config.sorobanRpcUrl && config.sorobanContractIds.length > 0) {
        listener.addSoroban(config.sorobanRpcUrl, config.sorobanContractIds);
    }
    function handleEvent(event) {
        return __awaiter(this, void 0, void 0, function () {
            var contacts, jobs, _i, jobs_1, job, err_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        eventsDetected += 1;
                        console.log("[relayer] AccessRequested detected: ".concat(event.id, " (request ").concat(event.requestId, ", document ").concat(event.documentId, ")"));
                        if (!resolver) {
                            console.warn("[relayer] No RELAYER_GUARDIAN_CONTACTS_URL configured; dropping event");
                            return [2 /*return*/];
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, resolver.resolve(event)];
                    case 2:
                        contacts = _a.sent();
                        jobs = notifier.buildJobs(event, contacts);
                        for (_i = 0, jobs_1 = jobs; _i < jobs_1.length; _i++) {
                            job = jobs_1[_i];
                            if (queue.enqueue(job.id, job))
                                notificationsQueued += 1;
                        }
                        return [3 /*break*/, 4];
                    case 3:
                        err_1 = _a.sent();
                        // Resolution failure must not lose the event: rethrowing would only kill
                        // the poll loop, so log loudly instead; listeners keep their cursors and
                        // the registry can be retried on the next matching event.
                        console.error("[relayer] Failed to dispatch event ".concat(event.id, ":"), err_1);
                        return [3 /*break*/, 4];
                    case 4: return [2 /*return*/];
                }
            });
        });
    }
    return {
        start: function () {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, listener.start()];
                        case 1:
                            _a.sent();
                            queue.start();
                            console.log("[relayer] Started: poll=".concat(config.pollIntervalMs, "ms, chains=") +
                                [
                                    config.evmContractAddress ? "evm" : null,
                                    config.sorobanContractIds.length > 0 ? "soroban" : null,
                                ]
                                    .filter(Boolean)
                                    .join(","));
                            return [2 /*return*/];
                    }
                });
            });
        },
        stop: function () {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            listener.stop();
                            return [4 /*yield*/, queue.stop()];
                        case 1:
                            _a.sent();
                            return [2 /*return*/];
                    }
                });
            });
        },
        health: function () {
            var _a;
            return {
                status: "ok",
                uptimeMs: Date.now() - startedAtMs,
                pollIntervalMs: config.pollIntervalMs,
                chains: {
                    evm: (_a = config.evmContractAddress) !== null && _a !== void 0 ? _a : null,
                    sorobanContracts: config.sorobanContractIds,
                },
                eventsDetected: eventsDetected,
                notificationsQueued: notificationsQueued,
                queue: queue.stats(),
            };
        },
    };
}
function startHealthServer(relayer, port) {
    var server = (0, node_http_1.createServer)(function (req, res) {
        if (req.url === "/health" || req.url === "/healthz") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(relayer.health()));
            return;
        }
        res.writeHead(404).end();
    });
    server.listen(port);
    return server;
}
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var config, relayer, healthServer, shutdown;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    config = (0, config_ts_1.loadConfig)();
                    if (!config.evmContractAddress && config.sorobanContractIds.length === 0) {
                        console.error("No chains configured. Set RELAYER_EVM_CONTRACT_ADDRESS and/or RELAYER_SOROBAN_CONTRACT_IDS.");
                        process.exit(1);
                    }
                    if (!config.guardianContactsUrl) {
                        console.error("RELAYER_GUARDIAN_CONTACTS_URL is required to resolve guardians.");
                        process.exit(1);
                    }
                    relayer = createRelayer(config);
                    return [4 /*yield*/, relayer.start()];
                case 1:
                    _a.sent();
                    healthServer = config.healthPort
                        ? startHealthServer(relayer, config.healthPort)
                        : null;
                    if (healthServer) {
                        console.log("[relayer] Health endpoint on http://localhost:".concat(config.healthPort, "/health"));
                    }
                    shutdown = function (signal) {
                        console.log("[relayer] ".concat(signal, " received, shutting down..."));
                        void relayer.stop().then(function () {
                            healthServer === null || healthServer === void 0 ? void 0 : healthServer.close();
                            process.exit(0);
                        });
                    };
                    process.on("SIGINT", function () { return shutdown("SIGINT"); });
                    process.on("SIGTERM", function () { return shutdown("SIGTERM"); });
                    return [2 /*return*/];
            }
        });
    });
}
var isEntrypoint = process.argv[1] !== undefined &&
    import.meta.url === (0, node_url_1.pathToFileURL)((0, node_path_1.resolve)(process.argv[1])).href;
if (isEntrypoint) {
    main().catch(function (err) {
        console.error("[relayer] Fatal:", err);
        process.exit(1);
    });
}
