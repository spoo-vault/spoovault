import { beforeEach, describe, expect, it } from "vitest";
import { clientKeyringService, KeyPairRecord, __keyringDevHooks } from "../services/clientKeyring.service";
import { secretsService } from "../services/secrets.service";
import { generateECIESKeyPairBase64 } from "../utils/crypto";
import { installOpaqueServerMock } from "./helpers/opaqueServerMock";
import {
  OpaqueTransport,
  OpaqueTransportError,
  __opaqueKeyringTestHooks,
} from "../services/opaqueKeyring.service";

const testAccount = "0x71C838936352937A71E976BBE84e941E79409932";
const pin = "correct-horse-battery";

describe("RFC 9807 OPAQUE keyring PIN verification", { timeout: 120_000 }, () => {
  beforeEach(async () => {
    await installOpaqueServerMock();
    clientKeyringService.clearSessionCache();
    await clientKeyringService.deleteKeyPair(testAccount);
  });

  it("enrolls and unlocks through a complete interactive OPAQUE exchange", async () => {
    await clientKeyringService.generateAndSaveKeyPair(testAccount, pin, {
      enablePasskey: false,
    });
    const enrolled = await clientKeyringService.getKeyPairRecord(testAccount);
    expect(enrolled?.opaque?.version).toBe("spoovault-opaque-rfc9807-v1");

    clientKeyringService.clearSessionCache();
    const privateKey = await clientKeyringService.getDecryptedPrivateKey(testAccount, pin);
    expect(privateKey.length).toBeGreaterThan(0);
    expect(clientKeyringService.isUnlocked(testAccount)).toBe(true);
  });

  it("stores no PIN hash, salt, KDF parameters, OPRF key, export key, or registration record", async () => {
    await clientKeyringService.generateAndSaveKeyPair(testAccount, pin, {
      enablePasskey: false,
    });
    const record = (await clientKeyringService.getKeyPairRecord(testAccount))!;
    const serialized = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;

    expect(Object.keys(serialized).sort()).toEqual([
      "account",
      "createdAt",
      "encryptedPrivateKey",
      "hasPin",
      "opaque",
      "publicKey",
      "updatedAt",
    ]);
    expect(Object.keys(serialized.opaque as object).sort()).toEqual([
      "ciphertext",
      "iv",
      "version",
    ]);
    expect(record.encryptedPrivateKey).toBe("");
    expect(record.zkpp).toBeUndefined();
    expect(record.oprfKey).toBeUndefined();
  });

  it("rejects an incorrect PIN before exposing or caching private-key material", async () => {
    await clientKeyringService.generateAndSaveKeyPair(testAccount, pin, {
      enablePasskey: false,
    });
    clientKeyringService.clearSessionCache();

    await expect(
      clientKeyringService.getDecryptedPrivateKey(testAccount, "wrong-pin")
    ).rejects.toThrow("Incorrect PIN or passphrase");
    expect(clientKeyringService.isUnlocked(testAccount)).toBe(false);
  });

  it("does not unwrap when the server rejects the final client proof", async () => {
    const { transport, serverPublicKey } = await installOpaqueServerMock();
    await clientKeyringService.generateAndSaveKeyPair(testAccount, pin, {
      enablePasskey: false,
    });
    clientKeyringService.clearSessionCache();
    __opaqueKeyringTestHooks.configure(
      {
        ...transport,
        async finishLogin() {
          throw new OpaqueTransportError(
            "OPAQUE proof verification failed",
            "OPAQUE_VERIFICATION_FAILED",
            401
          );
        },
      },
      serverPublicKey
    );

    await expect(
      clientKeyringService.getDecryptedPrivateKey(testAccount, pin)
    ).rejects.toThrow("Incorrect PIN or passphrase");
    expect(clientKeyringService.isUnlocked(testAccount)).toBe(false);
  });

  it("rejects an unpinned OPAQUE server identity", async () => {
    const { transport } = await installOpaqueServerMock();
    __opaqueKeyringTestHooks.configure(transport, "attacker-controlled-server-key");

    await expect(
      clientKeyringService.generateAndSaveKeyPair(testAccount, pin, {
        enablePasskey: false,
      })
    ).rejects.toThrow("OPAQUE server identity verification failed");
    expect(await clientKeyringService.hasKeyPair(testAccount)).toBe(false);
  });

  it("makes an IndexedDB-only dump insufficient to test PIN guesses", async () => {
    const { serverPublicKey } = await installOpaqueServerMock();
    await clientKeyringService.generateAndSaveKeyPair(testAccount, pin, {
      enablePasskey: false,
    });
    const dump = JSON.parse(
      JSON.stringify(await clientKeyringService.getKeyPairRecord(testAccount))
    ) as KeyPairRecord;

    // The dump has only an authenticated ciphertext. The OPAQUE registration
    // record and server OPRF setup are held by the independent server store.
    expect(dump.opaque).toBeDefined();
    expect(dump.oprfKey).toBeUndefined();
    expect((dump as unknown as Record<string, unknown>).registrationRecord).toBeUndefined();
    expect((dump as unknown as Record<string, unknown>).exportKey).toBeUndefined();

    const unavailable = async (): Promise<never> => {
      throw new OpaqueTransportError(
        "OPAQUE verification server is unavailable",
        "OPAQUE_SERVER_UNAVAILABLE",
        0
      );
    };
    const offlineTransport: OpaqueTransport = {
      startRegistration: unavailable,
      finishRegistration: unavailable,
      startLogin: unavailable,
      finishLogin: unavailable,
      deleteCredential: unavailable,
    };
    __opaqueKeyringTestHooks.configure(offlineTransport, serverPublicKey);
    clientKeyringService.clearSessionCache();
    await expect(__keyringDevHooks.unlockRecord(dump, pin)).rejects.toThrow(
      "OPAQUE verification server is unavailable"
    );
  });

  it("binds the ciphertext to both account and public key", async () => {
    await clientKeyringService.generateAndSaveKeyPair(testAccount, pin, {
      enablePasskey: false,
    });
    const record = (await clientKeyringService.getKeyPairRecord(testAccount))!;
    const tampered = { ...record, publicKey: `${record.publicKey}A` };

    await expect(__keyringDevHooks.unlockRecord(tampered, pin)).rejects.toThrow(
      "Incorrect PIN or passphrase"
    );
  });

  it("migrates a legacy PBKDF2 IndexedDB record immediately after successful verification", async () => {
    const keys = await generateECIESKeyPairBase64();
    const legacyEnvelope = await secretsService.encryptWithPassphrase(
      keys.privateKey,
      pin,
      600_000
    );
    await __keyringDevHooks.putRecord({
      account: testAccount,
      publicKey: keys.publicKey,
      encryptedPrivateKey: legacyEnvelope,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasPin: true,
    });

    const decrypted = await clientKeyringService.getDecryptedPrivateKey(testAccount, pin);
    expect(decrypted).toBe(keys.privateKey);
    const migrated = (await clientKeyringService.getKeyPairRecord(testAccount))!;
    expect(migrated.opaque).toBeDefined();
    expect(migrated.encryptedPrivateKey).toBe("");
    expect(migrated.zkpp).toBeUndefined();
    expect(migrated.oprfKey).toBeUndefined();
  });
});
