import CryptoJS from "crypto-js";

export interface CryptoWorkerRequest {
  id: string;
  type: "ENCRYPT" | "DECRYPT";
  payload: {
    data: string;
    key: string;
  };
}

export interface CryptoWorkerResponse {
  id: string;
  type: "ENCRYPT_SUCCESS" | "DECRYPT_SUCCESS" | "ERROR";
  result?: string;
  error?: string;
}

self.onmessage = (event: MessageEvent<CryptoWorkerRequest>) => {
  const { id, type, payload } = event.data;

  try {
    if (type === "ENCRYPT") {
      const encrypted = CryptoJS.AES.encrypt(
        payload.data,
        payload.key
      ).toString();
      const response: CryptoWorkerResponse = {
        id,
        type: "ENCRYPT_SUCCESS",
        result: encrypted,
      };
      self.postMessage(response);
    } else if (type === "DECRYPT") {
      let decrypted = "";
      try {
        const bytes = CryptoJS.AES.decrypt(payload.data, payload.key);
        decrypted = bytes.toString(CryptoJS.enc.Utf8);
      } catch {
        decrypted = "";
      }
      const response: CryptoWorkerResponse = {
        id,
        type: "DECRYPT_SUCCESS",
        result: decrypted,
      };
      self.postMessage(response);
    } else {
      throw new Error(`Unsupported worker operation type: ${type}`);
    }
  } catch (err: any) {
    const errorResponse: CryptoWorkerResponse = {
      id,
      type: "ERROR",
      error: err?.message || "Crypto worker execution error",
    };
    self.postMessage(errorResponse);
  }
};
