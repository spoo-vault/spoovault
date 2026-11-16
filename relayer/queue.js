"use strict";
/**
 * @file relayer/queue.ts
 * @description Durable in-process relay queue with automatic retries.
 *
 * BullMQ/Redis is intentionally not required: this queue persists its journal
 * atomically to disk after every transition, survives restarts, dedupes jobs
 * by id and retries failures with exponential backoff before dead-lettering.
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
exports.DurableRelayQueue = void 0;
var node_fs_1 = require("node:fs");
var node_path_1 = require("node:path");
var MAX_COMPLETED_IDS = 2000;
var MAX_DEAD_JOBS = 100;
var DurableRelayQueue = /** @class */ (function () {
    function DurableRelayQueue(opts) {
        var _a, _b, _c, _d, _e;
        this.state = { jobs: [], completedIds: [], dead: [] };
        this.timer = null;
        this.inFlight = null;
        this.stopped = true;
        this.file = (0, node_path_1.join)(opts.stateDir, "queue-".concat(opts.name, ".json"));
        this.handler = opts.handler;
        this.maxAttempts = (_a = opts.maxAttempts) !== null && _a !== void 0 ? _a : 5;
        this.retryBaseMs = (_b = opts.retryBaseMs) !== null && _b !== void 0 ? _b : 500;
        this.retryMaxBackoffMs = (_c = opts.retryMaxBackoffMs) !== null && _c !== void 0 ? _c : 30000;
        this.tickMs = (_d = opts.tickMs) !== null && _d !== void 0 ? _d : 200;
        this.now = (_e = opts.now) !== null && _e !== void 0 ? _e : Date.now;
        this.load();
    }
    DurableRelayQueue.prototype.load = function () {
        if (!(0, node_fs_1.existsSync)(this.file))
            return;
        try {
            var parsed = JSON.parse((0, node_fs_1.readFileSync)(this.file, "utf-8"));
            if (Array.isArray(parsed.jobs))
                this.state.jobs = parsed.jobs;
            if (Array.isArray(parsed.completedIds))
                this.state.completedIds = parsed.completedIds;
            if (Array.isArray(parsed.dead))
                this.state.dead = parsed.dead;
        }
        catch (_a) {
            // Corrupt journal: keep running from an empty state rather than crash.
        }
    };
    DurableRelayQueue.prototype.persist = function () {
        try {
            (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(this.file), { recursive: true });
            var tmp = "".concat(this.file, ".tmp");
            (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(this.state), "utf-8");
            (0, node_fs_1.renameSync)(tmp, this.file);
        }
        catch (err) {
            console.error("[queue] Failed to persist state:", err);
        }
    };
    /** Enqueue a job. Duplicate ids (active or recently completed) are ignored. */
    DurableRelayQueue.prototype.enqueue = function (id, payload) {
        var seen = this.state.jobs.some(function (job) { return job.id === id; }) ||
            this.state.completedIds.includes(id) ||
            this.state.dead.some(function (job) { return job.id === id; });
        if (seen)
            return false;
        this.state.jobs.push({ id: id, payload: payload, attempts: 0, nextAttemptAtMs: this.now() });
        this.persist();
        return true;
    };
    DurableRelayQueue.prototype.start = function () {
        var _this = this;
        if (!this.stopped)
            return;
        this.stopped = false;
        var tick = function () {
            if (_this.stopped)
                return;
            void _this.pump().finally(function () {
                if (!_this.stopped)
                    _this.timer = setTimeout(tick, _this.tickMs);
            });
        };
        tick();
    };
    DurableRelayQueue.prototype.stop = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        this.stopped = true;
                        if (this.timer)
                            clearTimeout(this.timer);
                        this.timer = null;
                        if (!this.inFlight) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.inFlight];
                    case 1:
                        _a.sent();
                        _a.label = 2;
                    case 2: return [2 /*return*/];
                }
            });
        });
    };
    DurableRelayQueue.prototype.pump = function () {
        return __awaiter(this, void 0, void 0, function () {
            var dueIndex, job;
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        dueIndex = this.state.jobs.findIndex(function (job) { return job.nextAttemptAtMs <= _this.now(); });
                        if (dueIndex === -1 || this.inFlight)
                            return [2 /*return*/];
                        job = this.state.jobs[dueIndex];
                        job.attempts += 1;
                        this.inFlight = (function () { return __awaiter(_this, void 0, void 0, function () {
                            var err_1, message, backoff;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0:
                                        _a.trys.push([0, 2, 3, 4]);
                                        return [4 /*yield*/, this.handler(job.payload, job)];
                                    case 1:
                                        _a.sent();
                                        this.state.jobs.splice(dueIndex, 1);
                                        this.state.completedIds.push(job.id);
                                        if (this.state.completedIds.length > MAX_COMPLETED_IDS) {
                                            this.state.completedIds.splice(0, this.state.completedIds.length - MAX_COMPLETED_IDS);
                                        }
                                        this.persist();
                                        return [3 /*break*/, 4];
                                    case 2:
                                        err_1 = _a.sent();
                                        message = err_1 instanceof Error ? err_1.message : String(err_1);
                                        if (job.attempts >= this.maxAttempts) {
                                            this.state.jobs.splice(dueIndex, 1);
                                            this.state.dead.push(__assign(__assign({}, job), { error: message }));
                                            if (this.state.dead.length > MAX_DEAD_JOBS)
                                                this.state.dead.shift();
                                            console.error("[queue] Job ".concat(job.id, " dead-lettered after ").concat(job.attempts, " attempts: ").concat(message));
                                        }
                                        else {
                                            backoff = Math.min(this.retryBaseMs * Math.pow(2, job.attempts - 1), this.retryMaxBackoffMs);
                                            job.nextAttemptAtMs = this.now() + backoff;
                                            job.lastError = message;
                                            console.warn("[queue] Job ".concat(job.id, " failed (attempt ").concat(job.attempts, "), retry in ").concat(backoff, "ms"));
                                        }
                                        this.persist();
                                        return [3 /*break*/, 4];
                                    case 3:
                                        this.inFlight = null;
                                        return [7 /*endfinally*/];
                                    case 4: return [2 /*return*/];
                                }
                            });
                        }); })();
                        return [4 /*yield*/, this.inFlight];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    DurableRelayQueue.prototype.stats = function () {
        return {
            pending: this.state.jobs.length,
            inflight: this.inFlight !== null,
            completed: this.state.completedIds.length,
            dead: this.state.dead.length,
        };
    };
    return DurableRelayQueue;
}());
exports.DurableRelayQueue = DurableRelayQueue;
