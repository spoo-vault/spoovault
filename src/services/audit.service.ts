import CryptoJS from "crypto-js";
import { VaultData, DocumentData, ActivityEvent } from "./contract.service";

export interface AuditCertificate {
  certificateId: string;
  generatedAt: string;
  vaultId: number;
  vaultName: string;
  creator: string;
  guardians: string[];
  approvalThreshold: number;
  documentCount: number;
  documents: {
    id: number;
    ipfsHash: string;
    uploadedBy: string;
    uploadedAt: number;
  }[];
  activityLogs: {
    event: string;
    actor: string;
    timestamp: number;
    status: string;
  }[];
  sha256Digest: string;
}

class AuditService {
  /**
   * Generate a cryptographically verifiable JSON Audit Certificate for a vault
   */
  public generateCertificate(
    vault: VaultData,
    documents: DocumentData[] = [],
    activities: ActivityEvent[] = []
  ): AuditCertificate {
    const rawCertificateData = {
      certificateId: `SPV-AUDIT-${vault.id}-${Date.now()
        .toString(36)
        .toUpperCase()}`,
      generatedAt: new Date().toISOString(),
      vaultId: vault.id,
      vaultName: vault.name,
      creator: vault.creator,
      guardians: vault.guardians || [],
      approvalThreshold: vault.approvalThreshold,
      documentCount: documents.length,
      documents: documents.map((doc) => ({
        id: doc.id,
        ipfsHash: doc.ipfsHash,
        uploadedBy: doc.uploadedBy,
        uploadedAt: doc.uploadedAt,
      })),
      activityLogs: activities.map((act) => ({
        event: act.action,
        actor: act.actor,
        timestamp: act.timestamp,
        status: act.status,
      })),
    };

    // Calculate SHA-256 digest of the certificate content
    const sha256Digest = CryptoJS.SHA256(
      JSON.stringify(rawCertificateData)
    ).toString();

    return {
      ...rawCertificateData,
      sha256Digest,
    };
  }

  /**
   * Export certificate as a downloadable JSON file
   */
  public downloadCertificateJSON(cert: AuditCertificate) {
    const jsonString = JSON.stringify(cert, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `SpooVault_Audit_Certificate_Vault_${cert.vaultId}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Export activity logs as CSV
   */
  public downloadActivityCSV(vaultId: number, activities: ActivityEvent[]) {
    const headers = [
      "Action",
      "Actor",
      "Timestamp",
      "Formatted Date",
      "Status",
    ];
    const rows = activities.map((act) => [
      act.action,
      act.actor,
      act.timestamp,
      new Date(act.timestamp * 1000).toISOString(),
      act.status,
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((r) => r.join(",")),
    ].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `SpooVault_Activity_Log_Vault_${vaultId}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Verify certificate integrity using SHA-256 digest
   */
  public verifyCertificateIntegrity(cert: AuditCertificate): boolean {
    const { sha256Digest, ...rawContent } = cert;
    const computedDigest = CryptoJS.SHA256(
      JSON.stringify(rawContent)
    ).toString();
    return computedDigest === sha256Digest;
  }
}

export const auditService = new AuditService();
