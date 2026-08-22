import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  __setOfflineDbFactoryForTests,
  countActionsByStatus,
  deleteActionsByStatus,
  getCachedDocuments,
  getCachedInvites,
  getCachedPublicKey,
  getCachedVaults,
  insertAction,
  listActionsByStatus,
  putDocuments,
  putInvites,
  putPublicKey,
  putVaults,
  updateAction,
} from "../services/offline/db";

const ACCOUNT = "0xabc0000000000000000000000000000000000001";
const OTHER = "0xdef0000000000000000000000000000000000002";

const vaultInput = (id: number) => ({
  id,
  creator: ACCOUNT,
  name: `Vault ${id}`,
  description: "desc",
  guardians: [OTHER],
  approvalThreshold: 2,
  isActive: true,
  createdAt: 1700000000 + id,
});

describe("offline db (Dexie/IndexedDB schema)", () => {
  beforeEach(() => {
    __setOfflineDbFactoryForTests(new IDBFactory(), IDBKeyRange);
  });

  afterEach(() => {
    __setOfflineDbFactoryForTests(null);
  });

  it("stores and retrieves vaults scoped by account and network", async () => {
    await putVaults(ACCOUNT, "avalanche", [vaultInput(1), vaultInput(2)]);
    await putVaults(ACCOUNT, "stellar", [vaultInput(3)]);
    await putVaults(OTHER, "avalanche", [vaultInput(4)]);

    const fuji = await getCachedVaults(ACCOUNT, "avalanche");
    expect(fuji.map((v) => v.id)).toEqual([1, 2]);
    expect(fuji[0].guardians).toEqual([OTHER]);
    expect(fuji[0].account).toBe(ACCOUNT.toLowerCase());

    const stellar = await getCachedVaults(ACCOUNT, "stellar");
    expect(stellar.map((v) => v.id)).toEqual([3]);

    const other = await getCachedVaults(OTHER, "avalanche");
    expect(other.map((v) => v.id)).toEqual([4]);
  });

  it("upserts vault rows on repeated writes", async () => {
    await putVaults(ACCOUNT, "avalanche", [vaultInput(1)]);
    await putVaults(ACCOUNT, "avalanche", [
      { ...vaultInput(1), name: "Renamed" },
      vaultInput(9),
    ]);

    const rows = await getCachedVaults(ACCOUNT, "avalanche");
    expect(rows).toHaveLength(2);
    expect(rows.find((v) => v.id === 1)?.name).toBe("Renamed");
  });

  it("stores and retrieves documents per account/network", async () => {
    await putDocuments(ACCOUNT, "avalanche", [
      {
        id: 11,
        vaultId: 1,
        encryptedMetadata: "{}",
        ipfsHash: "QmHash",
        uploadedBy: ACCOUNT,
        uploadedAt: 1700000100,
        requiredAccess: 1,
      },
    ]);
    await putDocuments(ACCOUNT, "stellar", [
      {
        id: 12,
        vaultId: 2,
        encryptedMetadata: "{}",
        ipfsHash: "QmOther",
        uploadedBy: ACCOUNT,
        uploadedAt: 1700000200,
        requiredAccess: 2,
      },
    ]);

    const fuji = await getCachedDocuments(ACCOUNT, "avalanche");
    expect(fuji).toHaveLength(1);
    expect(fuji[0].ipfsHash).toBe("QmHash");

    const stellar = await getCachedDocuments(ACCOUNT, "stellar");
    expect(stellar).toHaveLength(1);
    expect(stellar[0].id).toBe(12);
  });

  it("replaces the invite set for an account on each write", async () => {
    await putInvites(ACCOUNT, "avalanche", [
      { guardian: OTHER, vaultId: 1, accepted: false, expiresAt: 99 },
    ]);
    await putInvites(ACCOUNT, "avalanche", [
      { guardian: OTHER, vaultId: 2, accepted: false, expiresAt: 100 },
      { guardian: OTHER, vaultId: 3, accepted: true, expiresAt: 101 },
    ]);

    const invites = await getCachedInvites(ACCOUNT, "avalanche");
    expect(invites).toHaveLength(2);
    expect(invites.map((i) => i.vaultId).sort()).toEqual([2, 3]);
  });

  it("caches public keys per address and network", async () => {
    await putPublicKey(ACCOUNT, "pub-key-1", "avalanche");
    await putPublicKey(ACCOUNT, "pub-key-stellar", "stellar");

    expect(await getCachedPublicKey(ACCOUNT, "avalanche")).toBe("pub-key-1");
    expect(await getCachedPublicKey(ACCOUNT, "stellar")).toBe("pub-key-stellar");
    expect(await getCachedPublicKey(OTHER, "avalanche")).toBeNull();
  });

  it("queues actions with ordering, status transitions and counts", async () => {
    const first = await insertAction({
      kind: "register-public-key",
      label: "key",
      payload: { publicKey: "pk" },
      status: "pending",
      attempts: 0,
      createdAt: 100,
      updatedAt: 100,
      network: "avalanche",
    });
    const second = await insertAction({
      kind: "request-access",
      label: "access",
      payload: { documentId: 5 },
      status: "pending",
      attempts: 0,
      createdAt: 200,
      updatedAt: 200,
      network: "avalanche",
    });

    let pending = await listActionsByStatus(["pending"]);
    expect(pending.map((a) => a.id)).toEqual([first.id, second.id]);

    await updateAction(first.id!, { status: "synced" });
    pending = await listActionsByStatus(["pending"]);
    expect(pending.map((a) => a.id)).toEqual([second.id]);

    const counts = await countActionsByStatus();
    expect(counts.pending).toBe(1);
    expect(counts.synced).toBe(1);

    await updateAction(second.id!, { status: "failed", lastError: "boom" });
    const failed = await listActionsByStatus(["failed"]);
    expect(failed[0].lastError).toBe("boom");

    await deleteActionsByStatus(["failed"]);
    expect((await countActionsByStatus()).failed).toBe(0);
  });
});

describe("offline db in-memory fallback (no IndexedDB)", () => {
  beforeEach(() => {
    __setOfflineDbFactoryForTests(null);
  });

  afterEach(() => {
    __setOfflineDbFactoryForTests(null);
  });

  it("mirrors the same API without IndexedDB", async () => {
    await putVaults(ACCOUNT, "avalanche", [vaultInput(7)]);
    expect((await getCachedVaults(ACCOUNT, "avalanche"))[0].id).toBe(7);

    await putPublicKey(ACCOUNT, "mem-pk", "avalanche");
    expect(await getCachedPublicKey(ACCOUNT, "avalanche")).toBe("mem-pk");

    const action = await insertAction({
      kind: "create-vault",
      label: "vault",
      payload: {},
      status: "pending",
      attempts: 0,
      createdAt: 1,
      updatedAt: 1,
      network: "avalanche",
    });
    expect(action.id).toBeDefined();
    expect((await countActionsByStatus()).pending).toBe(1);
  });
});
