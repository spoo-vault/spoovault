"use strict";
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
var test_1 = require("@playwright/test");
var node_fs_1 = require("node:fs");
var node_url_1 = require("node:url");
var node_path_1 = require("node:path");
var ethers_1 = require("ethers");
var wallets_1 = require("../wallets");
var __dirname = (0, node_path_1.dirname)((0, node_url_1.fileURLToPath)(import.meta.url));
var repoRoot = (0, node_path_1.resolve)(__dirname, "..", "..");
var ABI = [
    "function createVault(string name, string description, address[] guardians, uint256 approvalThreshold) external returns (uint256)",
    "function acceptGuardianInvite(uint256 vaultId) external",
    "function addDocumentWithReleaseCondition(uint256 vaultId, string encryptedMetadata, string ipfsHash, uint8 requiredAccess, uint8 releaseCondition) external returns (uint256)",
    "function mintAccessToken(uint256 vaultId, address to, string tokenURIValue) external returns (uint256)",
    "function requestAccess(uint256 documentId) external returns (uint256)",
    "function approveAccess(uint256 requestId) external",
    "function isGuardian(uint256 vaultId, address guardian) external view returns (bool)",
    "function hasActiveAccess(uint256 documentId, address user) external view returns (bool)",
    "function setEmergencyMode(uint256 vaultId, bool enabled) external",
    "function configureVaultRelease(uint256 vaultId, uint256 inactivityPeriod) external",
    "function proveLife(uint256 vaultId) external",
    "function getVaultReleaseState(uint256 vaultId) external view returns (bool emergencyMode, uint256 inactivityPeriod, uint256 lastProofOfLife, bool postDeathUnlocked)",
    "event VaultCreated(uint256 indexed vaultId, address indexed creator, string name)",
    "event DocumentAdded(uint256 indexed documentId, uint256 indexed vaultId, string ipfsHash)",
    "event AccessRequested(uint256 indexed requestId, uint256 indexed documentId, address indexed requester)",
    "event EmergencyModeUpdated(uint256 indexed vaultId, bool enabled)",
    "event VaultReleaseConfigured(uint256 indexed vaultId, uint256 inactivityPeriod)",
    "event ProofOfLifeRecorded(uint256 indexed vaultId, address indexed owner, uint256 timestamp)",
];
var ReleaseCondition = {
    ANYTIME: 0,
    LIVE_ONLY: 1,
    EMERGENCY_ONLY: 2,
    POST_DEATH_ONLY: 3,
};
var DAY = 24 * 60 * 60;
function loadContractAddress() {
    var envPath = (0, node_path_1.resolve)(repoRoot, "e2e", ".env.e2e");
    var text = (0, node_fs_1.readFileSync)(envPath, "utf8");
    var match = text.match(/VITE_CONTRACT_ADDRESS=(0x[0-9a-fA-F]+)/);
    if (!match) {
        throw new Error("e2e/.env.e2e not found. Run `node e2e/scripts/deploy-anvil.mjs` first.");
    }
    return match[1];
}
function extractEventId(receipt, contract, eventName) {
    return __awaiter(this, void 0, void 0, function () {
        var _i, _a, log, parsed;
        return __generator(this, function (_b) {
            for (_i = 0, _a = receipt.logs; _i < _a.length; _i++) {
                log = _a[_i];
                try {
                    parsed = contract.interface.parseLog(log);
                    if ((parsed === null || parsed === void 0 ? void 0 : parsed.name) === eventName) {
                        return [2 /*return*/, parsed.args[0]];
                    }
                }
                catch (_c) {
                    /* ignore unrelated logs */
                }
            }
            return [2 /*return*/, undefined];
        });
    });
}
function increaseTime(provider, seconds) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, provider.send("evm_increaseTime", [seconds])];
                case 1:
                    _a.sent();
                    return [4 /*yield*/, provider.send("evm_mine", [])];
                case 2:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
