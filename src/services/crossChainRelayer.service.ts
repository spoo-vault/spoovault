import crypto from "crypto";

export interface CrossChainPayload {
  vaultGID: string;
  guardian: string;
  approvalType: number;
  timestamp: number;
  signature?: string;
}

export interface CrossChainRevocationPayload {
  vaultGID: string;
  documentId: number | bigint;
  targetUser: string;
  targetStellarUser?: string;
  nonce: number | bigint;
  signature?: string;
  recoveryId?: number;
}

export class CrossChainRelayerService {
  private processedHashes: Set<string> = new Set();
  private lastRevocationNonces: Map<string, bigint> = new Map();

  static signPayload(payload: CrossChainPayload, secretKey: string): CrossChainPayload {
    const rawData = `${payload.vaultGID}:${payload.guardian}:${payload.approvalType}:${payload.timestamp}`;
    const signature = crypto.createHmac("sha256", secretKey).update(rawData).digest("hex");
    return { ...payload, signature };
  }

  static signRevocationPayload(
    payload: CrossChainRevocationPayload,
    secretKey: string
  ): CrossChainRevocationPayload {
    const rawData = `RevokeAccess:${payload.vaultGID}:${payload.documentId}:${payload.targetUser}:${payload.nonce}`;
    const signature = crypto.createHmac("sha256", secretKey).update(rawData).digest("hex");
    return { ...payload, signature, recoveryId: 0 };
  }

  processMessage(payload: CrossChainPayload, secretKey: string): { success: boolean; messageHash: string } {
    const rawData = `${payload.vaultGID}:${payload.guardian}:${payload.approvalType}:${payload.timestamp}`;
    const expectedSig = crypto.createHmac("sha256", secretKey).update(rawData).digest("hex");

    if (payload.signature !== expectedSig) {
      throw new Error("Invalid payload signature");
    }

    const messageHash = crypto.createHash("sha256").update(`${rawData}:${payload.signature}`).digest("hex");

    if (this.processedHashes.has(messageHash)) {
      throw new Error("Replay attack detected: Message already processed");
    }

    this.processedHashes.add(messageHash);
    return { success: true, messageHash };
  }

  /**
   * Processes and validates an instant EVM-to-Soroban cross-chain revocation broadcast payload.
   * Enforces strictly-increasing nonces per (vaultGID, documentId, targetUser) triple to prevent replay attacks.
   */
  processRevocationBroadcast(
    payload: CrossChainRevocationPayload,
    secretKey: string
  ): { success: boolean; messageHash: string; broadcastRevocation: CrossChainRevocationPayload } {
    const rawData = `RevokeAccess:${payload.vaultGID}:${payload.documentId}:${payload.targetUser}:${payload.nonce}`;
    const expectedSig = crypto.createHmac("sha256", secretKey).update(rawData).digest("hex");

    if (payload.signature !== expectedSig) {
      throw new Error("Invalid revocation payload signature");
    }

    const trackingKey = `${payload.vaultGID}:${payload.documentId}:${payload.targetUser}`;
    const currentNonce = BigInt(payload.nonce);
    const lastNonce = this.lastRevocationNonces.get(trackingKey) ?? 0n;

    if (currentNonce <= lastNonce) {
      throw new Error("Replay attack detected: Stale or replayed revocation nonce");
    }

    const messageHash = crypto.createHash("sha256").update(`${rawData}:${payload.signature}`).digest("hex");
    this.processedHashes.add(messageHash);
    this.lastRevocationNonces.set(trackingKey, currentNonce);

    return {
      success: true,
      messageHash,
      broadcastRevocation: payload,
    };
  }

  /**
   * Relays a verified revocation payload to Stellar Soroban contract.
   * Immediately invalidates beneficiary access grants on Stellar within 1 block.
   */
  async relayRevocationToSoroban(
    payload: CrossChainRevocationPayload,
    sorobanClient: {
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
  ): Promise<{ relayed: boolean; ledger: number }> {
    const result = await sorobanClient.relayRevokeAccess({
      vaultGid: payload.vaultGID,
      documentId: BigInt(payload.documentId),
      targetEvmUser: payload.targetUser,
      targetStellarUser: payload.targetStellarUser ?? payload.targetUser,
      nonce: BigInt(payload.nonce),
      signature: payload.signature ?? "0x00",
      recoveryId: payload.recoveryId ?? 0,
    });

    return {
      relayed: result.success,
      ledger: result.ledger,
    };
  }
}
