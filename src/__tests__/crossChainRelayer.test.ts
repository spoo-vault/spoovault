import { describe, it, expect, beforeEach, vi } from "vitest";
import { CrossChainRelayerService, CrossChainPayload, CrossChainRevocationPayload } from "../services/crossChainRelayer.service";

describe("Axelar Cross-Chain Message Relayer", () => {
  const secretKey = "relayer-secret-key-12345";
  let relayer: CrossChainRelayerService;

  beforeEach(() => {
    relayer = new CrossChainRelayerService();
  });

  const basePayload = (): CrossChainPayload => ({
    vaultGID: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    guardian: "0x1111111111111111111111111111111111111111",
    approvalType: 1,
    timestamp: Date.now(),
  });

  const baseRevocationPayload = (): CrossChainRevocationPayload => ({
    vaultGID: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    documentId: 42,
    targetUser: "0x2222222222222222222222222222222222222222",
    targetStellarUser: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    nonce: 1,
  });

  it("signs and verifies cross-chain approval payload", () => {
    const mockPayload = basePayload();
    const signedPayload = CrossChainRelayerService.signPayload(mockPayload, secretKey);
    expect(signedPayload.signature).toBeDefined();

    const result = relayer.processMessage(signedPayload, secretKey);
    expect(result.success).toBe(true);
    expect(result.messageHash).toBeDefined();
  });

  it("prevents replay attacks on duplicate execution", () => {
    const mockPayload = { ...basePayload(), timestamp: Date.now() + 1 };
    const signedPayload = CrossChainRelayerService.signPayload(mockPayload, secretKey);

    relayer.processMessage(signedPayload, secretKey);

    expect(() => relayer.processMessage(signedPayload, secretKey)).toThrow(
      "Replay attack detected: Message already processed"
    );
  });

  describe("Instant Cross-Chain Access Revocation Engine", () => {
    it("signs and processes cross-chain revocation payload RevokeAccess(vaultGID, documentId, targetUser, nonce)", () => {
      const revPayload = baseRevocationPayload();
      const signedRev = CrossChainRelayerService.signRevocationPayload(revPayload, secretKey);

      expect(signedRev.signature).toBeDefined();
      expect(signedRev.recoveryId).toBe(0);

      const result = relayer.processRevocationBroadcast(signedRev, secretKey);
      expect(result.success).toBe(true);
      expect(result.messageHash).toBeDefined();
      expect(result.broadcastRevocation.documentId).toBe(42);
    });

    it("rejects invalid signature on revocation broadcast payload", () => {
      const revPayload = baseRevocationPayload();
      const signedRev = CrossChainRelayerService.signRevocationPayload(revPayload, secretKey);
      signedRev.signature = "invalid-signature";

      expect(() => relayer.processRevocationBroadcast(signedRev, secretKey)).toThrow(
        "Invalid revocation payload signature"
      );
    });

    it("prevents replay attacks on revocation broadcasts with stale nonces", () => {
      const revPayload = baseRevocationPayload();
      const signedRev = CrossChainRelayerService.signRevocationPayload(revPayload, secretKey);

      relayer.processRevocationBroadcast(signedRev, secretKey);

      // Replaying the exact same nonce must fail
      expect(() => relayer.processRevocationBroadcast(signedRev, secretKey)).toThrow(
        "Replay attack detected: Stale or replayed revocation nonce"
      );
    });

    it("relays revocation payload to Stellar Soroban contract within 1 block", async () => {
      const revPayload = baseRevocationPayload();
      const signedRev = CrossChainRelayerService.signRevocationPayload(revPayload, secretKey);

      const mockSorobanClient = {
        relayRevokeAccess: vi.fn().mockResolvedValue({ ledger: 10452, success: true }),
      };

      const result = await relayer.relayRevocationToSoroban(signedRev, mockSorobanClient);

      expect(result.relayed).toBe(true);
      expect(result.ledger).toBe(10452);
      expect(mockSorobanClient.relayRevokeAccess).toHaveBeenCalledWith({
        vaultGid: signedRev.vaultGID,
        documentId: BigInt(signedRev.documentId),
        targetEvmUser: signedRev.targetUser,
        targetStellarUser: signedRev.targetStellarUser,
        nonce: BigInt(signedRev.nonce),
        signature: signedRev.signature,
        recoveryId: 0,
      });
    });
  });
});
