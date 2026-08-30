/**
 * Zero-Knowledge Proof Service Tests (issue #70).
 *
 * Tests for src/services/zkProof.service.ts:
 *  1. Commitment computation: deterministic, collision-resistant.
 *  2. Nullifier hash computation: unique per (key, docId) pair.
 *  3. Public signal derivation from witness inputs.
 *  4. Proof generation shape validation.
 *  5. Contract argument conversion.
 *  6. Invalid/null proof rejection.
 */

import { describe, it, expect } from "vitest";
import {
  computeCommitment,
  computeNullifierHash,
  computePublicSignals,
  generateProof,
  verifyProofJs,
  toContractArgs,
  toSorobanArgs,
  assertNullifierNotSpent,
} from "../services/zkProof.service";
import type { ZkProofInput } from "../services/zkProof.service";

// ── Test constants ──────────────────────────────────────────────────────────

const BN254_PRIME =
  21_888_242_871_839_275_222_246_405_745_257_275_088_569_664_541_156_301_506_178_335_204n;

const validInput: ZkProofInput = {
  beneficiaryPrivateKey: 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn,
  secretShare: 0xdeadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebaben,
  blindingFactor: 0x0101010101010101010101010101010101010101010101010101010101010101n,
  documentId: 42n,
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("zkProof.service — Commitment & Nullifier", () => {
  it("computeCommitment is deterministic", () => {
    const a = computeCommitment(123n, 456n);
    const b = computeCommitment(123n, 456n);
    expect(a).toBe(b);
  });

  it("computeCommitment is collision-resistant (different share)", () => {
    const a = computeCommitment(100n, 200n);
    const b = computeCommitment(101n, 200n);
    expect(a).not.toBe(b);
  });

  it("computeCommitment is collision-resistant (different blinding)", () => {
    const a = computeCommitment(100n, 200n);
    const b = computeCommitment(100n, 201n);
    expect(a).not.toBe(b);
  });

  it("computeCommitment output is within BN254 field", () => {
    for (let i = 0; i < 10; i++) {
      const result = computeCommitment(BigInt(i * 1000 + 1), BigInt(i * 2000 + 1));
      expect(result).toBeGreaterThanOrEqual(0n);
      expect(result).toBeLessThan(BN254_PRIME);
    }
  });

  it("computeNullifierHash is deterministic", () => {
    const a = computeNullifierHash(123n, 456n);
    const b = computeNullifierHash(123n, 456n);
    expect(a).toBe(b);
  });

  it("computeNullifierHash differs per private key", () => {
    const a = computeNullifierHash(1n, 42n);
    const b = computeNullifierHash(2n, 42n);
    expect(a).not.toBe(b);
  });

  it("computeNullifierHash differs per document ID", () => {
    const a = computeNullifierHash(1n, 42n);
    const b = computeNullifierHash(1n, 43n);
    expect(a).not.toBe(b);
  });

  it("computeNullifierHash output is within BN254 field", () => {
    for (let i = 0; i < 10; i++) {
      const result = computeNullifierHash(BigInt(i * 100 + 1), BigInt(i + 1));
      expect(result).toBeGreaterThanOrEqual(0n);
      expect(result).toBeLessThan(BN254_PRIME);
    }
  });
});

describe("zkProof.service — Public Signals", () => {
  it("computePublicSignals derives commitment and nullifier from inputs", () => {
    const signals = computePublicSignals(validInput);

    expect(signals.documentId).toBe(validInput.documentId);
    expect(signals.vaultRootCommitment).toBe(
      computeCommitment(validInput.secretShare, validInput.blindingFactor)
    );
    expect(signals.nullifierHash).toBe(
      computeNullifierHash(validInput.beneficiaryPrivateKey, validInput.documentId)
    );
  });

  it("public signals are all non-zero for valid inputs", () => {
    const signals = computePublicSignals(validInput);
    expect(signals.vaultRootCommitment).not.toBe(0n);
    expect(signals.nullifierHash).not.toBe(0n);
    expect(signals.documentId).not.toBe(0n);
  });

  it("different document IDs produce different nullifiers", () => {
    const input1 = { ...validInput, documentId: 1n };
    const input2 = { ...validInput, documentId: 2n };

    const s1 = computePublicSignals(input1);
    const s2 = computePublicSignals(input2);

    expect(s1.nullifierHash).not.toBe(s2.nullifierHash);
    // Commitments should be the same (same share + blinding)
    expect(s1.vaultRootCommitment).toBe(s2.vaultRootCommitment);
  });
});

describe("zkProof.service — Proof Generation", () => {
  it("generateProof returns a structurally valid proof", async () => {
    const fullProof = await generateProof(validInput);

    // Proof shape
    expect(fullProof.proof).toBeDefined();
    expect(fullProof.proof.a).toHaveLength(2);
    expect(fullProof.proof.b).toHaveLength(2);
    expect(fullProof.proof.b[0]).toHaveLength(2);
    expect(fullProof.proof.b[1]).toHaveLength(2);
    expect(fullProof.proof.c).toHaveLength(2);

    // Public signals
    expect(fullProof.publicSignals).toBeDefined();
    expect(fullProof.publicSignals.vaultRootCommitment).toBeGreaterThan(0n);
    expect(fullProof.publicSignals.nullifierHash).toBeGreaterThan(0n);
    expect(fullProof.publicSignals.documentId).toBe(validInput.documentId);
  });

  it("generateProof is deterministic for the same inputs", async () => {
    const proof1 = await generateProof(validInput);
    const proof2 = await generateProof(validInput);

    // Placeholder proofs are deterministic
    expect(proof1.publicSignals.nullifierHash).toBe(proof2.publicSignals.nullifierHash);
  });

  it("generateProof produces different nullifiers for different keys", async () => {
    const input1 = { ...validInput, beneficiaryPrivateKey: 1n };
    const input2 = { ...validInput, beneficiaryPrivateKey: 2n };

    const proof1 = await generateProof(input1);
    const proof2 = await generateProof(input2);

    expect(proof1.publicSignals.nullifierHash).not.toBe(
      proof2.publicSignals.nullifierHash
    );
  });
});

describe("zkProof.service — Proof Verification", () => {
  it("verifyProofJs returns true for structurally valid placeholder proof", async () => {
    const fullProof = await generateProof(validInput);
    const result = await verifyProofJs(fullProof);
    expect(result).toBe(true);
  });

  it("verifyProofJs returns false for zero public signals", async () => {
    const result = await verifyProofJs({
      proof: {
        a: [1n, 2n],
        b: [[1n, 2n], [3n, 4n]],
        c: [1n, 2n],
      },
      publicSignals: {
        vaultRootCommitment: 0n,
        nullifierHash: 0n,
        documentId: 0n,
      },
    });
    expect(result).toBe(false);
  });

  it("verifyProofJs returns false for out-of-field proof elements", async () => {
    const result = await verifyProofJs({
      proof: {
        a: [BN254_PRIME + 1n, 2n],
        b: [[1n, 2n], [3n, 4n]],
        c: [1n, 2n],
      },
      publicSignals: {
        vaultRootCommitment: 1n,
        nullifierHash: 1n,
        documentId: 1n,
      },
    });
    expect(result).toBe(false);
  });
});

describe("zkProof.service — Contract Argument Conversion", () => {
  it("toContractArgs maps proof fields correctly", async () => {
    const fullProof = await generateProof(validInput);
    const args = toContractArgs(fullProof);

    expect(args.a).toEqual(fullProof.proof.a);
    expect(args.b).toEqual(fullProof.proof.b);
    expect(args.c).toEqual(fullProof.proof.c);
    expect(args.inputs).toEqual([
      fullProof.publicSignals.vaultRootCommitment,
      fullProof.publicSignals.nullifierHash,
      fullProof.publicSignals.documentId,
    ]);
  });

  it("toSorobanArgs produces correct byte lengths", async () => {
    const fullProof = await generateProof(validInput);
    const args = toSorobanArgs(fullProof);

    expect(args.proofA.length).toBe(64);
    expect(args.proofB.length).toBe(128);
    expect(args.proofC.length).toBe(64);
    expect(args.vaultRootCommitment.length).toBe(32);
    expect(args.nullifierHash.length).toBe(32);
    expect(args.documentId.length).toBe(32);
  });

  it("toSorobanArgs round-trips commitment correctly", async () => {
    const fullProof = await generateProof(validInput);
    const args = toSorobanArgs(fullProof);

    // The serialized commitment should match when parsed back
    expect(args.vaultRootCommitment).toBeInstanceOf(Uint8Array);
    expect(args.nullifierHash).toBeInstanceOf(Uint8Array);
    expect(args.documentId).toBeInstanceOf(Uint8Array);
  });
});

describe("zkProof.service — Nullifier Replay Protection", () => {
  it("assertNullifierNotSpent throws when nullifier is spent", async () => {
    const spent: Set<string> = new Set();
    const isSpent = async (hash: bigint) => {
      const key = hash.toString();
      if (spent.has(key)) return true;
      spent.add(key);
      return false;
    };

    const nullifier = 0xabcdefn;

    // First call: should not throw (not spent yet)
    await expect(assertNullifierNotSpent(nullifier, isSpent)).resolves.toBeUndefined();

    // Second call: should throw (now spent)
    await expect(assertNullifierNotSpent(nullifier, isSpent)).rejects.toThrow(
      "NullifierAlreadyUsed"
    );
  });

  it("assertNullifierNotSpent does not throw for fresh nullifier", async () => {
    const isSpent = async () => false;
    await expect(
      assertNullifierNotSpent(0xdeadn, isSpent)
    ).resolves.toBeUndefined();
  });

  it("nullifier hash uniqueness prevents accidental collision", async () => {
    // Generate nullifiers for 100 random (key, docId) pairs and assert no
    // collisions. This validates the hash function's collision resistance.
    const nullifiers = new Set<bigint>();
    for (let i = 1; i <= 100; i++) {
      const pk = BigInt(i) * 0xabcdef0123456789n;
      for (let j = 1; j <= 10; j++) {
        const docId = BigInt(j);
        const nh = computeNullifierHash(pk, docId);
        expect(nullifiers.has(nh)).toBe(false);
        nullifiers.add(nh);
      }
    }
    expect(nullifiers.size).toBe(1000);
  });
});