import { describe, it, expect, beforeEach } from "vitest";
import { CrossChainRelayerService, CrossChainRevocationPayload } from "../services/crossChainRelayer.service";

describe("Instant Cross-Chain Access Revocation Engine Integration", () => {
  let relayerService: CrossChainRelayerService;
  const relayerSecretKey = "secret-relayer-key-999";

  beforeEach(() => {
    relayerService = new CrossChainRelayerService();
  });

  interface MockEvmVault {
    vaultGID: string;
    crossChainRevocationEnabled: boolean;
    userAccessVersion: Map<string, number>;
    nonces: Map<string, number>;
    revokeAccess: (documentId: number, targetUser: string) => {
      event: "RevokeAccess" | "CrossChainRevocationBroadcast";
      vaultGID: string;
      documentId: number;
      targetUser: string;
      nonce: number;
    };
  }

  interface MockSorobanVault {
    accessGrants: Map<string, boolean>;
    accessVersion: Map<string, number>;
    relayedNonces: Map<string, number>;
    relayRevokeAccess: (params: {
      vaultGid: string;
      documentId: bigint;
      targetEvmUser: string;
      targetStellarUser: string;
      nonce: bigint;
      signature: string;
      recoveryId: number;
    }) => Promise<{ ledger: number; success: boolean }>;
  }

  const createMockEvmVault = (): MockEvmVault => {
    const vaultGID = "0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba";
    const userAccessVersion = new Map<string, number>();
    const nonces = new Map<string, number>();

    return {
      vaultGID,
      crossChainRevocationEnabled: true,
      userAccessVersion,
      nonces,
      revokeAccess: (documentId: number, targetUser: string) => {
        const key = `${documentId}:${targetUser}`;
        const currentVer = userAccessVersion.get(targetUser) ?? 1;
        userAccessVersion.set(targetUser, currentVer + 1);

        const currentNonce = (nonces.get(key) ?? 0) + 1;
        nonces.set(key, currentNonce);

        return {
          event: "RevokeAccess",
          vaultGID,
          documentId,
          targetUser,
          nonce: currentNonce,
        };
      },
    };
  };

  const createMockSorobanVault = (): MockSorobanVault => {
    const accessGrants = new Map<string, boolean>();
    const accessVersion = new Map<string, number>();
    const relayedNonces = new Map<string, number>();

    return {
      accessGrants,
      accessVersion,
      relayedNonces,
      relayRevokeAccess: async (params) => {
        const trackingKey = `${params.vaultGid}:${params.documentId}:${params.targetStellarUser}`;
        const lastNonce = relayedNonces.get(trackingKey) ?? 0;

        if (Number(params.nonce) <= lastNonce) {
          throw new Error("Stale or replayed revocation nonce");
        }

        // Invalidate access grant and bump accessVersion within 1 block
        accessGrants.set(trackingKey, false);
        const curVer = accessVersion.get(params.targetStellarUser) ?? 1;
        accessVersion.set(params.targetStellarUser, curVer + 1);
        relayedNonces.set(trackingKey, Number(params.nonce));

        return {
          ledger: 10842,
          success: true,
        };
      },
    };
  };

  it("synchronizes EVM document access revocation with Stellar Soroban in real time (within 1 block)", async () => {
    const evmVault = createMockEvmVault();
    const sorobanVault = createMockSorobanVault();

    const targetEvmUser = "0x1111222233334444555566667777888899990000";
    const targetStellarUser = "GBCK7V43T2ZLN4Q7YTX5UOPW4ZJ6B7V2WLRQ8K9M3X4P2N1L5K6J7H8G";
    const docId = 101;

    // Initial state: User has active access grant on Stellar
    const trackingKey = `${evmVault.vaultGID}:${docId}:${targetStellarUser}`;
    sorobanVault.accessGrants.set(trackingKey, true);
    sorobanVault.accessVersion.set(targetStellarUser, 1);

    expect(sorobanVault.accessGrants.get(trackingKey)).toBe(true);
    expect(sorobanVault.accessVersion.get(targetStellarUser)).toBe(1);

    // Step 1: EVM contract triggers revokeAccess
    const evmBroadcast = evmVault.revokeAccess(docId, targetEvmUser);
    expect(evmBroadcast.event).toBe("RevokeAccess");
    expect(evmBroadcast.nonce).toBe(1);

    // Immediate EVM state invalidation: accessVersion bumped
    expect(evmVault.userAccessVersion.get(targetEvmUser)).toBe(2);

    // Step 2: Relayer captures EVM broadcast event, signs revocation payload
    const unsignedPayload: CrossChainRevocationPayload = {
      vaultGID: evmBroadcast.vaultGID,
      documentId: evmBroadcast.documentId,
      targetUser: evmBroadcast.targetUser,
      targetStellarUser,
      nonce: evmBroadcast.nonce,
    };
    const signedPayload = CrossChainRelayerService.signRevocationPayload(unsignedPayload, relayerSecretKey);

    // Step 3: Relayer processes payload and enforces replay checks
    const processResult = relayerService.processRevocationBroadcast(signedPayload, relayerSecretKey);
    expect(processResult.success).toBe(true);

    // Step 4: Relayer dispatches to Soroban relay_revoke_access
    const relayResult = await relayerService.relayRevocationToSoroban(signedPayload, sorobanVault);
    expect(relayResult.relayed).toBe(true);
    expect(relayResult.ledger).toBeGreaterThan(0);

    // Step 5: Verify immediate state invalidation on Stellar Soroban side
    expect(sorobanVault.accessGrants.get(trackingKey)).toBe(false);
    expect(sorobanVault.accessVersion.get(targetStellarUser)).toBe(2);
  });

  it("prevents window-of-exposure vulnerabilities by rejecting replayed or out-of-order revocation messages", async () => {
    const evmVault = createMockEvmVault();
    const sorobanVault = createMockSorobanVault();

    const targetEvmUser = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const targetStellarUser = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const docId = 202;

    const evmBroadcast = evmVault.revokeAccess(docId, targetEvmUser);
    const signedPayload = CrossChainRelayerService.signRevocationPayload(
      {
        vaultGID: evmBroadcast.vaultGID,
        documentId: evmBroadcast.documentId,
        targetUser: evmBroadcast.targetUser,
        targetStellarUser,
        nonce: evmBroadcast.nonce,
      },
      relayerSecretKey
    );

    // First relay execution succeeds
    await relayerService.relayRevocationToSoroban(signedPayload, sorobanVault);

    // Replay attempt on Soroban contract MUST fail immediately
    await expect(
      relayerService.relayRevocationToSoroban(signedPayload, sorobanVault)
    ).rejects.toThrow("Stale or replayed revocation nonce");
  });
});
