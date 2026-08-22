import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clientKeyringService } from "../services/clientKeyring.service";
import { importECIESPrivateKey } from "../utils/crypto";
import { installWebAuthnMock, uninstallWebAuthnMock, InstalledWebAuthnMock } from "./helpers/webauthnMock";

describe("ClientKeyringService WebAuthn Passkey Integration", { timeout: 30000 }, () => {
  const testAccount = "0x71C838936352937A71E976BBE84e941E79409932";
  const testAccount2 = "0x2546BcD3c84621e976D8185a91A922aE77ECEc30";

  beforeEach(async () => {
    uninstallWebAuthnMock();
    clientKeyringService.clearSessionCache();
    await clientKeyringService.deleteKeyPair(testAccount);
    await clientKeyringService.deleteKeyPair(testAccount2);
  });

  afterEach(() => {
    uninstallWebAuthnMock();
  });

  const expectValidPrivateKey = async (privateKey: string): Promise<void> => {
    expect(privateKey.length).toBeGreaterThan(0);
    await expect(importECIESPrivateKey(privateKey)).resolves.toBeDefined();
  };

  describe("Passkey registration during keyring creation", () => {
    it("should register a passkey and store hardware-encrypted material without a PIN fallback blob", async () => {
      installWebAuthnMock({ returnPrfAtRegistration: true });
      const { publicKey } = await clientKeyringService.generateAndSaveKeyPair(testAccount);

      expect(publicKey).toBeDefined();
      const record = await clientKeyringService.getKeyPairRecord(testAccount);
      expect(record?.hasPasskey).toBe(true);
      expect(record?.passkeyCredentialId).toBeDefined();
      expect(record?.passkeyPrfSalt).toBeDefined();
      expect(record?.passkeyEncryptedPrivateKey).toBeDefined();
      // No custom PIN and a passkey was registered → the deterministic fallback blob
      // must NOT be persisted, otherwise the hardware key would be the only gate.
      expect(record?.encryptedPrivateKey).toBe("");
      expect(record?.hasPin).toBe(false);
      expect(await clientKeyringService.hasKeyPair(testAccount)).toBe(true);
    });

    it("should register a passkey and keep the PIN-encrypted blob when a custom PIN is set", async () => {
      installWebAuthnMock({ returnPrfAtRegistration: true });
      await clientKeyringService.generateAndSaveKeyPair(testAccount, "custom-pin-000");

      const record = await clientKeyringService.getKeyPairRecord(testAccount);
      expect(record?.hasPasskey).toBe(true);
      expect(record?.passkeyEncryptedPrivateKey).toBeDefined();
      expect(record?.hasPin).toBe(true);
      expect((record?.zkpp?.ciphertext || record?.encryptedPrivateKey || "").length).toBeGreaterThan(0);
    });

    it("should fall back to PIN/passphrase-only when the user cancels passkey registration", async () => {
      installWebAuthnMock({ registrationThrows: true, registrationErrorName: "NotAllowedError" });
      await clientKeyringService.generateAndSaveKeyPair(testAccount, "pin-123");

      const record = await clientKeyringService.getKeyPairRecord(testAccount);
      expect(record?.hasPasskey).toBeFalsy();
      expect(record?.hasPin).toBe(true);
      expect((record?.zkpp?.ciphertext || record?.encryptedPrivateKey || "").length).toBeGreaterThan(0);

      clientKeyringService.clearSessionCache();
      const privateKey = await clientKeyringService.getDecryptedPrivateKey(testAccount, "pin-123");
      await expectValidPrivateKey(privateKey);
    });

    it("should fall back to PIN/passphrase-only when the authenticator does not support PRF", async () => {
      installWebAuthnMock({ prfEnabledAtRegistration: false });
      await clientKeyringService.generateAndSaveKeyPair(testAccount, "pin-456");

      const record = await clientKeyringService.getKeyPairRecord(testAccount);
      expect(record?.hasPasskey).toBeFalsy();
      expect(record?.hasPin).toBe(true);
    });

    it("should not attempt passkey registration when enablePasskey is false", async () => {
      const mock = installWebAuthnMock({ returnPrfAtRegistration: true });
      await clientKeyringService.generateAndSaveKeyPair(testAccount, undefined, {
        enablePasskey: false,
      });

      expect(mock.create).not.toHaveBeenCalled();
      const record = await clientKeyringService.getKeyPairRecord(testAccount);
      expect(record?.hasPasskey).toBeFalsy();
      expect((record?.zkpp?.ciphertext || record?.encryptedPrivateKey || "").length).toBeGreaterThan(0);
    });

    it("should not register a passkey when WebAuthn is unavailable (smooth fallback)", async () => {
      // No mock installed → WebAuthn API absent, like a non-supporting browser.
      await clientKeyringService.generateAndSaveKeyPair(testAccount);

      const record = await clientKeyringService.getKeyPairRecord(testAccount);
      expect(record?.hasPasskey).toBeFalsy();
      expect((record?.zkpp?.ciphertext || record?.encryptedPrivateKey || "").length).toBeGreaterThan(0);
    });
  });

  describe("Passkey authentication & unlock", () => {
    it("should unlock a passkey-only keyring through the hardware authenticator", async () => {
      const mock = installWebAuthnMock({ returnPrfAtRegistration: true });
      await clientKeyringService.generateAndSaveKeyPair(testAccount);
      expect(clientKeyringService.isUnlocked(testAccount)).toBe(true);

      // Force a fresh unlock from storage.
      clientKeyringService.clearSessionCache();
      expect(clientKeyringService.isUnlocked(testAccount)).toBe(false);

      const privateKey = await clientKeyringService.getDecryptedPrivateKey(testAccount);
      await expectValidPrivateKey(privateKey);
      expect(clientKeyringService.isUnlocked(testAccount)).toBe(true);

      // The stored credential id must be passed to the authenticator on unlock.
      const record = await clientKeyringService.getKeyPairRecord(testAccount);
      const getArgs = mock.get.mock.calls[0][0] as CredentialRequestOptions;
      const allow = (getArgs.publicKey as PublicKeyCredentialRequestOptions).allowCredentials?.[0];
      expect(allow?.id).toBeDefined();
      const allowBytes = new Uint8Array(allow!.id as ArrayBuffer);
      let binary = "";
      for (const b of allowBytes) binary += String.fromCharCode(b);
      const allowBase64Url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(allowBase64Url).toBe(record?.passkeyCredentialId);
    });

    it("should support authenticators that only return PRF output on authentication (two-step flow)", async () => {
      const mock = installWebAuthnMock({ returnPrfAtRegistration: false });
      await clientKeyringService.generateAndSaveKeyPair(testAccount);

      const record = await clientKeyringService.getKeyPairRecord(testAccount);
      expect(record?.hasPasskey).toBe(true);
      // Registration produced no output → a follow-up assertion must have been issued.
      expect(mock.get).toHaveBeenCalledTimes(1);

      clientKeyringService.clearSessionCache();
      const privateKey = await clientKeyringService.getDecryptedPrivateKey(testAccount);
      await expectValidPrivateKey(privateKey);
    });

    it("should unlock a passkey+PIN keyring with either the authenticator or the PIN", async () => {
      installWebAuthnMock({ returnPrfAtRegistration: true });
      await clientKeyringService.generateAndSaveKeyPair(testAccount, "my-pin-999");

      clientKeyringService.clearSessionCache();
      const viaPasskey = await clientKeyringService.getDecryptedPrivateKey(testAccount);
      await expectValidPrivateKey(viaPasskey);

      clientKeyringService.clearSessionCache();
      const viaPin = await clientKeyringService.getDecryptedPrivateKey(testAccount, "my-pin-999");
      await expectValidPrivateKey(viaPin);
      expect(viaPin).toBe(viaPasskey);
    });

    it("should surface a helpful PIN fallback message when passkey auth is cancelled", async () => {
      const mock: InstalledWebAuthnMock = installWebAuthnMock({ returnPrfAtRegistration: true });
      await clientKeyringService.generateAndSaveKeyPair(testAccount, "pin-777");

      clientKeyringService.clearSessionCache();
      mock.get.mockImplementationOnce(async () => {
        throw new DOMException("NotAllowedError", "NotAllowedError");
      });

      await expect(clientKeyringService.getDecryptedPrivateKey(testAccount)).rejects.toThrow(
        "Passkey authentication cancelled. Unlock with your PIN/passphrase instead."
      );

      // Explicit PIN still decrypts the fallback blob.
      const privateKey = await clientKeyringService.getDecryptedPrivateKey(testAccount, "pin-777");
      await expectValidPrivateKey(privateKey);
    });

    it("should fail closed when passkey auth fails on a passkey-only keyring", async () => {
      const mock: InstalledWebAuthnMock = installWebAuthnMock({ returnPrfAtRegistration: true });
      await clientKeyringService.generateAndSaveKeyPair(testAccount);

      clientKeyringService.clearSessionCache();
      mock.get.mockImplementationOnce(async () => {
        throw new DOMException("NotAllowedError", "NotAllowedError");
      });

      await expect(clientKeyringService.getDecryptedPrivateKey(testAccount)).rejects.toThrow(
        "Passkey authentication cancelled. Please try again when you are ready to unlock."
      );
    });

    it("should not attempt WebAuthn when the authenticator is unavailable on unlock", async () => {
      installWebAuthnMock({ returnPrfAtRegistration: true });
      await clientKeyringService.generateAndSaveKeyPair(testAccount);

      // Simulate unlocking on a device without WebAuthn support.
      uninstallWebAuthnMock();
      clientKeyringService.clearSessionCache();

      await expect(clientKeyringService.getDecryptedPrivateKey(testAccount)).rejects.toThrow(
        "Passkey authentication failed. Please verify your hardware authenticator."
      );
    });
  });

  describe("Backup & lifecycle with passkeys", () => {
    it("should export/import a backup of a passkey-protected keyring using the authenticator", async () => {
      installWebAuthnMock({ returnPrfAtRegistration: true });
      const { publicKey } = await clientKeyringService.generateAndSaveKeyPair(testAccount);

      clientKeyringService.clearSessionCache();
      const backupJson = await clientKeyringService.exportKeyBackup(testAccount, "backup-pass");

      const parsed = JSON.parse(backupJson);
      expect(parsed.publicKey).toBe(publicKey);

      await clientKeyringService.deleteKeyPair(testAccount);
      expect(await clientKeyringService.hasKeyPair(testAccount)).toBe(false);

      const restored = await clientKeyringService.importKeyBackup(
        testAccount,
        backupJson,
        "backup-pass"
      );
      expect(restored.publicKey).toBe(publicKey);
      expect(await clientKeyringService.hasKeyPair(testAccount)).toBe(true);
    }, 35000);

    it("should clean up passkey metadata on delete", async () => {
      installWebAuthnMock({ returnPrfAtRegistration: true });
      await clientKeyringService.generateAndSaveKeyPair(testAccount);
      await clientKeyringService.deleteKeyPair(testAccount);

      expect(await clientKeyringService.hasKeyPair(testAccount)).toBe(false);
      expect(await clientKeyringService.getKeyPairRecord(testAccount)).toBeNull();
      expect(clientKeyringService.isUnlocked(testAccount)).toBe(false);
    });
  });
});
