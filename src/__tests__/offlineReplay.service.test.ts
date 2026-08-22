import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

vi.mock("../services/contract.service", () => ({
  contractService: {
    createVault: vi.fn().mockResolvedValue(0),
    addDocument: vi.fn().mockResolvedValue(0),
    requestAccess: vi.fn().mockResolvedValue(0),
    registerPublicKey: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../services/ipfs.service", () => ({
  ipfsService: {
    isConfigured: vi.fn(() => true),
    uploadFile: vi.fn(),
  },
}));

vi.mock("../services/keyStore.service", () => ({
  keyStoreService: {
    set: vi.fn(() => true),
  },
}));

vi.mock("../services/clientKeyring.service", () => ({
  clientKeyringService: {
    getDecryptedPrivateKey: vi.fn().mockResolvedValue("private-key-material"),
  },
}));

vi.mock("../utils/crypto", () => ({
  decryptWithPrivateKey: vi.fn().mockResolvedValue("doc-symmetric-key"),
}));

import { contractService } from "../services/contract.service";
import { ipfsService } from "../services/ipfs.service";
import { keyStoreService } from "../services/keyStore.service";
import { clientKeyringService } from "../services/clientKeyring.service";
import { decryptWithPrivateKey } from "../utils/crypto";
import { __setOfflineDbFactoryForTests, listActionsByStatus } from "../services/offline/db";
import { enqueueAction } from "../services/offline/offlineQueue.service";
import {
  onReplayEvent,
  replayPendingActions,
} from "../services/offline/replay.service";

const mockedAddDocument = vi.mocked(contractService.addDocument);
const mockedRegisterPublicKey = vi.mocked(contractService.registerPublicKey);
const mockedRequestAccess = vi.mocked(contractService.requestAccess);

describe("offline replay service", () => {
  beforeEach(() => {
    __setOfflineDbFactoryForTests(new IDBFactory(), IDBKeyRange);
    vi.stubGlobal("navigator", { onLine: true });
    vi.clearAllMocks();
    mockedAddDocument.mockResolvedValue(0);
    mockedRequestAccess.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __setOfflineDbFactoryForTests(null);
  });

  it("drains the queue in order and marks actions synced", async () => {
    await enqueueAction("register-public-key", { publicKey: "pk-1" }, { label: "key" });
    await enqueueAction("request-access", { documentId: 9 }, { label: "access" });

    mockedRequestAccess.mockResolvedValue(77);

    const events: string[] = [];
    onReplayEvent((event) => events.push(event.type));

    const summary = await replayPendingActions();

    expect(summary.attempted).toBe(2);
    expect(summary.synced).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.remaining).toBe(0);
    expect(events).toEqual(["replay-start", "action-synced", "action-synced", "replay-complete"]);

    expect(mockedRegisterPublicKey).toHaveBeenCalledWith("pk-1");
    expect(mockedRequestAccess).toHaveBeenCalledWith(9);

    const remaining = await listActionsByStatus(["pending", "processing"]);
    expect(remaining).toHaveLength(0);
    const synced = await listActionsByStatus(["synced"]);
    expect(synced).toHaveLength(2);
  });

  it("reconciles a full offline document draft end-to-end", async () => {
    vi.mocked(ipfsService.uploadFile).mockResolvedValue({ hash: "QmDraftHash", size: 128 });
    mockedAddDocument.mockResolvedValue(42);

    await enqueueAction(
      "create-document-draft",
      {
        account: "0xabc0000000000000000000000000000000000001",
        vaultId: 3,
        fileName: "will.pdf.enc",
        fileSize: 128,
        fileType: "text/plain",
        encryptedMetadata: '{"ciphertext":"x"}',
        encryptedFileBase64: btoa("encrypted-bytes"),
        encryptedDocKey: '{"version":"ecies-p256-aes256gcm-v1"}',
        requiredAccess: 2,
        releaseCondition: 0,
        guardiansList: ["0xg1"],
        shares: ["share-1"],
      },
      { label: "draft will.pdf" }
    );

    const summary = await replayPendingActions();

    expect(summary.synced).toBe(1);
    expect(clientKeyringService.getDecryptedPrivateKey).toHaveBeenCalledWith(
      "0xabc0000000000000000000000000000000000001"
    );
    expect(decryptWithPrivateKey).toHaveBeenCalled();
    expect(ipfsService.uploadFile).toHaveBeenCalledTimes(1);

    const uploadedFile = vi.mocked(ipfsService.uploadFile).mock.calls[0][0] as File;
    expect(uploadedFile.name).toBe("will.pdf.enc");

    expect(mockedAddDocument).toHaveBeenCalledWith(
      3,
      '{"ciphertext":"x"}',
      "QmDraftHash",
      2,
      0,
      ["0xg1"],
      ["share-1"]
    );
    expect(keyStoreService.set).toHaveBeenCalledWith(42, "doc-symmetric-key");
  });

  it("requeues everything and stops when connectivity drops mid-replay", async () => {
    await enqueueAction("register-public-key", { publicKey: "pk-first" }, { label: "first" });
    await enqueueAction("request-access", { documentId: 10 }, { label: "second" });

    mockedRegisterPublicKey.mockRejectedValue(new Error("Failed to fetch"));

    const summary = await replayPendingActions();

    expect(summary.stoppedForOffline).toBe(true);
    expect(summary.synced).toBe(0);
    expect(summary.failed).toBe(0);

    // Both actions remain queued for the next reconnect.
    const pending = await listActionsByStatus(["pending"]);
    expect(pending.map((a) => a.label)).toEqual(["first", "second"]);

    // The second executor was never attempted.
    expect(mockedRequestAccess).not.toHaveBeenCalled();
  });

  it("marks permanent failures as failed but keeps draining", async () => {
    await enqueueAction("register-public-key", { publicKey: "pk-bad" }, { label: "bad" });
    await enqueueAction("request-access", { documentId: 11 }, { label: "good" });

    mockedRegisterPublicKey.mockRejectedValue(new Error("execution reverted: already registered"));
    mockedRequestAccess.mockResolvedValue(88);

    const summary = await replayPendingActions();

    expect(summary.failed).toBe(1);
    expect(summary.synced).toBe(1);
    expect(summary.stoppedForOffline).toBe(false);

    const failed = await listActionsByStatus(["failed"]);
    expect(failed[0].lastError).toContain("already registered");
  });

  it("coalesces concurrent replay requests into one drain", async () => {
    let resolveFirst!: (value: void) => void;
    mockedRegisterPublicKey.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        })
    );

    await enqueueAction("register-public-key", { publicKey: "pk" }, { label: "key" });

    const first = replayPendingActions();
    const second = replayPendingActions();
    expect(second).toBe(first);

    await vi.waitFor(() => expect(mockedRegisterPublicKey).toHaveBeenCalledTimes(1));
    resolveFirst!();
    const summary = await first;
    expect(summary.synced).toBe(1);
  });

  it("skips draining entirely while offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await enqueueAction("register-public-key", { publicKey: "pk" }, { label: "key" });

    const summary = await replayPendingActions();

    expect(summary.stoppedForOffline).toBe(true);
    expect(summary.attempted).toBe(0);
    expect(mockedRegisterPublicKey).not.toHaveBeenCalled();
  });
});
