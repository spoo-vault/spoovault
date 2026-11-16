"use strict";
/**
 * @file relayer/listeners.ts
 * @description Multi-chain AccessRequested event listeners.
 *
 * - EvmAccessRequestListener: polls an EVM RPC via ethers queryFilter for
 *   SpooVault's AccessRequested(requestId, documentId, requester) events.
 * - SorobanAccessRequestListener: polls Soroban RPC `getEvents` for
 *   AccessRequested contract events, resuming from an in-memory cursor.
 *
 * Both normalize into {@link AccessRequestEvent}; MultiChainListener merges
 * streams from all configured chains and dedupes by event id.
 */
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
exports.MultiChainListener = exports.SorobanAccessRequestListener = exports.EvmAccessRequestListener = void 0;
var EvmAccessRequestListener = /** @class */ (function () {
    function EvmAccessRequestListener(rpcUrl, contractAddress, opts, startBlock) {
        this.timer = null;
        this.running = false;
        this.lastBlock = null;
        this.provider = null;
        // Dynamically imported ethers Contract, loosely typed on purpose.
        this.contract = null;
        this.rpcUrl = rpcUrl;
        this.contractAddress = contractAddress;
        this.opts = opts;
        this.startBlock = startBlock;
    }
    EvmAccessRequestListener.prototype.start = function () {
        return __awaiter(this, void 0, void 0, function () {
            var ethers, provider, current, _a, startBlock, tick;
            var _this = this;
            var _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("ethers"); })];
                    case 1:
                        ethers = (_c.sent()).ethers;
                        provider = new ethers.JsonRpcProvider(this.rpcUrl, undefined, {
                            staticNetwork: true,
                            batchMaxCount: 1,
                        });
                        this.provider = provider;
                        this.contract = new ethers.Contract(this.contractAddress, [
                            "event AccessRequested(uint256 indexed requestId, uint256 indexed documentId, address indexed requester)",
                        ], provider);
                        _a = Number;
                        return [4 /*yield*/, provider.getBlockNumber()];
                    case 2:
                        current = _a.apply(void 0, [_c.sent()]);
                        startBlock = (_b = this.startBlock) !== null && _b !== void 0 ? _b : 0;
                        this.lastBlock = startBlock > 0 ? Math.min(startBlock - 1, current) : current;
                        this.running = true;
                        tick = function () { return __awaiter(_this, void 0, void 0, function () {
                            var err_1;
                            var _a, _b;
                            return __generator(this, function (_c) {
                                switch (_c.label) {
                                    case 0:
                                        if (!this.running)
                                            return [2 /*return*/];
                                        _c.label = 1;
                                    case 1:
                                        _c.trys.push([1, 3, , 4]);
                                        return [4 /*yield*/, this.poll()];
                                    case 2:
                                        _c.sent();
                                        return [3 /*break*/, 4];
                                    case 3:
                                        err_1 = _c.sent();
                                        (_b = (_a = this.opts).onError) === null || _b === void 0 ? void 0 : _b.call(_a, "evm:".concat(this.contractAddress), err_1);
                                        return [3 /*break*/, 4];
                                    case 4:
                                        if (this.running)
                                            this.timer = setTimeout(function () { return void tick(); }, this.opts.pollIntervalMs);
                                        return [2 /*return*/];
                                }
                            });
                        }); };
                        void tick();
                        return [2 /*return*/];
                }
            });
        });
    };
    EvmAccessRequestListener.prototype.stop = function () {
        var _a, _b;
        this.running = false;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
        (_b = (_a = this.provider) === null || _a === void 0 ? void 0 : _a.destroy) === null || _b === void 0 ? void 0 : _b.call(_a);
        this.provider = null;
        this.contract = null;
    };
    EvmAccessRequestListener.prototype.poll = function () {
        return __awaiter(this, void 0, void 0, function () {
            var head, _a, toBlock, filter, logs, _i, logs_1, log, args;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!this.provider || this.lastBlock === null)
                            return [2 /*return*/];
                        _a = Number;
                        return [4 /*yield*/, this.provider.getBlockNumber()];
                    case 1:
                        head = _a.apply(void 0, [_b.sent()]);
                        toBlock = Math.min(head, this.lastBlock + 5000);
                        if (toBlock <= this.lastBlock)
                            return [2 /*return*/];
                        filter = this.contract.filters.AccessRequested();
                        return [4 /*yield*/, this.contract.queryFilter(filter, this.lastBlock + 1, toBlock)];
                    case 2:
                        logs = _b.sent();
                        for (_i = 0, logs_1 = logs; _i < logs_1.length; _i++) {
                            log = logs_1[_i];
                            args = log.args;
                            this.opts.onEvent({
                                id: "evm:".concat(this.contractAddress.toLowerCase(), ":").concat(log.blockNumber, ":").concat(log.index),
                                chain: "evm",
                                contractId: this.contractAddress,
                                requestId: Number(args[0]),
                                documentId: Number(args[1]),
                                requester: String(args[2]),
                                blockNumber: Number(log.blockNumber),
                                confirmedAt: new Date().toISOString(),
                                detectedAtMs: Date.now(),
                            });
                        }
                        this.lastBlock = toBlock;
                        return [2 /*return*/];
                }
            });
        });
    };
    return EvmAccessRequestListener;
}());
exports.EvmAccessRequestListener = EvmAccessRequestListener;
var SorobanAccessRequestListener = /** @class */ (function () {
    function SorobanAccessRequestListener(rpcUrl, contractIds, opts) {
        this.timer = null;
        this.running = false;
        this.cursors = new Map();
        this.rpcUrl = rpcUrl;
        this.contractIds = contractIds;
        this.opts = opts;
    }
    SorobanAccessRequestListener.prototype.start = function () {
        var _this = this;
        this.running = true;
        var tick = function () { return __awaiter(_this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.running)
                            return [2 /*return*/];
                        return [4 /*yield*/, Promise.allSettled(this.contractIds.map(function (id) { return _this.pollContract(id); }))];
                    case 1:
                        _a.sent();
                        if (this.running)
                            this.timer = setTimeout(function () { return void tick(); }, this.opts.pollIntervalMs);
                        return [2 /*return*/];
                }
            });
        }); };
        void tick();
    };
    SorobanAccessRequestListener.prototype.stop = function () {
        this.running = false;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
    };
    SorobanAccessRequestListener.prototype.pollContract = function (contractId) {
        return __awaiter(this, void 0, void 0, function () {
            var cursor, response, err_2, body, _i, _a, raw, cursorToken, topics, info;
            var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
            return __generator(this, function (_s) {
                switch (_s.label) {
                    case 0:
                        cursor = this.cursors.get(contractId);
                        _s.label = 1;
                    case 1:
                        _s.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, fetch(this.rpcUrl, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    jsonrpc: "2.0",
                                    id: 1,
                                    method: "getEvents",
                                    params: {
                                        filters: [{ type: "contract", contractIds: [contractId] }],
                                        pagination: __assign({ limit: 100 }, (cursor ? { cursor: cursor } : {})),
                                    },
                                }),
                            })];
                    case 2:
                        response = _s.sent();
                        return [3 /*break*/, 4];
                    case 3:
                        err_2 = _s.sent();
                        (_c = (_b = this.opts).onError) === null || _c === void 0 ? void 0 : _c.call(_b, "soroban:".concat(contractId), err_2);
                        return [2 /*return*/];
                    case 4:
                        if (!response.ok) {
                            (_e = (_d = this.opts).onError) === null || _e === void 0 ? void 0 : _e.call(_d, "soroban:".concat(contractId), new Error("Soroban RPC ".concat(response.status)));
                            return [2 /*return*/];
                        }
                        return [4 /*yield*/, response.json()];
                    case 5:
                        body = (_s.sent());
                        if (body.error) {
                            (_g = (_f = this.opts).onError) === null || _g === void 0 ? void 0 : _g.call(_f, "soroban:".concat(contractId), new Error((_h = body.error.message) !== null && _h !== void 0 ? _h : "rpc error"));
                            return [2 /*return*/];
                        }
                        for (_i = 0, _a = (_k = (_j = body.result) === null || _j === void 0 ? void 0 : _j.events) !== null && _k !== void 0 ? _k : []; _i < _a.length; _i++) {
                            raw = _a[_i];
                            cursorToken = (_l = raw.pagingToken) !== null && _l !== void 0 ? _l : raw.id;
                            if (!cursorToken)
                                continue;
                            this.cursors.set(contractId, cursorToken);
                            topics = ((_m = raw.topic) !== null && _m !== void 0 ? _m : []).map(function (t) { return JSON.stringify(t); });
                            if (!topics.some(function (t) { return t.includes("AccessRequested"); }))
                                continue;
                            info = extractSorobanRequestInfo(raw.value);
                            this.opts.onEvent({
                                id: "soroban:".concat(contractId, ":").concat((_o = raw.id) !== null && _o !== void 0 ? _o : cursorToken),
                                chain: "soroban",
                                contractId: contractId,
                                requestId: info.requestId,
                                documentId: info.documentId,
                                requester: (_p = info.requester) !== null && _p !== void 0 ? _p : "",
                                blockNumber: Number((_q = raw.ledger) !== null && _q !== void 0 ? _q : 0),
                                confirmedAt: (_r = raw.ledgerClosedAt) !== null && _r !== void 0 ? _r : new Date().toISOString(),
                                detectedAtMs: Date.now(),
                            });
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    return SorobanAccessRequestListener;
}());
exports.SorobanAccessRequestListener = SorobanAccessRequestListener;
/** Best-effort extraction of request ids from Soroban SCVal-shaped payloads. */
function extractSorobanRequestInfo(value) {
    var out = { requestId: 0, documentId: 0, requester: undefined };
    var readNumber = function (v) {
        if (typeof v === "number")
            return v;
        if (typeof v === "string" && /^\d+$/.test(v))
            return Number(v);
        if (v && typeof v === "object") {
            var obj = v;
            for (var _i = 0, _a = ["u64", "u32", "i64", "u128", "value"]; _i < _a.length; _i++) {
                var key = _a[_i];
                if (key in obj)
                    return readNumber(obj[key]);
            }
        }
        return 0;
    };
    var readString = function (v) {
        if (typeof v === "string")
            return v;
        if (v && typeof v === "object") {
            var obj = v;
            if (typeof obj["symbol"] === "string")
                return obj["symbol"];
            if (typeof obj["string"] === "string")
                return obj["string"];
        }
        return undefined;
    };
    if (Array.isArray(value)) {
        out.requestId = readNumber(value[0]);
        out.documentId = readNumber(value[1]);
        out.requester = readString(value[2]);
    }
    else if (value && typeof value === "object") {
        var obj = value;
        for (var _i = 0, _a = ["request_id", "requestId"]; _i < _a.length; _i++) {
            var key = _a[_i];
            if (key in obj)
                out.requestId = readNumber(obj[key]);
        }
        for (var _b = 0, _c = ["document_id", "documentId"]; _b < _c.length; _b++) {
            var key = _c[_b];
            if (key in obj)
                out.documentId = readNumber(obj[key]);
        }
        out.requester = readString(obj["requester"]);
    }
    return out;
}
/** Fans normalized events out to a single consumer, deduping across chains. */
var MultiChainListener = /** @class */ (function () {
    function MultiChainListener(opts) {
        this.seen = new Set();
        this.sources = [];
        this.opts = opts;
    }
    MultiChainListener.prototype.addEvm = function (rpcUrl, contractAddress, startBlock) {
        this.sources.push(new EvmAccessRequestListener(rpcUrl, contractAddress, this.childOpts(), startBlock));
    };
    MultiChainListener.prototype.addSoroban = function (rpcUrl, contractIds) {
        this.sources.push(new SorobanAccessRequestListener(rpcUrl, contractIds, this.childOpts()));
    };
    MultiChainListener.prototype.start = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, Promise.all(this.sources.map(function (source) { return source.start(); }))];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    MultiChainListener.prototype.stop = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, Promise.all(this.sources.map(function (source) { return source.stop(); }))];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    MultiChainListener.prototype.stats = function () {
        return this.seen.size;
    };
    MultiChainListener.prototype.emitNew = function (event) {
        if (this.seen.has(event.id))
            return;
        this.seen.add(event.id);
        this.opts.onEvent(event);
    };
    MultiChainListener.prototype.childOpts = function () {
        var _this = this;
        return {
            pollIntervalMs: this.opts.pollIntervalMs,
            onEvent: function (event) { return _this.emitNew(event); },
            onError: function (source, err) { var _a, _b; return (_b = (_a = _this.opts).onError) === null || _b === void 0 ? void 0 : _b.call(_a, source, err); },
        };
    };
    return MultiChainListener;
}());
exports.MultiChainListener = MultiChainListener;
