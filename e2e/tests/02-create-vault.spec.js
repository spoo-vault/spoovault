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
var test_with_metamask_1 = require("../support/test-with-metamask");
var wallets_1 = require("../wallets");
test_with_metamask_1.test.describe("SpooVault — vault creation flow (EVM / MetaMask)", function () {
    (0, test_with_metamask_1.test)("creates a vault through the UI and submits the on-chain transaction", function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
        var vaultName;
        var page = _b.page, metamask = _b.metamask;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, page.goto("/vaults")];
                case 1:
                    _c.sent();
                    // Connect MetaMask and select the local Anvil (Fuji-equivalent) network.
                    return [4 /*yield*/, page
                            .getByRole("button", { name: /Connect Wallet/i })
                            .first()
                            .click()];
                case 2:
                    // Connect MetaMask and select the local Anvil (Fuji-equivalent) network.
                    _c.sent();
                    return [4 /*yield*/, metamask.connectToDapp()];
                case 3:
                    _c.sent();
                    return [4 /*yield*/, metamask.switchNetwork(wallets_1.E2E_CHAIN_NAME, true)];
                case 4:
                    _c.sent();
                    return [4 /*yield*/, (0, test_with_metamask_1.expect)(page.getByText(/Avalanche Fuji Online/i)).toBeVisible({
                            timeout: 30000,
                        })];
                case 5:
                    _c.sent();
                    // Open the create-vault modal directly via the deep link the app listens for.
                    return [4 /*yield*/, page.goto("/vaults?create=true")];
                case 6:
                    // Open the create-vault modal directly via the deep link the app listens for.
                    _c.sent();
                    return [4 /*yield*/, (0, test_with_metamask_1.expect)(page.getByPlaceholder(/Family Estate Records/i)).toBeVisible({
                            timeout: 15000,
                        })];
                case 7:
                    _c.sent();
                    vaultName = "E2E Vault ".concat(Date.now());
                    return [4 /*yield*/, page.getByPlaceholder(/Family Estate Records/i).fill(vaultName)];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, page
                            .getByPlaceholder(/Describe which files/i)
                            .fill("E2E automated encrypted document vault")];
                case 9:
                    _c.sent();
                    // Add a guardian (validated Ethereum address).
                    return [4 /*yield*/, page
                            .getByPlaceholder(/guardian's Ethereum address/i)
                            .fill(wallets_1.GUARDIAN_ADDRESS)];
                case 10:
                    // Add a guardian (validated Ethereum address).
                    _c.sent();
                    return [4 /*yield*/, page.getByRole("button", { name: /^Add$/i }).click()];
                case 11:
                    _c.sent();
                    return [4 /*yield*/, (0, test_with_metamask_1.expect)(page.getByText(wallets_1.GUARDIAN_ADDRESS)).toBeVisible()];
                case 12:
                    _c.sent();
                    // Submit -> MetaMask transaction (createVault, followed by configureVaultRelease).
                    return [4 /*yield*/, page
                            .getByRole("button", { name: /Create Access Vault/i })
                            .last()
                            .click()];
                case 13:
                    // Submit -> MetaMask transaction (createVault, followed by configureVaultRelease).
                    _c.sent();
                    return [4 /*yield*/, metamask.confirmTransaction()];
                case 14:
                    _c.sent();
                    // configureVaultRelease is sent immediately after the vault is created.
                    return [4 /*yield*/, page.waitForTimeout(2500)];
                case 15:
                    // configureVaultRelease is sent immediately after the vault is created.
                    _c.sent();
                    return [4 /*yield*/, metamask.confirmTransaction()];
                case 16:
                    _c.sent();
                    return [4 /*yield*/, (0, test_with_metamask_1.expect)(page.getByText(/created successfully/i)).toBeVisible({
                            timeout: 60000,
                        })];
                case 17:
                    _c.sent();
                    return [4 /*yield*/, (0, test_with_metamask_1.expect)(page.getByText(vaultName)).toBeVisible()];
                case 18:
                    _c.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
