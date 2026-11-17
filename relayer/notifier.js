"use strict";
/**
 * @file relayer/notifier.ts
 * @description Builds structured guardian notifications and dispatches them
 * through Push / Email / Telegram channels.
 *
 * Every notification embeds a deep link straight into the approval UI
 * (`/access`). When a guardian published an X25519 public key, the full
 * notification is encrypted to that key and channels only carry the opaque
 * envelope plus a short plaintext pointer.
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
exports.NotificationService = void 0;
exports.buildNotification = buildNotification;
exports.renderText = renderText;
var crypto_ts_1 = require("./crypto.ts");
function buildNotification(event, opts) {
    var base = opts.approvalUiBaseUrl.replace(/\/+$/, "");
    var params = new URLSearchParams({
        requestId: String(event.requestId),
        documentId: String(event.documentId),
        chain: event.chain,
    });
    return {
        type: "access_request",
        title: "Guardian approval requested (#".concat(event.requestId, ")"),
        body: "An access request for document ".concat(event.documentId, " was filed on ").concat(event.chain, ". ") +
            "Review and approve it in the SpooVault access center.",
        requestId: event.requestId,
        documentId: event.documentId,
        requester: event.requester,
        chain: event.chain,
        contractId: event.contractId,
        deepLink: "".concat(base, "/access?").concat(params.toString()),
        confirmedAt: event.confirmedAt,
    };
}
var NotificationService = /** @class */ (function () {
    function NotificationService(opts) {
        var _a;
        this.approvalUiBaseUrl = opts.approvalUiBaseUrl;
        this.telegramBotToken = opts.telegramBotToken;
        this.emailWebhookUrl = opts.emailWebhookUrl;
        this.requestTimeoutMs = (_a = opts.requestTimeoutMs) !== null && _a !== void 0 ? _a : 10000;
    }
    /** Create one durable dispatch job per reachable guardian contact. */
    NotificationService.prototype.buildJobs = function (event, contacts) {
        var notification = buildNotification(event, this);
        var jobs = [];
        for (var _i = 0, contacts_1 = contacts; _i < contacts_1.length; _i++) {
            var contact = contacts_1[_i];
            if (!this.isReachable(contact))
                continue;
            jobs.push({
                id: "".concat(event.id, ":").concat(contact.guardian.toLowerCase()),
                eventId: event.id,
                contact: contact,
                notification: notification,
                encryptedPayload: contact.publicKey
                    ? (0, crypto_ts_1.encryptForGuardian)(contact.publicKey, notification)
                    : undefined,
                createdAtMs: Date.now(),
            });
        }
        return jobs;
    };
    /**
     * Queue worker handler. Throws when a delivery attempt fails so the
     * queue schedules an automatic retry with backoff.
     */
    NotificationService.prototype.dispatch = function (job) {
        return __awaiter(this, void 0, void 0, function () {
            var delivered, failed, pushWebhook, err_1, telegramChatId, err_2, email, err_3;
            var _a, _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        delivered = [];
                        failed = [];
                        pushWebhook = (_a = job.contact.channels) === null || _a === void 0 ? void 0 : _a.pushWebhook;
                        if (!pushWebhook) return [3 /*break*/, 4];
                        _d.label = 1;
                    case 1:
                        _d.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, postJson(pushWebhook, this.envelope(job), this.requestTimeoutMs)];
                    case 2:
                        _d.sent();
                        delivered.push("push");
                        return [3 /*break*/, 4];
                    case 3:
                        err_1 = _d.sent();
                        failed.push("push: ".concat(message(err_1)));
                        return [3 /*break*/, 4];
                    case 4:
                        telegramChatId = (_b = job.contact.channels) === null || _b === void 0 ? void 0 : _b.telegramChatId;
                        if (!(telegramChatId && this.telegramBotToken)) return [3 /*break*/, 8];
                        _d.label = 5;
                    case 5:
                        _d.trys.push([5, 7, , 8]);
                        return [4 /*yield*/, postJson("https://api.telegram.org/bot".concat(this.telegramBotToken, "/sendMessage"), {
                                chat_id: telegramChatId,
                                text: renderText(job),
                                disable_web_page_preview: false,
                            }, this.requestTimeoutMs)];
                    case 6:
                        _d.sent();
                        delivered.push("telegram");
                        return [3 /*break*/, 8];
                    case 7:
                        err_2 = _d.sent();
                        failed.push("telegram: ".concat(message(err_2)));
                        return [3 /*break*/, 8];
                    case 8:
                        email = (_c = job.contact.channels) === null || _c === void 0 ? void 0 : _c.email;
                        if (!(email && this.emailWebhookUrl)) return [3 /*break*/, 12];
                        _d.label = 9;
                    case 9:
                        _d.trys.push([9, 11, , 12]);
                        return [4 /*yield*/, postJson(this.emailWebhookUrl, { to: email, subject: job.notification.title, text: renderText(job) }, this.requestTimeoutMs)];
                    case 10:
                        _d.sent();
                        delivered.push("email");
                        return [3 /*break*/, 12];
                    case 11:
                        err_3 = _d.sent();
                        failed.push("email: ".concat(message(err_3)));
                        return [3 /*break*/, 12];
                    case 12:
                        if (delivered.length === 0 && failed.length > 0) {
                            throw new Error("All channels failed for ".concat(job.id, ": ").concat(failed.join("; ")));
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    /** Wire-format payload sent to channels: encrypted envelope when available. */
    NotificationService.prototype.envelope = function (job) {
        if (!job.encryptedPayload) {
            return { v: 1, kind: "spoovault.guardian.notification", notification: job.notification };
        }
        return {
            v: 1,
            kind: "spoovault.guardian.encrypted",
            pointer: job.notification.title,
            envelope: job.encryptedPayload,
        };
    };
    NotificationService.prototype.isReachable = function (contact) {
        var _a;
        var channels = (_a = contact.channels) !== null && _a !== void 0 ? _a : {};
        return Boolean(channels.pushWebhook ||
            (channels.telegramChatId && this.telegramBotToken) ||
            (channels.email && this.emailWebhookUrl));
    };
    return NotificationService;
}());
exports.NotificationService = NotificationService;
/** Human-readable message body used by Telegram/Email transports. */
function renderText(job) {
    var n = job.notification;
    var lines = [
        n.title,
        "",
        n.body,
        "",
        "Chain: ".concat(n.chain, " | Request: #").concat(n.requestId, " | Document: ").concat(n.documentId),
        "Approve: ".concat(n.deepLink),
    ];
    if (job.encryptedPayload)
        lines.push("", "[encrypted] ".concat(job.encryptedPayload));
    return lines.join("\n");
}
function postJson(url, body, timeoutMs) {
    return __awaiter(this, void 0, void 0, function () {
        var controller, timer, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    timer = setTimeout(function () { return controller.abort(); }, timeoutMs);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, , 3, 4]);
                    return [4 /*yield*/, fetch(url, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(body),
                            signal: controller.signal,
                        })];
                case 2:
                    response = _a.sent();
                    if (!response.ok)
                        throw new Error("".concat(url, " responded ").concat(response.status));
                    return [3 /*break*/, 4];
                case 3:
                    clearTimeout(timer);
                    return [7 /*endfinally*/];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function message(err) {
    return err instanceof Error ? err.message : String(err);
}
