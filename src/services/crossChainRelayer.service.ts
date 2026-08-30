import crypto from "crypto";

export const DEFAULT_APPROVAL_MESSAGE_TTL_MS = 5 * 60 * 1000;

export interface CrossChainPayload {
  vaultGID: string;
  guardian: string;
  approvalType: number;
  timestamp: number;
  sourceChain?: string;
  destinationChain?: string;
  nonce?: number | bigint;
  expiresAt?: number;
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
  private lastApprovalNonces: Map<string, bigint> = new Map();
  private lastRevocationNonces: Map<string, bigint> = new Map();

  private static normalizeApprovalPayload(
    payload: CrossChainPayload
  ): Record<string, string | number> {
    return {
      type: "SpooVaultCrossChainApproval",
      vaultGID: payload.vaultGID.toLowerCase(),
      guardian: payload.guardian.toLowerCase(),
      approvalType: payload.approvalType,
      sourceChain: payload.sourceChain ?? "avalanche",
      destinationChain: payload.destinationChain ?? "stellar",
      nonce: String(payload.nonce ?? 0),
      timestamp: payload.timestamp,
      expiresAt:
        payload.expiresAt ??
        payload.timestamp + DEFAULT_APPROVAL_MESSAGE_TTL_MS,
    };
  }

  private static approvalSigningData(payload: CrossChainPayload): string {
    return JSON.stringify(CrossChainRelayerService.normalizeApprovalPayload(payload));
  }

  private static signaturesMatch(actual: string | undefined, expected: string): boolean {
    if (!actual) {
      return false;
    }
    const actualBytes = Buffer.from(actual, "hex");
    const expectedBytes = Buffer.from(expected, "hex");
    return (
      actualBytes.length === expectedBytes.length &&
      crypto.timingSafeEqual(actualBytes, expectedBytes)
    );
  }

  static signPayload(payload: CrossChainPayload, secretKey: string): CrossChainPayload {
    const rawData = CrossChainRelayerService.approvalSigningData(payload);
    const signature = crypto.createHmac("sha256", secretKey).update(rawData).digest("hex");
    const normalized = CrossChainRelayerService.normalizeApprovalPayload(payload);
    return {
      ...payload,
      sourceChain: String(normalized.sourceChain),
      destinationChain: String(normalized.destinationChain),
      ...(payload.nonce !== undefined
        ? { nonce: BigInt(String(normalized.nonce)) }
        : {}),
      expiresAt: Number(normalized.expiresAt),
      signature,
    };
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
    const rawData = CrossChainRelayerService.approvalSigningData(payload);
    const expectedSig = crypto.createHmac("sha256", secretKey).update(rawData).digest("hex");

    if (!CrossChainRelayerService.signaturesMatch(payload.signature, expectedSig)) {
      throw new Error("Invalid payload signature");
    }

    const expiresAt =
      payload.expiresAt ?? payload.timestamp + DEFAULT_APPROVAL_MESSAGE_TTL_MS;
    if (Date.now() > expiresAt) {
      throw new Error("Cross-chain approval message expired");
    }

    const messageHash = crypto.createHash("sha256").update(`${rawData}:${payload.signature}`).digest("hex");

    if (this.processedHashes.has(messageHash)) {
      throw new Error("Replay attack detected: Message already processed");
    }

    if (payload.nonce !== undefined) {
      const trackingKey = [
        payload.vaultGID.toLowerCase(),
        payload.guardian.toLowerCase(),
        payload.approvalType,
        payload.sourceChain ?? "avalanche",
        payload.destinationChain ?? "stellar",
      ].join(":");
      const currentNonce = BigInt(payload.nonce);
      const lastNonce = this.lastApprovalNonces.get(trackingKey) ?? 0n;
      if (currentNonce <= lastNonce) {
        throw new Error("Replay attack detected: Stale or replayed approval nonce");
      }
      this.lastApprovalNonces.set(trackingKey, currentNonce);
    }

    this.processedHashes.add(messageHash);
    return { success: true, messageHash };
  }

  async relayApprovalToSoroban(
    payload: CrossChainPayload,
    sorobanClient: {
      relayApprovalGrant: (params: {
        vaultGid: string;
        guardian: string;
        approvalType: number;
        sourceChain: string;
        nonce: bigint;
        signature: string;
      }) => Promise<{ ledger: number; success: boolean }>;
    }
  ): Promise<{ relayed: boolean; ledger: number }> {
    const result = await sorobanClient.relayApprovalGrant({
      vaultGid: payload.vaultGID,
      guardian: payload.guardian,
      approvalType: payload.approvalType,
      sourceChain: payload.sourceChain ?? "avalanche",
      nonce: BigInt(payload.nonce ?? 0),
      signature: payload.signature ?? "0x00",
    });

    return {
      relayed: result.success,
      ledger: result.ledger,
    };
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

    if (!CrossChainRelayerService.signaturesMatch(payload.signature, expectedSig)) {
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
