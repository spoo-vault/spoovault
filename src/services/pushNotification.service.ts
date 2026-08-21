import { signProxyRequest } from "../utils/ipfsProxySignature";
import { ethers } from "ethers";

const PUSH_PROXY_URL =
  (import.meta.env.VITE_PUSH_NOTIFICATION_PROXY_URL as string | undefined)?.trim() || "";
const PROXY_SECRET =
  (import.meta.env.VITE_SPOOVUALT_PROXY_SECRET as string | undefined)?.trim() || "";

const EMERGENCY_MODE_PATH = "/api/notifications/emergency-mode";

const isConfigured = (): boolean => !!PUSH_PROXY_URL && !!PROXY_SECRET;

const notifyEmergencyModeChange = async (
  vaultId: number,
  beneficiary: string,
  enabled: boolean
): Promise<void> => {
  if (!isConfigured()) {
    return;
  }
  if (!beneficiary || beneficiary === ethers.ZeroAddress) {
    return;
  }

  const body = JSON.stringify({ vaultId, beneficiary, enabled });
  const auth = await signProxyRequest({
    secret: PROXY_SECRET,
    method: "POST",
    path: EMERGENCY_MODE_PATH,
    body,
  });

  const response = await fetch(`${PUSH_PROXY_URL}${EMERGENCY_MODE_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...auth.headers,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Push notification proxy responded with ${response.status}`);
  }
};

export const pushNotificationService = {
  isConfigured,
  notifyEmergencyModeChange,
};

export default pushNotificationService;
