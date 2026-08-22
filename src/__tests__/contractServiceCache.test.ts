import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockContract = {
  interface: { getFunction: vi.fn(() => ({})) },
  hasActiveAccess: vi.fn(),
  getVault: vi.fn(),
  acceptGuardianInvite: vi.fn(),
  approveAccess: vi.fn(),
  burnAccessToken: vi.fn(),
  mintAccessToken: vi.fn(),
  configureVaultRelease: vi.fn(),
  proveLife: vi.fn(),
  setEmergencyMode: vi.fn(),
  getLogs: vi.fn(),
};

const mockProvider = {
  getCode: vi.fn(),
  getBlockNumber: vi.fn(),
  waitForTransaction: vi.fn(),
  getLogs: vi.fn(),
};

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  // Must be `function`, not an arrow function: these are invoked with `new`,
  // and only a function returning an object can override the constructed `this`.
  const JsonRpcProvider = vi.fn().mockImplementation(function () {
    return mockProvider;
  });
  const Contract = vi.fn().mockImplementation(function () {
    return mockContract;
  });
  // contract.service.ts uses `import { ethers } from "ethers"` (the bundled
  // namespace export), which holds its own copies of JsonRpcProvider/Contract
  // separate from the package's top-level named exports — both must be
  // patched or the real classes still run underneath and hit live RPC URLs.
  return {
    ...actual,
    JsonRpcProvider,
    Contract,
    ethers: {
      ...(actual as any).ethers,
      JsonRpcProvider,
      Contract,
    },
  };
});

import { Interface } from "ethers";
import { contractService } from "../services/contract.service";

const CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111";
const USER = "0x2222222222222222222222222222222222222222";

const fakeVaultTuple = (id: number) => [
  BigInt(id),
  "0x3333333333333333333333333333333333333333",
  `Vault ${id}`,
  "description",
  [] as string[],
  BigInt(1),
  true,
  BigInt(1_700_000_000),
];

const receipt = { hash: "0xtxhash", logs: [] as any[] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VITE_CONTRACT_ADDRESS", CONTRACT_ADDRESS);

  mockProvider.getCode.mockResolvedValue("0xabc123");
  mockProvider.getBlockNumber.mockResolvedValue(1_000);
  mockProvider.waitForTransaction.mockResolvedValue(receipt);
  mockProvider.getLogs.mockResolvedValue([]);

  mockContract.getVault.mockImplementation((id: bigint | number) =>
    Promise.resolve(fakeVaultTuple(Number(id)))
  );
  mockContract.hasActiveAccess.mockResolvedValue(true);
  mockContract.acceptGuardianInvite.mockResolvedValue({ hash: "0xaccept" });
  mockContract.approveAccess.mockResolvedValue({ hash: "0xapprove" });
  mockContract.burnAccessToken.mockResolvedValue({ hash: "0xburn" });
  mockContract.mintAccessToken.mockResolvedValue({ hash: "0xmint" });
  mockContract.configureVaultRelease.mockResolvedValue({ hash: "0xconfigure" });
  mockContract.proveLife.mockResolvedValue({ hash: "0xprove" });
  mockContract.setEmergencyMode.mockResolvedValue({ hash: "0xemergency" });

  contractService.initialize(mockProvider as any, mockProvider as any);
});

afterEach(() => {
  contractService.clear();
  vi.unstubAllEnvs();
});

