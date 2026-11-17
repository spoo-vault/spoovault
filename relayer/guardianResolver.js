"use strict";
/**
 * @file relayer/guardianResolver.ts
 * @description Guardian resolver for the relayer.
 *
 * For every detected AccessRequested event the resolver queries the guardian
 * contacts registry endpoint with the request context and receives the list
 * of guardians that must be notified together with their public keys and
 * delivery channels:
 *
 *   GET {url}?chain=..&requestId=..&documentId=..&requester=..
 *   -> GuardianContact[]
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
exports.GuardianResolver = void 0;
exports.normalizeContacts = normalizeContacts;
var GuardianResolver = /** @class */ (function () {
    function GuardianResolver(opts) {
        var _a;
        this.cache = new Map();
        this.contactsUrl = opts.contactsUrl;
        this.token = opts.token;
        this.timeoutMs = (_a = opts.timeoutMs) !== null && _a !== void 0 ? _a : 5000;
    }
    /** Resolve guardian contacts for an access-request event. */
    GuardianResolver.prototype.resolve = function (event) {
        return __awaiter(this, void 0, void 0, function () {
            var url, cacheKey, cached, controller, timer, response, body, contacts;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        url = new URL(this.contactsUrl);
                        url.searchParams.set("chain", event.chain);
                        url.searchParams.set("contractId", event.contractId);
                        url.searchParams.set("requestId", String(event.requestId));
                        url.searchParams.set("documentId", String(event.documentId));
                        if (event.requester)
                            url.searchParams.set("requester", event.requester.toLowerCase());
                        cacheKey = url.toString();
                        cached = this.cache.get(cacheKey);
                        if (cached && Date.now() - cached.atMs < 30000)
                            return [2 /*return*/, cached.contacts];
                        controller = new AbortController();
                        timer = setTimeout(function () { return controller.abort(); }, this.timeoutMs);
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, , 4, 5]);
                        return [4 /*yield*/, fetch(url, {
                                headers: this.token ? { Authorization: "Bearer ".concat(this.token) } : undefined,
                                signal: controller.signal,
                            })];
                    case 2:
                        response = _a.sent();
                        if (!response.ok)
                            throw new Error("Contacts registry ".concat(response.status));
                        return [4 /*yield*/, response.json()];
                    case 3:
                        body = (_a.sent());
                        contacts = normalizeContacts(body);
                        this.cache.set(cacheKey, { atMs: Date.now(), contacts: contacts });
                        return [2 /*return*/, contacts];
                    case 4:
                        clearTimeout(timer);
                        return [7 /*endfinally*/];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    return GuardianResolver;
}());
exports.GuardianResolver = GuardianResolver;
/** Accepts either a bare array or `{ guardians: [...] }` responses. */
function normalizeContacts(body) {
    var _a;
    var raw = Array.isArray(body)
        ? body
        : body && typeof body === "object" && Array.isArray(body.guardians)
            ? (body.guardians)
            : [];
    var out = [];
    for (var _i = 0, raw_1 = raw; _i < raw_1.length; _i++) {
        var entry = raw_1[_i];
        if (!entry || typeof entry !== "object")
            continue;
        var obj = entry;
        var guardian = typeof obj["guardian"] === "string" ? obj["guardian"] : undefined;
        if (!guardian)
            continue;
        var channelsRaw = ((_a = obj["channels"]) !== null && _a !== void 0 ? _a : {});
        out.push({
            guardian: guardian.toLowerCase(),
            publicKey: typeof obj["publicKey"] === "string" ? obj["publicKey"] : undefined,
            channels: {
                pushWebhook: asString(channelsRaw["pushWebhook"]),
                telegramChatId: asString(channelsRaw["telegramChatId"]),
                email: asString(channelsRaw["email"]),
            },
        });
    }
    return out;
}
function asString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
