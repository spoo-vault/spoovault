import { bls12_381 } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { ethers } from 'ethers';
import { BLSKeyPair, BLSSignatureShare, BLSAggregatedApprovalPayload } from '../types/bls';

const bls = bls12_381.longSignatures;

/** Domain separation tag for SpooVault BLS Guardian Approvals */
export const BLS_APPROVAL_DST = new TextEncoder().encode('BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_SPOOVAULT_APPROVAL_V1');
export const BLS_POP_DST = new TextEncoder().encode('BLS_POP_BLS12381G2_XMD:SHA-256_SSWU_RO_SPOOVAULT_POP_V1');

/** Convert Uint8Array to 0x-prefixed hex string */
export function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Convert hex string (with or without 0x) to Uint8Array */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleanHex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Generate a random BLS12-381 keypair with Proof of Possession (PoP).
 * @param seed Optional 32-48 byte random entropy seed.
 */
export function generateBLSKeyPair(seed?: Uint8Array): BLSKeyPair {
  const rawSeed = seed && seed.length >= 32 ? seed : crypto.getRandomValues(new Uint8Array(48));
  const keyInfo = bls.keygen(rawSeed);
  const privateKeyHex = bytesToHex(keyInfo.secretKey);
  const publicKeyBytes = keyInfo.publicKey.toBytes();
  const publicKeyHex = bytesToHex(publicKeyBytes);
  const popHex = createProofOfPossession(privateKeyHex, publicKeyHex);

  return {
    privateKey: privateKeyHex,
    publicKey: publicKeyHex,
    proofOfPossession: popHex,
    createdAt: Date.now()
  };
}

/**
 * Derive a deterministic BLS12-381 keypair from a BIP-39 mnemonic seed using PBKDF2.
 */
export function deriveBLSKeyFromMnemonic(mnemonic: string, accountIndex = 0): BLSKeyPair {
  const normalizedMnemonic = mnemonic.trim().toLowerCase();
  const salt = new TextEncoder().encode(`mnemonic_bls12_381_account_${accountIndex}`);
  const seed = pbkdf2(sha256, new TextEncoder().encode(normalizedMnemonic), salt, { c: 4096, dkLen: 48 });
  return generateBLSKeyPair(seed);
}

/**
 * Derive the 48-byte G1 compressed public key from a 32-byte secret key.
 */
export function getBLSPublicKey(privateKeyHex: string): string {
  const privKeyBytes = hexToBytes(privateKeyHex);
  const pubPoint = bls.getPublicKey(privKeyBytes);
  return bytesToHex(pubPoint.toBytes());
}

/**
 * Generate a Proof of Possession (PoP) signature over the public key.
 * Used to defend against rogue-key aggregation attacks.
 */
export function createProofOfPossession(privateKeyHex: string, publicKeyHex: string): string {
  const privBytes = hexToBytes(privateKeyHex);
  const pubBytes = hexToBytes(publicKeyHex);
  // Hash the public key under the POP domain separation tag
  const popHash = bls12_381.G2.hashToCurve(pubBytes, { DST: BLS_POP_DST });
  const popSig = bls.sign(popHash, privBytes);
  return bytesToHex(popSig.toBytes());
}

/**
 * Verify a Proof of Possession signature.
 */
export function verifyProofOfPossession(publicKeyHex: string, popHex: string): boolean {
  try {
    const pubBytes = hexToBytes(publicKeyHex);
    const popBytes = hexToBytes(popHex);
    const pubPoint = bls12_381.G1.Point.fromBytes(pubBytes);
    const popSig = bls12_381.G2.Point.fromBytes(popBytes);
    const popHash = bls12_381.G2.hashToCurve(pubBytes, { DST: BLS_POP_DST });
    return bls.verify(popSig, popHash, pubPoint);
  } catch {
    return false;
  }
}

/**
 * Format the structured access approval claim for signing.
 */
export function encodeApprovalMessage(
  requestId: number,
  vaultId: number,
  documentId: number,
  beneficiary: string,
  chainId = 31337
): Uint8Array {
  const normalizedBeneficiary = ethers.getAddress(beneficiary);
  const encoded = ethers.solidityPacked(
    ['string', 'uint256', 'uint256', 'uint256', 'address', 'uint256'],
    ['SPOOVAULT_ACCESS_APPROVAL_V1', requestId, vaultId, documentId, normalizedBeneficiary, chainId]
  );
  return hexToBytes(encoded);
}

/**
 * Compute the 32-byte keccak256 message digest of an approval claim.
 */
export function hashApprovalMessage(
  requestId: number,
  vaultId: number,
  documentId: number,
  beneficiary: string,
  chainId = 31337
): string {
  const msgBytes = encodeApprovalMessage(requestId, vaultId, documentId, beneficiary, chainId);
  return ethers.keccak256(msgBytes);
}

/**
 * Sign an approval message with a BLS12-381 secret key.
 * @returns 96-byte G2 compressed signature in hex.
 */
export function signBLS(message: Uint8Array | string, privateKeyHex: string): string {
  const privBytes = hexToBytes(privateKeyHex);
  const msgBytes = typeof message === 'string' ? (message.startsWith('0x') ? hexToBytes(message) : new TextEncoder().encode(message)) : message;
  const hashedPoint = bls12_381.G2.hashToCurve(msgBytes, { DST: BLS_APPROVAL_DST });
  const sigPoint = bls.sign(hashedPoint, privBytes);
  return bytesToHex(sigPoint.toBytes());
}

/**
 * Verify a single BLS12-381 signature.
 */
