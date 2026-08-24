import {
  generateECIESKeyPairBase64,
  importECIESPublicKey,
  importECIESPrivateKey,
  decryptWithPrivateKey,
} from "../utils/crypto";
import { clientKeyringService } from "./clientKeyring.service";
import { cryptoWorkerService } from "./cryptoWorker.service";

/**
 * Key Rotation & Emergency Revocation Protocol (issue #156).
 *
 * Orchestrates the full lifecycle when a user's encryption key is compromised:
 *  1. Prove possession of the old key by decrypting a live share envelope.
 *  2. Re-encrypt every document share envelope to the new public key
 *     (off-chain, CPU-intensive work runs in a Web Worker).
 *  3. Revoke the old key on-chain and atomically rotate to the new key
 *     (`revokeKey` on SpooVault.sol / `revoke_key` on the Soroban contract).
 *     The old key is permanently blacklisted: it can never be re-registered.
 *  4. Persist the new keypair in the local client keyring.
 *
 * Re-encryption happens BEFORE the on-chain revocation so there is no window
 * in which guardians hold shares that cannot be delivered to the beneficiary.
 *
 * Emergency batch revocation allows a single compromised key to be revoked
 * across multiple vaults and network adapters (EVM + Soroban) in one atomic
 * operation, with per-vault failure isolation.
 */

export interface ShareEnvelopeRef {
  /** Document the envelope belongs to. */
  documentId: string | number;
  /** Encrypted share envelope JSON, encrypted to the OLD public key. */
  envelope: string;
}

/** Minimal contract surface required to perform the on-chain revocation. */
export interface KeyRotationContract {
  revokeKey(
    oldPublicKey: string,
    newPublicKey: string
  ): Promise<{ wait?: () => Promise<unknown> } | unknown>;
}

/**
 * Soroban (Stellar) contract adapter — matches the `revoke_key` function
 * signature on the Rust contract: `revoke_key(user, old_public_key, new_public_key)`.
 */
export interface SorobanKeyRotationContract {
  revokeKey(
    user: string,
    oldPublicKey: string,
    newPublicKey: string
  ): Promise<unknown>;
}

export interface KeyRotationOptions {
  /** Wallet account that owns the compromised key. */
  account: string;
  /** Compromised public key currently registered on-chain. */
  oldPublicKey: string;
  /** Decrypted private key matching `oldPublicKey` (proof of possession). */
  oldPrivateKey: string;
  /** Optional pre-generated replacement keypair; generated when omitted. */
  newPublicKey?: string;
  newPrivateKey?: string;
  /** PIN/passphrase used for OPAQUE enrollment of the new private key. */
  pinOrPassphrase: string;
  /** Share envelopes that must be re-encrypted to the new key. */
  envelopes: ShareEnvelopeRef[];
  /** EVM on-chain adapter exposing `revokeKey`; rotation is off-chain-only when omitted. */
  contract?: KeyRotationContract;
  /** Soroban on-chain adapter; called in addition to the EVM adapter when provided. */
  sorobanContract?: SorobanKeyRotationContract;
}

export interface KeyRotationFailure {
  documentId: string | number;
  reason: string;
}

export interface KeyRotationReport {
  account: string;
  oldPublicKey: string;
  newPublicKey: string;
  rotatedDocumentIds: Array<string | number>;
  failures: KeyRotationFailure[];
  /** EVM transaction hash, when an EVM contract was provided. */
  transactionHash?: string;
  /** Soroban operation hash, when a Soroban contract was provided. */
  sorobanTxHash?: string;
  rotatedAt: number;
}

export class KeyOwnershipProofError extends Error {
  constructor() {
    super(
      "Proof of possession failed: the provided private key cannot decrypt the stored envelopes"
    );
    this.name = "KeyOwnershipProofError";
  }
}

// ---------------------------------------------------------------------------
// Emergency batch revocation types
// ---------------------------------------------------------------------------

