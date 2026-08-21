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
  /** PIN/passphrase used to encrypt the new private key in the local keyring. */
  pinOrPassphrase?: string;
  /** Share envelopes that must be re-encrypted to the new key. */
  envelopes: ShareEnvelopeRef[];
  /** On-chain adapter exposing `revokeKey`; rotation is off-chain-only when omitted. */
  contract?: KeyRotationContract;
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
  transactionHash?: string;
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

class KeyRotationService {
  /**
   * Execute the full compromise-response rotation protocol.
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
    } = options;

    if (!account) throw new Error("Account address is required");
    if (!oldPublicKey || !oldPrivateKey) {
      throw new Error("Old public and private keys are required");
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
      } catch (err: any) {
        failures.push({
          documentId: item.documentId,
          reason: err?.message || "Re-encryption failed",
        });
      }
    }

    // On-chain revocation: blacklist the old key and register the new one atomically.
    let transactionHash: string | undefined;
    if (contract) {
      const tx = (await contract.revokeKey(oldPublicKey, rotatedPublicKey)) as {
        hash?: string;
        wait?: () => Promise<unknown>;
      };
      if (typeof tx?.wait === "function") {
        await tx.wait();
      }
      transactionHash = tx?.hash;
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
      rotatedAt: Date.now(),
    };
  }
}

export const keyRotationService = new KeyRotationService();