test_1.test.describe("SpooVault — emergency mode & post-death document release (EVM contract E2E)", function () {
    (0, test_1.test)("emergency mode trigger enables EMERGENCY_ONLY document release", function () { return __awaiter(void 0, void 0, void 0, function () {
        var provider, deployer, guardian, beneficiary, address, contract, guardianContract, beneficiaryContract, createTx, createReceipt, vaultId, _a, docTx, docReceipt, documentId, emergTx, emergReceipt, state, reqTx, reqReceipt, requestId, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    provider = new ethers_1.JsonRpcProvider(wallets_1.ANVIL_RPC_URL);
                    deployer = new ethers_1.Wallet((0, wallets_1.privateKeyForIndex)(0), provider);
                    guardian = new ethers_1.Wallet((0, wallets_1.privateKeyForIndex)(1), provider);
                    beneficiary = new ethers_1.Wallet((0, wallets_1.privateKeyForIndex)(2), provider);
                    address = loadContractAddress();
                    contract = new ethers_1.Contract(address, ABI, deployer);
                    guardianContract = new ethers_1.Contract(address, ABI, guardian);
                    beneficiaryContract = new ethers_1.Contract(address, ABI, beneficiary);
                    return [4 /*yield*/, contract.createVault("Emergency E2E Vault", "emergency mode release flow", [guardian.address], 1)];
                case 1:
                    createTx = _c.sent();
                    return [4 /*yield*/, createTx.wait()];
                case 2:
                    createReceipt = _c.sent();
                    return [4 /*yield*/, extractEventId(createReceipt, contract, "VaultCreated")];
                case 3:
                    vaultId = _c.sent();
                    (0, test_1.expect)(vaultId).toBeDefined();
                    (0, test_1.expect)(vaultId).toBeGreaterThan(0);
                    return [4 /*yield*/, guardianContract.acceptGuardianInvite(vaultId)];
                case 4: 
                // 2) Guardian accepts the invitation.
                return [4 /*yield*/, (_c.sent()).wait()];
                case 5:
                    // 2) Guardian accepts the invitation.
                    _c.sent();
                    _a = test_1.expect;
                    return [4 /*yield*/, contract.isGuardian(vaultId, guardian.address)];
                case 6:
                    _a.apply(void 0, [_c.sent()]).toBe(true);
                    return [4 /*yield*/, guardianContract.mintAccessToken(vaultId, beneficiary.address, "e2e-emergency-uri")];
                case 7: 
                // 3) Guardian mints an access token for the beneficiary (required to request documents).
                return [4 /*yield*/, (_c.sent()).wait()];
                case 8:
                    // 3) Guardian mints an access token for the beneficiary (required to request documents).
                    _c.sent();
                    return [4 /*yield*/, guardianContract.addDocumentWithReleaseCondition(vaultId, "encrypted-meta", "ipfs://e2e-emergency-document", 0, ReleaseCondition.EMERGENCY_ONLY)];
                case 9:
                    docTx = _c.sent();
                    return [4 /*yield*/, docTx.wait()];
                case 10:
                    docReceipt = _c.sent();
                    return [4 /*yield*/, extractEventId(docReceipt, contract, "DocumentAdded")];
                case 11:
                    documentId = _c.sent();
                    (0, test_1.expect)(documentId).toBeDefined();
                    (0, test_1.expect)(documentId).toBeGreaterThan(0);
                    // 5) Beneficiary cannot request access while emergency mode is OFF (ReleaseConditionLocked).
                    return [4 /*yield*/, (0, test_1.expect)(beneficiaryContract.requestAccess(documentId)).rejects.toThrow()];
                case 12:
                    // 5) Beneficiary cannot request access while emergency mode is OFF (ReleaseConditionLocked).
                    _c.sent();
                    return [4 /*yield*/, contract.setEmergencyMode(vaultId, true)];
                case 13:
                    emergTx = _c.sent();
                    return [4 /*yield*/, emergTx.wait()];
                case 14:
                    emergReceipt = _c.sent();
                    return [4 /*yield*/, contract.getVaultReleaseState(vaultId)];
                case 15:
                    state = _c.sent();
                    (0, test_1.expect)(state.emergencyMode).toBe(true);
                    return [4 /*yield*/, beneficiaryContract.requestAccess(documentId)];
                case 16:
                    reqTx = _c.sent();
                    return [4 /*yield*/, reqTx.wait()];
                case 17:
                    reqReceipt = _c.sent();
                    return [4 /*yield*/, extractEventId(reqReceipt, contract, "AccessRequested")];
                case 18:
                    requestId = _c.sent();
                    (0, test_1.expect)(requestId).toBeDefined();
                    (0, test_1.expect)(requestId).toBeGreaterThan(0);
                    return [4 /*yield*/, guardianContract.approveAccess(requestId)];
                case 19: return [4 /*yield*/, (_c.sent()).wait()];
                case 20:
                    _c.sent();
                    // 8) Beneficiary now has active access.
                    _b = test_1.expect;
                    return [4 /*yield*/, contract.hasActiveAccess(documentId, beneficiary.address)];
                case 21:
                    // 8) Beneficiary now has active access.
                    _b.apply(void 0, [_c.sent()]).toBe(true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)("post-death release unlocks POST_DEATH_ONLY documents after inactivity period", function () { return __awaiter(void 0, void 0, void 0, function () {
        var provider, deployer, guardian, beneficiary, address, contract, guardianContract, beneficiaryContract, createTx, createReceipt, vaultId, stateBefore, _a, docTx, docReceipt, documentId, stateAfter, reqTx, reqReceipt, requestId, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    provider = new ethers_1.JsonRpcProvider(wallets_1.ANVIL_RPC_URL);
                    deployer = new ethers_1.Wallet((0, wallets_1.privateKeyForIndex)(0), provider);
                    guardian = new ethers_1.Wallet((0, wallets_1.privateKeyForIndex)(1), provider);
                    beneficiary = new ethers_1.Wallet((0, wallets_1.privateKeyForIndex)(2), provider);
                    address = loadContractAddress();
                    contract = new ethers_1.Contract(address, ABI, deployer);
                    guardianContract = new ethers_1.Contract(address, ABI, guardian);
                    beneficiaryContract = new ethers_1.Contract(address, ABI, beneficiary);
                    return [4 /*yield*/, contract.createVault("PostDeath E2E Vault", "post-death release flow", [guardian.address], 1)];
                case 1:
                    createTx = _c.sent();
                    return [4 /*yield*/, createTx.wait()];
                case 2:
                    createReceipt = _c.sent();
                    return [4 /*yield*/, extractEventId(createReceipt, contract, "VaultCreated")];
                case 3:
                    vaultId = _c.sent();
                    (0, test_1.expect)(vaultId).toBeDefined();
                    return [4 /*yield*/, contract.configureVaultRelease(vaultId, DAY)];
                case 4: 
                // 2) Configure a 1-day inactivity period (minimum allowed by the contract).
                return [4 /*yield*/, (_c.sent()).wait()];
                case 5:
                    // 2) Configure a 1-day inactivity period (minimum allowed by the contract).
                    _c.sent();
                    return [4 /*yield*/, contract.getVaultReleaseState(vaultId)];
                case 6:
                    stateBefore = _c.sent();
                    (0, test_1.expect)(stateBefore.inactivityPeriod).toBe(BigInt(DAY));
                    (0, test_1.expect)(stateBefore.postDeathUnlocked).toBe(false);
                    return [4 /*yield*/, guardianContract.acceptGuardianInvite(vaultId)];
                case 7: 
                // 3) Guardian accepts invite, mints token, and adds a POST_DEATH_ONLY document.
                return [4 /*yield*/, (_c.sent()).wait()];
                case 8:
                    // 3) Guardian accepts invite, mints token, and adds a POST_DEATH_ONLY document.
                    _c.sent();
                    _a = test_1.expect;
                    return [4 /*yield*/, contract.isGuardian(vaultId, guardian.address)];
                case 9:
                    _a.apply(void 0, [_c.sent()]).toBe(true);
                    return [4 /*yield*/, guardianContract.mintAccessToken(vaultId, beneficiary.address, "e2e-postdeath-uri")];
                case 10: return [4 /*yield*/, (_c.sent()).wait()];
                case 11:
                    _c.sent();
                    return [4 /*yield*/, guardianContract.addDocumentWithReleaseCondition(vaultId, "encrypted-meta", "ipfs://e2e-postdeath-document", 0, ReleaseCondition.POST_DEATH_ONLY)];
                case 12:
                    docTx = _c.sent();
                    return [4 /*yield*/, docTx.wait()];
                case 13:
                    docReceipt = _c.sent();
                    return [4 /*yield*/, extractEventId(docReceipt, contract, "DocumentAdded")];
                case 14:
                    documentId = _c.sent();
                    (0, test_1.expect)(documentId).toBeDefined();
                    // 4) Beneficiary cannot request access while not post-death.
                    return [4 /*yield*/, (0, test_1.expect)(beneficiaryContract.requestAccess(documentId)).rejects.toThrow()];
                case 15:
                    // 4) Beneficiary cannot request access while not post-death.
                    _c.sent();
                    // 5) Simulate time passing beyond the inactivity window.
                    return [4 /*yield*/, increaseTime(provider, DAY * 2)];
                case 16:
                    // 5) Simulate time passing beyond the inactivity window.
                    _c.sent();
                    return [4 /*yield*/, contract.getVaultReleaseState(vaultId)];
                case 17:
                    stateAfter = _c.sent();
                    (0, test_1.expect)(stateAfter.postDeathUnlocked).toBe(true);
                    return [4 /*yield*/, beneficiaryContract.requestAccess(documentId)];
                case 18:
                    reqTx = _c.sent();
                    return [4 /*yield*/, reqTx.wait()];
                case 19:
                    reqReceipt = _c.sent();
                    return [4 /*yield*/, extractEventId(reqReceipt, contract, "AccessRequested")];
                case 20:
                    requestId = _c.sent();
                    (0, test_1.expect)(requestId).toBeDefined();
                    return [4 /*yield*/, guardianContract.approveAccess(requestId)];
                case 21: return [4 /*yield*/, (_c.sent()).wait()];
                case 22:
                    _c.sent();
                    // 8) Beneficiary has active access.
                    _b = test_1.expect;
                    return [4 /*yield*/, contract.hasActiveAccess(documentId, beneficiary.address)];
                case 23:
                    // 8) Beneficiary has active access.
                    _b.apply(void 0, [_c.sent()]).toBe(true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, test_1.test)("creator can record proof of life to keep vault in live mode", function () { return __awaiter(void 0, void 0, void 0, function () {
        var provider, deployer, guardian, address, contract, guardianContract, createTx, createReceipt, vaultId, tx, state;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    provider = new ethers_1.JsonRpcProvider(wallets_1.ANVIL_RPC_URL);
                    deployer = new ethers_1.Wallet((0, wallets_1.privateKeyForIndex)(0), provider);
                    guardian = new ethers_1.Wallet((0, wallets_1.privateKeyForIndex)(1), provider);
                    address = loadContractAddress();
                    contract = new ethers_1.Contract(address, ABI, deployer);
                    guardianContract = new ethers_1.Contract(address, ABI, guardian);
                    return [4 /*yield*/, contract.createVault("Heartbeat E2E Vault", "proof-of-life flow", [guardian.address], 1)];
                case 1:
                    createTx = _a.sent();
                    return [4 /*yield*/, createTx.wait()];
                case 2:
                    createReceipt = _a.sent();
                    return [4 /*yield*/, extractEventId(createReceipt, contract, "VaultCreated")];
                case 3:
                    vaultId = _a.sent();
                    (0, test_1.expect)(vaultId).toBeDefined();
                    return [4 /*yield*/, contract.proveLife(vaultId)];
                case 4:
                    tx = _a.sent();
                    return [4 /*yield*/, tx.wait()];
                case 5:
                    _a.sent();
                    return [4 /*yield*/, contract.getVaultReleaseState(vaultId)];
                case 6:
                    state = _a.sent();
                    (0, test_1.expect)(state.lastProofOfLife).toBeGreaterThan(0);
                    (0, test_1.expect)(state.emergencyMode).toBe(false);
                    return [2 /*return*/];
            }
        });
    }); });
});