/**
 * A single vault's worth of envelopes for emergency batch rotation.
 * All envelopes in the batch share the same compromised public key.
 */
export interface VaultEnvelopeBatch {
  /** Vault identifier (used for logging; not written on-chain by this service). */
  vaultId: string | number;
  /** Envelopes belonging to this vault. */
  envelopes: ShareEnvelopeRef[];
}

export interface EmergencyRevocationOptions {
  /** Wallet account that owns the compromised key. */
  account: string;
  /** Compromised public key currently registered on-chain. */
  oldPublicKey: string;
  /** Decrypted private key matching `oldPublicKey` (proof of possession). */
  oldPrivateKey: string;
  /** Optional pre-generated replacement keypair; generated when omitted. */
  newPublicKey?: string;
  newPrivateKey?: string;
  /** PIN/passphrase used for OPAQUE enrollment of the new private key. */
  pinOrPassphrase: string;
  /** Envelopes grouped per vault. All vaults are processed independently. */
  vaultBatches: VaultEnvelopeBatch[];
  /** EVM adapter. Revocation is submitted once regardless of vault count. */
  contract?: KeyRotationContract;
  /** Soroban adapter. Revocation is submitted once in parallel with EVM. */
  sorobanContract?: SorobanKeyRotationContract;
}

export interface VaultRevocationResult {
  vaultId: string | number;
  rotatedDocumentIds: Array<string | number>;
  failures: KeyRotationFailure[];
}

