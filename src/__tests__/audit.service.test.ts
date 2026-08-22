import { describe, it, expect } from "vitest";
import { auditService } from "../services/audit.service";
import {
  VaultData,
  DocumentData,
  ActivityEvent,
} from "../services/contract.service";

describe("AuditService (Cryptographic Audit Certificate Exporter)", () => {
  const mockVault: VaultData = {
    id: 101,
    creator: "0x1111111111111111111111111111111111111111",
    name: "Vault Alpha",
    description: "Test Vault Description",
    guardians: ["0x2222222222222222222222222222222222222222"],
    approvalThreshold: 1,
    isActive: true,
    createdAt: 1700000000,
  };

  const mockDocuments: DocumentData[] = [
    {
      id: 1,
      vaultId: 101,
      encryptedMetadata: "enc-meta",
      ipfsHash: "QmTestIPFSHash123456789",
      uploadedBy: "0x1111111111111111111111111111111111111111",
      uploadedAt: 1700000050,
      requiredAccess: 0,
    },
  ];

  const mockActivities: ActivityEvent[] = [
    {
      action: "VAULT_CREATED",
      actor: "0x1111111111111111111111111111111111111111",
      timestamp: 1700000000,
      status: "success",
    },
  ];

  it("should generate an audit certificate with valid SHA-256 digest", () => {
    const cert = auditService.generateCertificate(
      mockVault,
      mockDocuments,
      mockActivities
    );

    expect(cert.certificateId).toContain("SPV-AUDIT-101");
    expect(cert.vaultName).toBe("Vault Alpha");
    expect(cert.documents.length).toBe(1);
    expect(cert.sha256Digest).toBeDefined();
    expect(cert.sha256Digest.length).toBe(64); // SHA-256 hex string length
  });

  it("should verify certificate integrity successfully", () => {
    const cert = auditService.generateCertificate(
      mockVault,
      mockDocuments,
      mockActivities
    );
    const isValid = auditService.verifyCertificateIntegrity(cert);
    expect(isValid).toBe(true);
  });

  it("should detect tampered certificates", () => {
    const cert = auditService.generateCertificate(
      mockVault,
      mockDocuments,
      mockActivities
    );
    // Tamper with content
    cert.vaultName = "Tampered Vault Name";
    const isValid = auditService.verifyCertificateIntegrity(cert);
    expect(isValid).toBe(false);
  });
});
