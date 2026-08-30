import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CrossChainRelayerService,
  CrossChainPayload,
  CrossChainRevocationPayload,
  DEFAULT_APPROVAL_MESSAGE_TTL_MS,
} from "../services/crossChainRelayer.service";

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
    expect(signedPayload.sourceChain).toBe("avalanche");
    expect(signedPayload.destinationChain).toBe("stellar");
    expect(signedPayload.expiresAt).toBe(mockPayload.timestamp + DEFAULT_APPROVAL_MESSAGE_TTL_MS);

    const result = relayer.processMessage(signedPayload, secretKey);
    expect(result.success).toBe(true);
    expect(result.messageHash).toBeDefined();
  });

  it("rejects expired cross-chain approval payloads", () => {
    const stalePayload = CrossChainRelayerService.signPayload(
      {
        ...basePayload(),
        timestamp: Date.now() - DEFAULT_APPROVAL_MESSAGE_TTL_MS - 5_000,
      },
      secretKey
    );

    expect(() => relayer.processMessage(stalePayload, secretKey)).toThrow(
      "Cross-chain approval message expired"
    );
  });

  it("prevents stale approval nonces across fresh signatures", () => {
    const first = CrossChainRelayerService.signPayload(
      { ...basePayload(), nonce: 9, timestamp: Date.now() + 1 },
      secretKey
    );
    const replayedNonce = CrossChainRelayerService.signPayload(
      { ...basePayload(), nonce: 9, timestamp: Date.now() + 2 },
      secretKey
    );

    relayer.processMessage(first, secretKey);

    expect(() => relayer.processMessage(replayedNonce, secretKey)).toThrow(
      "Replay attack detected: Stale or replayed approval nonce"
    );
  });

  it("relays a verified approval payload to Stellar Soroban", async () => {
    const signedPayload = CrossChainRelayerService.signPayload(
      { ...basePayload(), nonce: 22 },
      secretKey
    );
    relayer.processMessage(signedPayload, secretKey);

    const mockSorobanClient = {
      relayApprovalGrant: vi.fn().mockResolvedValue({ ledger: 10701, success: true }),
    };

    const result = await relayer.relayApprovalToSoroban(signedPayload, mockSorobanClient);

    expect(result).toEqual({ relayed: true, ledger: 10701 });
    expect(mockSorobanClient.relayApprovalGrant).toHaveBeenCalledWith({
      vaultGid: signedPayload.vaultGID,
      guardian: signedPayload.guardian,
      approvalType: signedPayload.approvalType,
      sourceChain: "avalanche",
      nonce: 22n,
      signature: signedPayload.signature,
    });
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