describe("contractService read-call TTL cache", () => {
  it("hasActiveAccess: serves repeated calls within the 10s window from cache, then re-hits RPC after expiry", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    const start = Date.now();
    nowSpy.mockReturnValue(start);

    await contractService.hasActiveAccess(1, USER);
    await contractService.hasActiveAccess(1, USER);
    expect(mockContract.hasActiveAccess).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(start + 10_001);

    await contractService.hasActiveAccess(1, USER);
    expect(mockContract.hasActiveAccess).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it("getActiveAccessMap: a batched Promise.all over many documentIds issues one RPC call per unique id, not per caller", async () => {
    const docIds = [1, 2, 3];

    await contractService.getActiveAccessMap(USER, docIds);
    expect(mockContract.hasActiveAccess).toHaveBeenCalledTimes(3);

    await contractService.getActiveAccessMap(USER, docIds);
    expect(mockContract.hasActiveAccess).toHaveBeenCalledTimes(3);
  });

  it("getActiveAccessMap and hasActiveAccess share the same cache entries for the same (documentId, user)", async () => {
    await contractService.hasActiveAccess(5, USER);
    expect(mockContract.hasActiveAccess).toHaveBeenCalledTimes(1);

    await contractService.getActiveAccessMap(USER, [5]);
    expect(mockContract.hasActiveAccess).toHaveBeenCalledTimes(1);
  });

  it("fetchVaultsByIds: caches contract.getVault per vault id across calls within the TTL window", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    const start = Date.now();
    nowSpy.mockReturnValue(start);

    await contractService.fetchVaultsByIds([10, 20]);
    expect(mockContract.getVault).toHaveBeenCalledTimes(2);

    await contractService.fetchVaultsByIds([10, 20]);
    expect(mockContract.getVault).toHaveBeenCalledTimes(2);

    nowSpy.mockReturnValue(start + 10_001);
    await contractService.fetchVaultsByIds([10, 20]);
    expect(mockContract.getVault).toHaveBeenCalledTimes(4);

    nowSpy.mockRestore();
  });

  it("fetchVaults() shares the getVault cache with fetchVaultsByIds for the same vault id", async () => {
    await contractService.fetchVaultsByIds([1]);
    expect(mockContract.getVault).toHaveBeenCalledTimes(1);

    const vaultCreatedIface = new Interface([
      "event VaultCreated(uint256 indexed vaultId, address indexed creator, string name)",
    ]);
    const encoded = vaultCreatedIface.encodeEventLog(
      vaultCreatedIface.getEvent("VaultCreated")!,
      [1n, "0x3333333333333333333333333333333333333333", "Vault 1"]
    );
    mockProvider.getLogs.mockResolvedValue([
      {
        address: CONTRACT_ADDRESS,
        blockNumber: 500,
        blockHash: "0xblock",
        data: encoded.data,
        topics: encoded.topics,
        index: 0,
        transactionHash: "0xtx",
        transactionIndex: 0,
        removed: false,
      },
    ]);

    await contractService.fetchVaults();

    // Same vault id (1) discovered via the VaultCreated log — still a cache hit.
    expect(mockContract.getVault).toHaveBeenCalledTimes(1);
  });
});

