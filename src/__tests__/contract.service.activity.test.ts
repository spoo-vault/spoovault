import { describe, it, expect } from 'vitest';
import { ActivityEvent } from '../services/contract.service';
import { auditService } from '../services/audit.service';
import { VaultData, DocumentData } from '../services/contract.service';
import { getExplorerTxUrl } from '../utils/explorer';

describe('ActivityEvent with multi-chain explorer fields', () => {
  const mockTxHash = '0xabc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890';

  const avalancheActivity: ActivityEvent = {
    action: 'Vault Created',
    actor: '0x1111111111111111111111111111111111111111',
    timestamp: 1700000000,
    status: 'success',
    txHash: mockTxHash,
    network: 'avalanche',
  };

  const stellarActivity: ActivityEvent = {
    action: 'Document Added',
    actor: '0x2222222222222222222222222222222222222222',
    timestamp: 1700000100,
    status: 'success',
    txHash: mockTxHash,
    network: 'stellar',
  };

  const legacyActivity: ActivityEvent = {
    action: 'Access Requested',
    actor: '0x3333333333333333333333333333333333333333',
    timestamp: 1700000200,
    status: 'pending',
  };

  it('should include txHash and network fields on Avalanche activity', () => {
    expect(avalancheActivity.txHash).toBe(mockTxHash);
    expect(avalancheActivity.network).toBe('avalanche');
  });

  it('should include txHash and network fields on Stellar activity', () => {
    expect(stellarActivity.txHash).toBe(mockTxHash);
    expect(stellarActivity.network).toBe('stellar');
  });

  it('should allow ActivityEvent without txHash/network for backward compatibility', () => {
    expect(legacyActivity.txHash).toBeUndefined();
    expect(legacyActivity.network).toBeUndefined();
  });

  it('should generate correct Avalanche explorer URL from activity data', () => {
    const url = getExplorerTxUrl(avalancheActivity.txHash!, avalancheActivity.network);
    expect(url).toBe(`https://testnet.snowtrace.io/tx/${mockTxHash}`);
  });

  it('should generate correct Stellar explorer URL from activity data', () => {
    const url = getExplorerTxUrl(stellarActivity.txHash!, stellarActivity.network);
    expect(url).toBe(`https://testnet.bex.stellar.org/tx/${mockTxHash}`);
  });

  it('should generate Avalanche URL when network defaults for legacy activities', () => {
    const url = getExplorerTxUrl(mockTxHash, legacyActivity.network);
    expect(url).toBe(`https://testnet.snowtrace.io/tx/${mockTxHash}`);
  });

  it('should remain compatible with audit service certificate generation', () => {
    const mockVault: VaultData = {
      id: 1,
      creator: '0x1111111111111111111111111111111111111111',
      name: 'Test Vault',
      description: 'Test',
      guardians: [],
      approvalThreshold: 1,
      isActive: true,
      createdAt: 1700000000,
    };

    const mockDocuments: DocumentData[] = [];

    const activities: ActivityEvent[] = [avalancheActivity, stellarActivity, legacyActivity];

    const cert = auditService.generateCertificate(mockVault, mockDocuments, activities);
    expect(cert.activityLogs.length).toBe(3);
    expect(cert.activityLogs[0].event).toBe('Vault Created');
    expect(cert.activityLogs[1].event).toBe('Document Added');
    expect(cert.activityLogs[2].event).toBe('Access Requested');

    const isValid = auditService.verifyCertificateIntegrity(cert);
    expect(isValid).toBe(true);
  });
});
