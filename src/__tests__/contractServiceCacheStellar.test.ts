import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/stellar.service', () => ({
  stellarService: {
    initialize: vi.fn(),
    clear: vi.fn(),
    getAccount: vi.fn(),
    connectWallet: vi.fn(),
    createVault: vi.fn(),
    getVault: vi.fn(),
    fetchVaultsForAccount: vi.fn(),
    addDocument: vi.fn(),
    fetchDocumentsForVaults: vi.fn(),
    requestAccess: vi.fn(),
    approveAccess: vi.fn(),
    fetchPendingApprovalsForGuardian: vi.fn(),
    getEncryptedGuardianShare: vi.fn(),
    getBeneficiaryKeyShare: vi.fn(),
    getPendingInvites: vi.fn(),
    acceptGuardianInvite: vi.fn(),
    registerPublicKey: vi.fn(),
    getUserPublicKey: vi.fn(),
    isConfigured: vi.fn(),
  },
}));

import { stellarService } from '../services/stellar.service';
import { contractService } from '../services/contract.service';

const ACCOUNT = '0x4444444444444444444444444444444444444444';
const OTHER = '0x5555555555555555555555555555555555555555';
const DOC_ID = 101;
const VAULT_ID = 55;

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

// getEcosystem() and the inline Stellar hasActiveAccess check both read a real
// `window`/`localStorage` global (see contract.service.ts). Rather than pull in
// jsdom for two branches, a minimal in-memory polyfill is enough since nothing
// here needs a DOM, only `window.localStorage` and bare `localStorage`.
beforeEach(() => {
  const storage = new MemoryStorage();
  storage.setItem('spoovault-ecosystem', 'stellar');
  (globalThis as any).localStorage = storage;
  (globalThis as any).window = { localStorage: storage };

  vi.clearAllMocks();
  vi.mocked(stellarService.getAccount).mockReturnValue(ACCOUNT);
  vi.mocked(stellarService.fetchVaultsForAccount).mockResolvedValue([
    {
      id: VAULT_ID,
      creator: OTHER,
      name: 'Vault',
      description: '',
      guardians: [],
      approvalThreshold: 1,
      isActive: true,
      createdAt: 0,
    },
  ]);
  vi.mocked(stellarService.fetchDocumentsForVaults).mockResolvedValue([
    {
      id: DOC_ID,
      vaultId: VAULT_ID,
      encryptedMetadata: '',
      ipfsHash: '',
      uploadedBy: OTHER,
      uploadedAt: 0,
      requiredAccess: 0,
    },
  ]);
});

afterEach(() => {
  contractService.clear();
  delete (globalThis as any).window;
  delete (globalThis as any).localStorage;
});

describe('Stellar-ecosystem access cache', () => {
  it('caches the composed hasActiveAccess result within the TTL window', async () => {
    await contractService.hasActiveAccess(DOC_ID, ACCOUNT);
    await contractService.hasActiveAccess(DOC_ID, ACCOUNT);

    expect(stellarService.fetchVaultsForAccount).toHaveBeenCalledTimes(1);
  });

  it('approveAccess (Stellar) invalidates the access cache since approval can grant access', async () => {
    await contractService.hasActiveAccess(DOC_ID, ACCOUNT);
    expect(stellarService.fetchVaultsForAccount).toHaveBeenCalledTimes(1);

    vi.mocked(stellarService.approveAccess).mockResolvedValue(undefined);
    await contractService.approveAccess(1);

    await contractService.hasActiveAccess(DOC_ID, ACCOUNT);
    expect(stellarService.fetchVaultsForAccount).toHaveBeenCalledTimes(2);
  });

  it('acceptGuardianInvite (Stellar) invalidates the access cache since Stellar guardians get implicit document access', async () => {
    await contractService.hasActiveAccess(DOC_ID, ACCOUNT);
    expect(stellarService.fetchVaultsForAccount).toHaveBeenCalledTimes(1);

    vi.mocked(stellarService.acceptGuardianInvite).mockResolvedValue(undefined);
    await contractService.acceptGuardianInvite(VAULT_ID);

    await contractService.hasActiveAccess(DOC_ID, ACCOUNT);
    expect(stellarService.fetchVaultsForAccount).toHaveBeenCalledTimes(2);
  });

  it('returns false when no document matches the given documentId', async () => {
    vi.mocked(stellarService.fetchDocumentsForVaults).mockResolvedValue([]);

    const result = await contractService.hasActiveAccess(9001, ACCOUNT);

    expect(result).toBe(false);
  });

  it('returns true when the account is the document uploader', async () => {
    vi.mocked(stellarService.fetchDocumentsForVaults).mockResolvedValue([
      {
        id: 9002,
        vaultId: VAULT_ID,
        encryptedMetadata: '',
        ipfsHash: '',
        uploadedBy: ACCOUNT,
        uploadedAt: 0,
        requiredAccess: 0,
      },
    ]);

    const result = await contractService.hasActiveAccess(9002, ACCOUNT);

    expect(result).toBe(true);
  });

  it('returns true when the account is a guardian of the document\'s vault', async () => {
    vi.mocked(stellarService.fetchVaultsForAccount).mockResolvedValue([
      {
        id: VAULT_ID,
        creator: OTHER,
        name: 'Vault',
        description: '',
        guardians: [ACCOUNT],
        approvalThreshold: 1,
        isActive: true,
        createdAt: 0,
      },
    ]);
    vi.mocked(stellarService.fetchDocumentsForVaults).mockResolvedValue([
      {
        id: 9003,
        vaultId: VAULT_ID,
        encryptedMetadata: '',
        ipfsHash: '',
        uploadedBy: OTHER,
        uploadedAt: 0,
        requiredAccess: 0,
      },
    ]);

    const result = await contractService.hasActiveAccess(9003, ACCOUNT);

    expect(result).toBe(true);
  });

  it('returns true when a locally-stored mock request shows an approved (status 1) request for the account', async () => {
    vi.mocked(stellarService.fetchDocumentsForVaults).mockResolvedValue([
      {
        id: 9004,
        vaultId: VAULT_ID,
        encryptedMetadata: '',
        ipfsHash: '',
        uploadedBy: OTHER,
        uploadedAt: 0,
        requiredAccess: 0,
      },
    ]);
    (globalThis as any).localStorage.setItem(
      'spoovault-stellar-mock-requests',
      JSON.stringify([{ documentId: 9004, requester: ACCOUNT, status: 1 }])
    );

    const result = await contractService.hasActiveAccess(9004, ACCOUNT);

    expect(result).toBe(true);
  });
});
