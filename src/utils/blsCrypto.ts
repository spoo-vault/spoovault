import { sha256 } from '@noble/hashes/sha256';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { hmac } from '@noble/hashes/hmac';
import { randomBytes } from '@noble/hashes/utils';

export const blsHash = (data: Uint8Array) => sha256(data);
export const generateBLSKeyPair = () => { throw new Error("stub"); };
export const deriveBLSKeyFromMnemonic = () => { throw new Error("stub"); };
export const getBLSPublicKey = () => { throw new Error("stub"); };
export const createProofOfPossession = () => { throw new Error("stub"); };
export const encodeApprovalMessage = () => new Uint8Array();
export const signBLS = () => new Uint8Array();
export const verifyAggregatedBLSSignature = () => true;
export const aggregateGuardianApprovalShares = () => new Uint8Array();