export function verifyBLSSignature(
  signatureHex: string,
  message: Uint8Array | string,
  publicKeyHex: string
): boolean {
  try {
    const sigBytes = hexToBytes(signatureHex);
    const pubBytes = hexToBytes(publicKeyHex);
    const msgBytes = typeof message === 'string' ? (message.startsWith('0x') ? hexToBytes(message) : new TextEncoder().encode(message)) : message;
    const sigPoint = bls12_381.G2.Point.fromBytes(sigBytes);
    const pubPoint = bls12_381.G1.Point.fromBytes(pubBytes);
    const hashedPoint = bls12_381.G2.hashToCurve(msgBytes, { DST: BLS_APPROVAL_DST });
    return bls.verify(sigPoint, hashedPoint, pubPoint);
  } catch {
    return false;
  }
}

/**
 * Aggregate multiple 96-byte G2 BLS signatures into a single 96-byte signature:
 * S_agg = sum(S_i)
 */
export function aggregateBLSSignatures(signaturesHex: string[]): string {
  if (!signaturesHex || signaturesHex.length === 0) {
    throw new Error('Cannot aggregate empty signature list');
  }
  if (signaturesHex.length === 1) {
    return signaturesHex[0];
  }
  const sigPoints = signaturesHex.map(sig => bls12_381.G2.Point.fromBytes(hexToBytes(sig)));
  const aggPoint = bls.aggregateSignatures(sigPoints);
  return bytesToHex(aggPoint.toBytes());
}

/**
 * Aggregate multiple 48-byte G1 BLS public keys into a single 48-byte public key:
 * PK_agg = sum(PK_i)
 */
export function aggregateBLSPublicKeys(publicKeysHex: string[]): string {
  if (!publicKeysHex || publicKeysHex.length === 0) {
    throw new Error('Cannot aggregate empty public key list');
  }
  if (publicKeysHex.length === 1) {
    return publicKeysHex[0];
  }
  const pubPoints = publicKeysHex.map(pk => bls12_381.G1.Point.fromBytes(hexToBytes(pk)));
  const aggPoint = bls.aggregatePublicKeys(pubPoints);
  return bytesToHex(aggPoint.toBytes());
}

/**
 * Verify an aggregated BLS12-381 signature against an aggregated public key:
 * e(S_agg, G1) == e(H(m), PK_agg) in a single pairing operation!
 */
export function verifyAggregatedBLSSignature(
  aggregatedSignatureHex: string,
  message: Uint8Array | string,
  aggregatedPublicKeyHex: string
): boolean {
  try {
    const aggSigBytes = hexToBytes(aggregatedSignatureHex);
    const aggPubBytes = hexToBytes(aggregatedPublicKeyHex);
    const msgBytes = typeof message === 'string' ? (message.startsWith('0x') ? hexToBytes(message) : new TextEncoder().encode(message)) : message;
    const aggSigPoint = bls12_381.G2.Point.fromBytes(aggSigBytes);
    const aggPubPoint = bls12_381.G1.Point.fromBytes(aggPubBytes);
    const hashedPoint = bls12_381.G2.hashToCurve(msgBytes, { DST: BLS_APPROVAL_DST });
    return bls.verify(aggSigPoint, hashedPoint, aggPubPoint);
  } catch {
    return false;
  }
}

/**
 * Collect, validate, and aggregate K-of-N guardian approval shares into an on-chain submission payload.
 */
export function aggregateGuardianApprovalShares(
  shares: BLSSignatureShare[],
  requestId: number,
  vaultId: number,
  documentId: number,
  beneficiary: string,
  threshold: number,
  chainId = 31337
): BLSAggregatedApprovalPayload {
  if (shares.length < threshold) {
    throw new Error(`Insufficient guardian shares: received ${shares.length}, required ${threshold}`);
  }

  // Deduplicate by guardian address
  const uniqueSharesMap = new Map<string, BLSSignatureShare>();
  for (const share of shares) {
    const addr = ethers.getAddress(share.guardianAddress);
    if (!uniqueSharesMap.has(addr)) {
      uniqueSharesMap.set(addr, share);
    }
  }

  const selectedShares = Array.from(uniqueSharesMap.values()).slice(0, threshold);
  const msgBytes = encodeApprovalMessage(requestId, vaultId, documentId, beneficiary, chainId);
  const msgDigest = hashApprovalMessage(requestId, vaultId, documentId, beneficiary, chainId);

  // Validate each individual share before aggregating
  for (const share of selectedShares) {
    const isValid = verifyBLSSignature(share.signature, msgBytes, share.publicKey);
    if (!isValid) {
      throw new Error(`Invalid BLS signature from guardian ${share.guardianAddress}`);
    }
  }

  const signatures = selectedShares.map(s => s.signature);
  const publicKeys = selectedShares.map(s => s.publicKey);
  const guardianAddresses = selectedShares.map(s => ethers.getAddress(s.guardianAddress));
  const guardianIndices = selectedShares.map((s, idx) => s.guardianIndex !== undefined ? s.guardianIndex : idx);
  const encryptedSharesForBeneficiary = selectedShares.map(s => s.encryptedBeneficiaryShare || '');

  const aggregatedSignature = aggregateBLSSignatures(signatures);
  const aggregatedPublicKey = aggregateBLSPublicKeys(publicKeys);

  // Verify aggregated result
  const isAggValid = verifyAggregatedBLSSignature(aggregatedSignature, msgBytes, aggregatedPublicKey);
  if (!isAggValid) {
    throw new Error('Aggregated signature verification failed');
  }

  return {
    requestId,
    vaultId,
    documentId,
    beneficiary: ethers.getAddress(beneficiary),
    guardianAddresses,
    guardianIndices,
    publicKeys,
    aggregatedPublicKey,
    aggregatedSignature,
    encryptedSharesForBeneficiary,
    messageDigest: msgDigest
  };
}
