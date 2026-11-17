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
/**
 * Minimal ABI covering only the functions exercised by the multi-guardian
 * access-approval E2E. This keeps the test independent of the Hardhat build
 * output while still driving the *deployed* SpooVault contract on the local
 * Anvil network.
 */
var ABI = [
    "function createVault(string name, string description, address[] guardians, uint256 approvalThreshold) external returns (uint256)",
    "function acceptGuardianInvite(uint256 vaultId) external",
    "function mintAccessToken(uint256 vaultId, address to, string tokenURIValue) external returns (uint256)",
    "function addDocument(uint256 vaultId, string encryptedMetadata, string ipfsHash, uint8 requiredAccess) external returns (uint256)",
    "function requestAccess(uint256 documentId) external returns (uint256)",
    "function approveAccess(uint256 requestId) external",
    "function isGuardian(uint256 vaultId, address guardian) external view returns (bool)",
    "function hasActiveAccess(uint256 documentId, address user) external view returns (bool)",
    "event VaultCreated(uint256 indexed vaultId, address indexed creator, string name)",
    "event DocumentAdded(uint256 indexed documentId, uint256 indexed vaultId, string ipfsHash)",
    "event AccessRequested(uint256 indexed requestId, uint256 indexed documentId, address indexed requester)",
];
function loadContractAddress() {
    var envPath = (0, node_path_1.resolve)(repoRoot, "e2e", ".env.e2e");
    var text = (0, node_fs_1.readFileSync)(envPath, "utf8");
    var match = text.match(/VITE_CONTRACT_ADDRESS=(0x[0-9a-fA-F]+)/);
    if (!match) {
        throw new Error("e2e/.env.e2e not found. Run `node e2e/scripts/deploy-anvil.mjs` first.");
    }
    return match[1];
}
function firstArg(parsed, name) {
    if ((parsed === null || parsed === void 0 ? void 0 : parsed.name) === name)
        return parsed.args[0];
    return undefined;
}
test_1.test.describe("SpooVault — multi-guardian access approval (EVM contract E2E)", function () {
    (0, test_1.test)("guardian accepts invite, beneficiary requests and is granted access", function () { return __awaiter(void 0, void 0, void 0, function () {
        var provider, mkSigner, deployer, _a, guardianWallet, guardian, _b, beneficiaryWallet, beneficiary, address, contract, guardianContract, beneficiaryContract, createTx, createReceipt, vaultId, _i, _c, log, parsed, id, _d, _e, docTx, docReceipt, documentId, _f, _g, log, parsed, id, reqTx, reqReceipt, requestId, _h, _j, log, parsed, id, _k, _l;
        return __generator(this, function (_m) {
            switch (_m.label) {
                case 0:
                    provider = new ethers_1.JsonRpcProvider(wallets_1.ANVIL_RPC_URL);
                    mkSigner = function (index) {
                        var wallet = new ethers_1.Wallet((0, wallets_1.privateKeyForIndex)(index), provider);
                        return { wallet: wallet, signer: new ethers_1.NonceManager(wallet) };
                    };
                    deployer = mkSigner(0).signer;
                    _a = mkSigner(1), guardianWallet = _a.wallet, guardian = _a.signer;
                    _b = mkSigner(2), beneficiaryWallet = _b.wallet, beneficiary = _b.signer;
                    address = loadContractAddress();
                    contract = new ethers_1.Contract(address, ABI, deployer);
                    guardianContract = new ethers_1.Contract(address, ABI, guardian);
                    beneficiaryContract = new ethers_1.Contract(address, ABI, beneficiary);
                    return [4 /*yield*/, contract.createVault("Guardian E2E Vault", "multi-guardian approval flow", [guardianWallet.address], 1)];
                case 1:
                    createTx = _m.sent();
                    return [4 /*yield*/, createTx.wait()];
                case 2:
                    createReceipt = _m.sent();
                    for (_i = 0, _c = createReceipt.logs; _i < _c.length; _i++) {
                        log = _c[_i];
                        try {
                            parsed = contract.interface.parseLog(log);
                            id = firstArg(parsed, "VaultCreated");
                            if (id !== undefined)
                                vaultId = id;
                        }
                        catch (_o) {
                            /* ignore unrelated logs */
                        }
                    }
                    (0, test_1.expect)(vaultId).toBeDefined();
                    _d = test_1.expect;
                    return [4 /*yield*/, contract.isGuardian(vaultId, guardianWallet.address)];
                case 3:
                    _d.apply(void 0, [_m.sent()]).toBe(false);
                    return [4 /*yield*/, guardianContract.acceptGuardianInvite(vaultId)];
                case 4: 
                // 2) Guardian accepts the invitation -> becomes an active guardian.
                return [4 /*yield*/, (_m.sent()).wait()];
                case 5:
                    // 2) Guardian accepts the invitation -> becomes an active guardian.
                    _m.sent();
                    _e = test_1.expect;
                    return [4 /*yield*/, contract.isGuardian(vaultId, guardianWallet.address)];
                case 6:
                    _e.apply(void 0, [_m.sent()]).toBe(true);
                    return [4 /*yield*/, guardianContract.mintAccessToken(vaultId, beneficiaryWallet.address, "e2e-uri")];
                case 7: 
                // 3) Guardian mints the beneficiary an access token and uploads a document.
                return [4 /*yield*/, (_m.sent()).wait()];
                case 8:
                    // 3) Guardian mints the beneficiary an access token and uploads a document.
                    _m.sent();
                    return [4 /*yield*/, guardianContract.addDocument(vaultId, "encrypted-meta", "ipfs://e2e-document", 0)];
                case 9:
                    docTx = _m.sent();
                    return [4 /*yield*/, docTx.wait()];
                case 10:
                    docReceipt = _m.sent();
                    for (_f = 0, _g = docReceipt.logs; _f < _g.length; _f++) {
                        log = _g[_f];
                        try {
                            parsed = contract.interface.parseLog(log);
                            id = firstArg(parsed, "DocumentAdded");
                            if (id !== undefined)
                                documentId = id;
                        }
                        catch (_p) {
                            /* ignore */
                        }
                    }
                    (0, test_1.expect)(documentId).toBeDefined();
                    return [4 /*yield*/, beneficiaryContract.requestAccess(documentId)];
                case 11:
                    reqTx = _m.sent();
                    return [4 /*yield*/, reqTx.wait()];
                case 12:
                    reqReceipt = _m.sent();
                    for (_h = 0, _j = reqReceipt.logs; _h < _j.length; _h++) {
                        log = _j[_h];
                        try {
                            parsed = contract.interface.parseLog(log);
                            id = firstArg(parsed, "AccessRequested");
                            if (id !== undefined)
                                requestId = id;
                        }
                        catch (_q) {
                            /* ignore */
                        }
                    }
                    (0, test_1.expect)(requestId).toBeDefined();
                    _k = test_1.expect;
                    return [4 /*yield*/, contract.hasActiveAccess(documentId, beneficiaryWallet.address)];
                case 13:
                    _k.apply(void 0, [_m.sent()]).toBe(false);
                    return [4 /*yield*/, guardianContract.approveAccess(requestId)];
                case 14: 
                // 5) Guardian approves the request -> beneficiary gains active access.
                return [4 /*yield*/, (_m.sent()).wait()];
                case 15:
                    // 5) Guardian approves the request -> beneficiary gains active access.
                    _m.sent();
                    _l = test_1.expect;
                    return [4 /*yield*/, contract.hasActiveAccess(documentId, beneficiaryWallet.address)];
                case 16:
                    _l.apply(void 0, [_m.sent()]).toBe(true);
                    return [2 /*return*/];
            }
        });
    }); });
});