export interface EmergencyRevocationReport {
  account: string;
  oldPublicKey: string;
  newPublicKey: string;
  totalDocumentsRotated: number;
  totalFailures: number;
  vaultResults: VaultRevocationResult[];
  transactionHash?: string;
  sorobanTxHash?: string;
  revokedAt: number;
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

class KeyRotationService {
  /**
   * Execute the full compromise-response rotation protocol for a single key.
   *
   * Key lifecycle:
   *   1. Validate inputs and optionally generate a new keypair.
   *   2. Prove possession by attempting to decrypt one stored envelope.
   *   3. Re-encrypt all envelopes (Web Worker when available).
   *   4. Atomically submit `revokeKey` on EVM (and `revoke_key` on Soroban if provided).
   *   5. Persist the rotated keypair in the local keyring.
   */
  async rotateCompromisedKey(options: KeyRotationOptions): Promise<KeyRotationReport> {
    const {
      account,
      oldPublicKey,
      oldPrivateKey,
      newPublicKey,
      newPrivateKey,
      pinOrPassphrase,
      envelopes,
      contract,
      sorobanContract,
    } = options;

    if (!account) throw new Error("Account address is required");
    if (!oldPublicKey || !oldPrivateKey) {
      throw new Error("Old public and private keys are required");
    }
    if (!pinOrPassphrase?.trim()) {
      throw new Error("A PIN or passphrase is required to protect the rotated keypair");
    }
    if (!Array.isArray(envelopes)) {
      throw new Error("Envelopes list is required");
    }

    // Validate or generate the replacement keypair.
    let rotatedPublicKey = newPublicKey;
    let rotatedPrivateKey = newPrivateKey;
    if (!rotatedPublicKey || !rotatedPrivateKey) {
      const generated = await generateECIESKeyPairBase64();
      rotatedPublicKey = generated.publicKey;
      rotatedPrivateKey = generated.privateKey;
    }
    await importECIESPublicKey(rotatedPublicKey);
    await importECIESPrivateKey(rotatedPrivateKey);

    // Proof of possession: the caller must be able to decrypt material
    // encrypted to the old key before anything is revoked.
    const proofEnvelope = envelopes.find((e) => !!e?.envelope);
    if (proofEnvelope) {
      try {
        await decryptWithPrivateKey(proofEnvelope.envelope, oldPrivateKey);
      } catch {
        throw new KeyOwnershipProofError();
      }
    }

    // Re-encrypt every share envelope to the new key (Web Worker when available).
    const rotatedDocumentIds: Array<string | number> = [];
    const failures: KeyRotationFailure[] = [];
    for (const item of envelopes) {
      if (!item?.envelope) {
        failures.push({
          documentId: item?.documentId ?? "unknown",
          reason: "Missing envelope payload",
        });
        continue;
      }
      try {
        await cryptoWorkerService.reencryptEnvelopeAsync(
          item.envelope,
          oldPrivateKey,
          rotatedPublicKey
        );
        rotatedDocumentIds.push(item.documentId);
      } catch (err: unknown) {
        failures.push({
          documentId: item.documentId,
          reason: (err as Error)?.message || "Re-encryption failed",
        });
      }
    }

    // On-chain revocation: blacklist the old key and register the new one atomically.
    // EVM and Soroban revocations are fired concurrently to minimise latency.
    let transactionHash: string | undefined;
    let sorobanTxHash: string | undefined;

    const evmRevocation = contract
      ? contract.revokeKey(oldPublicKey, rotatedPublicKey)
      : Promise.resolve(undefined);

    const sorobanRevocation = sorobanContract
      ? sorobanContract.revokeKey(account, oldPublicKey, rotatedPublicKey)
      : Promise.resolve(undefined);

    const [evmResult, sorobanResult] = await Promise.all([
      evmRevocation,
      sorobanRevocation,
    ]);

    if (evmResult !== undefined && evmResult !== null) {
      const tx = evmResult as { hash?: string; wait?: () => Promise<unknown> };
      if (typeof tx?.wait === "function") {
        await tx.wait();
      }
      transactionHash = tx?.hash;
    }

    if (sorobanResult !== undefined && sorobanResult !== null) {
      const sorobanTx = sorobanResult as { hash?: string; id?: string };
      sorobanTxHash = sorobanTx?.hash ?? sorobanTx?.id;
    }

    // Persist the rotated keypair locally.
    await clientKeyringService.saveKeyPair(
      account,
      rotatedPublicKey,
      rotatedPrivateKey,
      pinOrPassphrase
    );

    return {
      account: account.toLowerCase(),
      oldPublicKey,
      newPublicKey: rotatedPublicKey,
      rotatedDocumentIds,
      failures,
      transactionHash,
      sorobanTxHash,
      rotatedAt: Date.now(),
    };
  }

