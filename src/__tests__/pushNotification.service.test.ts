/**
 * Unit tests for pushNotification.service.ts
 *
 * Covers:
 *  - No-op behavior when the proxy is not configured or the beneficiary is unset
 *  - Signed POST to the proxy when configured
 *  - Error propagation on a non-ok proxy response
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";

const BENEFICIARY = "0x71C838936352937A71E976BBE84e941E79409932";

type PushNotificationModule = typeof import("../services/pushNotification.service");

const testEnv = (): Record<string, string | undefined> =>
  import.meta.env as unknown as Record<string, string | undefined>;

const resetEnv = (): void => {
  delete testEnv().VITE_PUSH_NOTIFICATION_PROXY_URL;
  delete testEnv().VITE_SPOOVUALT_PROXY_SECRET;
};

const configureEnv = (): void => {
  testEnv().VITE_PUSH_NOTIFICATION_PROXY_URL = "https://proxy.example.com";
  testEnv().VITE_SPOOVUALT_PROXY_SECRET = "test-secret";
};

const loadService = async (): Promise<PushNotificationModule> => {
  vi.resetModules();
  return import("../services/pushNotification.service");
};

describe("pushNotificationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    resetEnv();
  });

  describe("isConfigured", () => {
    it("is false when the proxy URL and secret are unset", async () => {
      const { pushNotificationService } = await loadService();
      expect(pushNotificationService.isConfigured()).toBe(false);
    });

    it("is true when both the proxy URL and secret are set", async () => {
      configureEnv();
      const { pushNotificationService } = await loadService();
      expect(pushNotificationService.isConfigured()).toBe(true);
    });
  });

  describe("notifyEmergencyModeChange", () => {
    it("does not call fetch when the proxy is not configured", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const { pushNotificationService } = await loadService();
      await pushNotificationService.notifyEmergencyModeChange(1, BENEFICIARY, true);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not call fetch when the beneficiary is the zero address", async () => {
      configureEnv();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const { pushNotificationService } = await loadService();
      await pushNotificationService.notifyEmergencyModeChange(1, ethers.ZeroAddress, true);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not call fetch when the beneficiary is empty", async () => {
      configureEnv();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const { pushNotificationService } = await loadService();
      await pushNotificationService.notifyEmergencyModeChange(1, "", true);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("POSTs a signed request to the configured proxy", async () => {
      configureEnv();
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const { pushNotificationService } = await loadService();
      await pushNotificationService.notifyEmergencyModeChange(1, BENEFICIARY, true);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://proxy.example.com/api/notifications/emergency-mode");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(init.headers["X-SpooVault-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      expect(JSON.parse(init.body)).toEqual({
        vaultId: 1,
        beneficiary: BENEFICIARY,
        enabled: true,
      });
    });

    it("throws when the proxy responds with a non-ok status", async () => {
      configureEnv();
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      vi.stubGlobal("fetch", fetchMock);

      const { pushNotificationService } = await loadService();
      await expect(
        pushNotificationService.notifyEmergencyModeChange(1, BENEFICIARY, false)
      ).rejects.toThrow("Push notification proxy responded with 500");
    });
  });
});
