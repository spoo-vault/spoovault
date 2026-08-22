import { describe, it, expect } from "vitest";
import {
  SIGNATURE_HEADER,
  UNSIGNED_PAYLOAD,
  signProxyRequest,
} from "../utils/ipfsProxySignature";

describe("ipfsProxySignature utility re-exports", () => {
  it("exports expected constants and functions", () => {
    expect(SIGNATURE_HEADER).toBe("X-SpooVault-Signature");
    expect(UNSIGNED_PAYLOAD).toBe("UNSIGNED-PAYLOAD");
    expect(typeof signProxyRequest).toBe("function");
  });

  it("signs proxy requests using the re-exported helper", async () => {
    const signed = await signProxyRequest({
      secret: "proxy-secret",
      method: "DELETE",
      path: "/api/ipfs/unpin/QmHash",
      timestamp: 1700000000,
    });
    expect(signed.headers[SIGNATURE_HEADER]).toMatch(
      /^t=1700000000,v1=[0-9a-f]+$/
    );
  });
});