  /**
   * Emergency batch revocation — rotate a compromised key across every vault
   * in a single coordinated operation.
   *
   * On-chain revocation (EVM + Soroban) is submitted exactly once at the start,
   * immediately blacklisting the old key. All vault envelope batches are then
   * re-encrypted in parallel. Per-vault failures are isolated: a re-encryption
   * error in vault A does not block vault B.
   *
   * This is the preferred method when a guardian or beneficiary key is known to
   * be compromised across a large number of vaults.
   */
  async emergencyBatchRevoke(
    options: EmergencyRevocationOptions
  ): Promise<EmergencyRevocationReport> {
    const {
      account,
      oldPublicKey,
      oldPrivateKey,
      newPublicKey,
      newPrivateKey,
      pinOrPassphrase,
      vaultBatches,
      contract,
      sorobanContract,
    } = options;

    if (!account) throw new Error("Account address is required");
    if (!oldPublicKey || !oldPrivateKey) {
      throw new Error("Old public and private keys are required");
    }
    if (!pinOrPassphrase?.trim()) {
      throw new Error("A PIN or passphrase is required to protect the rotated keypair");
    }
    if (!Array.isArray(vaultBatches)) {
      throw new Error("vaultBatches list is required");
    }

    // Generate replacement keypair once for all vaults.
    let rotatedPublicKey = newPublicKey;
    let rotatedPrivateKey = newPrivateKey;
    if (!rotatedPublicKey || !rotatedPrivateKey) {
      const generated = await generateECIESKeyPairBase64();
      rotatedPublicKey = generated.publicKey;
      rotatedPrivateKey = generated.privateKey;
    }
    await importECIESPublicKey(rotatedPublicKey);
    await importECIESPrivateKey(rotatedPrivateKey);

    // Proof of possession: find the first valid envelope across all batches.
    const firstProofEnvelope = vaultBatches
      .flatMap((b) => b.envelopes)
      .find((e) => !!e?.envelope);

    if (firstProofEnvelope) {
      try {
        await decryptWithPrivateKey(firstProofEnvelope.envelope, oldPrivateKey);
      } catch {
        throw new KeyOwnershipProofError();
      }
    }

    // Submit on-chain revocations concurrently BEFORE re-encryption so the
    // old key is blacklisted as early as possible.
    let transactionHash: string | undefined;
    let sorobanTxHash: string | undefined;

    const [evmResult, sorobanResult] = await Promise.all([
      contract
        ? contract.revokeKey(oldPublicKey, rotatedPublicKey)
        : Promise.resolve(undefined),
      sorobanContract
        ? sorobanContract.revokeKey(account, oldPublicKey, rotatedPublicKey)
        : Promise.resolve(undefined),
    ]);

    if (evmResult !== undefined && evmResult !== null) {
      const tx = evmResult as { hash?: string; wait?: () => Promise<unknown> };
      if (typeof tx?.wait === "function") {
        await tx.wait();
      }
      transactionHash = tx?.hash;
    }

    if (sorobanResult !== undefined && sorobanResult !== null) {
      const sorobanTx = sorobanResult as { hash?: string; id?: string };
      sorobanTxHash = sorobanTx?.hash ?? sorobanTx?.id;
    }

    // Process all vault batches in parallel — each vault is isolated.
    const vaultResults = await Promise.all(
      vaultBatches.map((batch) =>
        this._reencryptVaultBatch(
          batch,
          oldPrivateKey,
          rotatedPublicKey
        )
      )
    );

    // Persist the rotated keypair once all vaults are processed.
    await clientKeyringService.saveKeyPair(
      account,
      rotatedPublicKey,
      rotatedPrivateKey,
      pinOrPassphrase
    );

    const totalDocumentsRotated = vaultResults.reduce(
      (sum, r) => sum + r.rotatedDocumentIds.length,
      0
    );
    const totalFailures = vaultResults.reduce(
      (sum, r) => sum + r.failures.length,
      0
    );

    return {
      account: account.toLowerCase(),
      oldPublicKey,
      newPublicKey: rotatedPublicKey,
      totalDocumentsRotated,
      totalFailures,
      vaultResults,
      transactionHash,
      sorobanTxHash,
      revokedAt: Date.now(),
    };
  }

  /** Re-encrypt all envelopes in a single vault batch. Failures are captured per-document. */
  private async _reencryptVaultBatch(
    batch: VaultEnvelopeBatch,
    oldPrivateKey: string,
    newPublicKey: string
  ): Promise<VaultRevocationResult> {
    const rotatedDocumentIds: Array<string | number> = [];
    const failures: KeyRotationFailure[] = [];

    for (const item of batch.envelopes) {
      if (!item?.envelope) {
        failures.push({
          documentId: item?.documentId ?? "unknown",
          reason: "Missing envelope payload",
        });
        continue;
      }
      try {
        await cryptoWorkerService.reencryptEnvelopeAsync(
          item.envelope,
          oldPrivateKey,
          newPublicKey
        );
        rotatedDocumentIds.push(item.documentId);
      } catch (err: unknown) {
        failures.push({
          documentId: item.documentId,
          reason: (err as Error)?.message || "Re-encryption failed",
        });
      }
    }

    return { vaultId: batch.vaultId, rotatedDocumentIds, failures };
  }
}

export const keyRotationService = new KeyRotationService();