describe("contractService write-path cache invalidation", () => {
  it("acceptGuardianInvite invalidates the cached getVault entry for that vault (guardians array changed on-chain)", async () => {
    await contractService.fetchVaultsByIds([7]);
    expect(mockContract.getVault).toHaveBeenCalledTimes(1);

    await contractService.acceptGuardianInvite(7);

    await contractService.fetchVaultsByIds([7]);
    expect(mockContract.getVault).toHaveBeenCalledTimes(2);
  });

  it("approveAccess invalidates the hasActiveAccess cache (approval can grant access)", async () => {
    await contractService.hasActiveAccess(3, USER);
    expect(mockContract.hasActiveAccess).toHaveBeenCalledTimes(1);

    await contractService.approveAccess(999);

    await contractService.hasActiveAccess(3, USER);
    expect(mockContract.hasActiveAccess).toHaveBeenCalledTimes(2);
  });

  it("burnAccessToken invalidates the hasActiveAccess cache (burning revokes all grants for that owner+vault)", async () => {
    await contractService.hasActiveAccess(4, USER);
    expect(mockContract.hasActiveAccess).toHaveBeenCalledTimes(1);

    await contractService.burnAccessToken(42);

    await contractService.hasActiveAccess(4, USER);
    expect(mockContract.hasActiveAccess).toHaveBeenCalledTimes(2);
  });

  it("mintAccessToken does NOT invalidate hasActiveAccess (minting never retroactively grants document access)", async () => {
    await contractService.hasActiveAccess(6, USER);
    expect(mockContract.hasActiveAccess).toHaveBeenCalledTimes(1);

    await contractService.mintAccessToken(7, USER, "ipfs://token");

    await contractService.hasActiveAccess(6, USER);
    expect(mockContract.hasActiveAccess).toHaveBeenCalledTimes(1);
  });

  it("configureVaultRelease / proveLife / setEmergencyMode do NOT invalidate getVault (they only touch VaultReleaseState, not the getVault tuple)", async () => {
    await contractService.fetchVaultsByIds([8]);
    expect(mockContract.getVault).toHaveBeenCalledTimes(1);

    await contractService.configureVaultRelease(8, 60 * 60 * 24);
    await contractService.recordProofOfLife(8);
    await contractService.setEmergencyMode(8, true);

    await contractService.fetchVaultsByIds([8]);
    expect(mockContract.getVault).toHaveBeenCalledTimes(1);
  });

  it("contractService.clear() resets both the getVault and hasActiveAccess caches", async () => {
    await contractService.fetchVaultsByIds([9]);
    await contractService.hasActiveAccess(9, USER);
    expect(mockContract.getVault).toHaveBeenCalledTimes(1);
    expect(mockContract.hasActiveAccess).toHaveBeenCalledTimes(1);

    contractService.clear();
    contractService.initialize(mockProvider as any, mockProvider as any);

    await contractService.fetchVaultsByIds([9]);
    await contractService.hasActiveAccess(9, USER);
    expect(mockContract.getVault).toHaveBeenCalledTimes(2);
    expect(mockContract.hasActiveAccess).toHaveBeenCalledTimes(2);
  });
});

describe("RPC volume reduction during Vaults -> Documents -> AccessCenter navigation", () => {
  it("reduces getVault + hasActiveAccess RPC calls by more than 80% across three navigation loops within the 10s window", async () => {
    const vaultIds = [1, 2, 3, 4, 5];
    const documentIds = [10, 20, 30, 40, 50, 60, 70, 80];

    // Mirrors what Vaults.tsx / Documents.tsx / AccessCenter.tsx each call from
    // their loadData() on mount today (see src/pages/*.tsx): every page reads
    // the account's vaults, and Documents/AccessCenter additionally read the
    // per-document access map. Looping 3x simulates a user bouncing between
    // the three tabs a few times inside the 10s TTL window.
    for (let loop = 0; loop < 3; loop++) {
      await contractService.fetchVaultsByIds(vaultIds); // Vaults.tsx
      await contractService.fetchVaultsByIds(vaultIds); // Documents.tsx
      await contractService.getActiveAccessMap(USER, documentIds);
      await contractService.fetchVaultsByIds(vaultIds); // AccessCenter.tsx
      await contractService.getActiveAccessMap(USER, documentIds);
    }

    const actualCalls =
      mockContract.getVault.mock.calls.length +
      mockContract.hasActiveAccess.mock.calls.length;

    // Before this fix there was no cache at all: every one of the 9 fetchVaultsByIds
    // calls issued vaultIds.length real getVault calls, and every one of the 6
    // getActiveAccessMap calls issued documentIds.length real hasActiveAccess calls.
    const baselineCallsBeforeFix = 9 * vaultIds.length + 6 * documentIds.length;

    const reduction =
      (baselineCallsBeforeFix - actualCalls) / baselineCallsBeforeFix;

    expect(actualCalls).toBe(vaultIds.length + documentIds.length); // 5 + 8 = 13: one warm-up each
    expect(baselineCallsBeforeFix).toBe(93); // 9*5 + 6*8
    expect(reduction).toBeGreaterThan(0.8);
  });
});
