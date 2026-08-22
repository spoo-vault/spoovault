import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FreighterShim } from '../services/stellar.service';

vi.mock('@stellar/stellar-sdk', () => {
  const mockAccount = { sequence: '0', accountId: 'GABC' };
  const mockServer = {
    getAccount: vi.fn().mockResolvedValue(mockAccount),
    simulateTransaction: vi.fn().mockResolvedValue({
      result: { retval: { _type: 'scvU32', u32: 42 } },
    }),
    sendTransaction: vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'txhash123' }),
    getTransaction: vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      returnValue: { _type: 'scvU32', u32: 42 },
    }),
  };
  return {
    Contract: vi.fn().mockImplementation(function () {
      return { call: vi.fn(() => 'mock-op') };
    }),
    Address: vi.fn().mockImplementation(function (addr: string) {
      return {
        toScVal: vi.fn(() => ({ _type: 'scvAddress' })),
        toString: () => addr,
      };
    }),
    Account: vi.fn().mockImplementation(function (accountId: string, sequence: string) {
      return { accountId, sequence };
    }),
    Operation: {
      invokeContractFunction: vi.fn(() => 'mock-invoke-op'),
    },
    StrKey: {
      isValidEd25519PublicKey: vi.fn((key: string) => typeof key === 'string' && key.startsWith('G') && key.length === 56),
    },
    xdr: {
      ScVal: {
        scvVoid: vi.fn(() => ({ _type: 'scvVoid' })),
      },
      SorobanAuthorizationEntry: {
        fromXDR: vi.fn(() => ({
          credentials: vi.fn(),
          rootInvocation: vi.fn(),
        })),
      },
    },
    nativeToScVal: vi.fn(() => ({ _type: 'scvMock' })),
    scValToNative: vi.fn(() => 'decoded-value'),
    Networks: { TESTNET: 'Test SDF Network ; September 2015' },
    TransactionBuilder: Object.assign(
      vi.fn().mockImplementation(function () {
        return {
          addOperation: vi.fn().mockReturnThis(),
          setTimeout: vi.fn().mockReturnThis(),
          build: vi.fn(() => ({ toXDR: () => 'mock-xdr' })),
        };
      }),
      { fromXDR: vi.fn(() => 'parsed-tx') },
    ),
    BASE_FEE: '100',
    rpc: {
      Server: vi.fn().mockImplementation(function () {
        return mockServer;
      }),
      Api: {
        isSimulationError: vi.fn(() => false),
        GetTransactionStatus: {
          NOT_FOUND: 'NOT_FOUND',
          SUCCESS: 'SUCCESS',
          FAILED: 'FAILED',
        },
      },
      assembleTransaction: vi.fn(() => ({
        build: () => ({ toXDR: () => 'assembled-xdr' }),
      })),
    },
  };
});

vi.mock('@stellar/freighter-api', () => ({
  isConnected: vi.fn().mockResolvedValue(true),
  getAddress: vi.fn().mockResolvedValue('GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB'),
  getPublicKey: vi.fn().mockResolvedValue('GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB'),
  signTransaction: vi.fn().mockResolvedValue('signed-xdr'),
}));

import { stellarService } from '../services/stellar.service';
import * as freighter from '@stellar/freighter-api';
import * as sdk from '@stellar/stellar-sdk';



class MockLocalStorage {
  private store: Record<string, string> = {};
  getItem(key: string): string | null { return this.store[key] || null; }
  setItem(key: string, value: string): void { this.store[key] = String(value); }
  removeItem(key: string): void { delete this.store[key]; }
  clear(): void { this.store = {}; }
}

const setupWallet = async (overrides?: Partial<FreighterShim>) => {
  const mock: FreighterShim = {
    isConnected: vi.fn().mockImplementation(() => (freighter.isConnected as any)()),
    getAddress: vi.fn().mockImplementation(() => ((freighter as any).getAddress ? (freighter as any).getAddress() : (freighter.getPublicKey as any)())),
    signTransaction: vi.fn().mockImplementation((xdr, opts) => (freighter.signTransaction as any)(xdr, opts)),
    getNetwork: vi.fn().mockResolvedValue('TESTNET'),
    ...overrides,
  };
  stellarService.setMockFreighter(mock);
  await stellarService.connectWallet();
  return mock;
};

beforeEach(() => {
  if (typeof globalThis.localStorage === 'undefined') {
    (globalThis as any).localStorage = new MockLocalStorage();
  }
  globalThis.localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  stellarService.clear();
  (freighter.isConnected as any).mockResolvedValue(true);
  if ((freighter as any).getAddress) {
    ((freighter as any).getAddress as any).mockResolvedValue('GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB');
  }
  (freighter.getPublicKey as any).mockResolvedValue('GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB');
  (freighter.signTransaction as any).mockResolvedValue('signed-xdr');
  setupWallet();

  vi.stubEnv('VITE_STELLAR_CONTRACT_ADDRESS', 'CCTESTCONTRACT1234567890ABCDEF');
});

// ---------------------------------------------------------------------------
// 1. invokeSorobanContract – direct helper tests
// ---------------------------------------------------------------------------
describe('invokeSorobanContract', () => {
  it('should throw when Freighter is not connected', async () => {
    (freighter.isConnected as any).mockResolvedValue(false);

    await expect(
      stellarService.invokeSorobanContract('create_vault', [])
    ).rejects.toThrow('Freighter not connected');
  });

  it('should return decoded value for readonly calls', async () => {
    const result = await stellarService.invokeSorobanContract('get_vault', [], { readonly: true });
    expect(result).toBe('decoded-value');
    expect(sdk.scValToNative).toHaveBeenCalled();
  });

  it('should complete a mutating transaction successfully', async () => {
    const result = await stellarService.invokeSorobanContract('create_vault', []);
    expect(result).toBe('decoded-value');
    expect(freighter.signTransaction).toHaveBeenCalled();
  });

  it('should normalize Freighter signing rejection into "Transaction was rejected by user."', async () => {
    (freighter.signTransaction as any).mockRejectedValueOnce(new Error('User declined'));

    await expect(
      stellarService.invokeSorobanContract('create_vault', [])
    ).rejects.toThrow('Transaction was rejected by user.');
  });

  it('should normalize "cancel" error into "Transaction was rejected by user."', async () => {
    (freighter.signTransaction as any).mockRejectedValueOnce(new Error('cancel'));

    await expect(
      stellarService.invokeSorobanContract('create_vault', [])
    ).rejects.toThrow('Transaction was rejected by user.');
  });
});

// ---------------------------------------------------------------------------
// 2. createVault
// ---------------------------------------------------------------------------
describe('stellarService - createVault', () => {
  it('should invoke the contract successfully', async () => {
    await setupWallet();
    const result = await stellarService.createVault('My Vault', 'Desc', ['GABC'], 1);
    expect(typeof result).toBe('number');
  });

  it('should throw when wallet not connected', async () => {
    stellarService.clear();
    await expect(
      stellarService.createVault('Test', 'Desc', [], 1)
    ).rejects.toThrow('Wallet not connected');
  });

  it('should throw when contract not configured', async () => {
    vi.stubEnv('VITE_STELLAR_CONTRACT_ADDRESS', '');
    await setupWallet();

    await expect(
      stellarService.createVault('Test', 'Desc', [], 1)
    ).rejects.toThrow('Stellar contract is not configured');
  });
});

// ---------------------------------------------------------------------------
// 3. addDocument
// ---------------------------------------------------------------------------
describe('stellarService - addDocument', () => {
  it('should invoke successfully', async () => {
    await setupWallet();
    const result = await stellarService.addDocument(1, 'encrypted-metadata', 'ipfs-hash', 0);
    expect(typeof result).toBe('number');
  });

  it('should throw when wallet not connected', async () => {
    stellarService.clear();
    await expect(
      stellarService.addDocument(1, 'enc', 'ipfs', 0)
    ).rejects.toThrow('Wallet not connected');
  });
});

// ---------------------------------------------------------------------------
// 4. requestAccess
// ---------------------------------------------------------------------------
describe('stellarService - requestAccess', () => {
  it('should invoke successfully', async () => {
    await setupWallet();
    const result = await stellarService.requestAccess(42);
    expect(typeof result).toBe('number');
  });

  it('should throw when wallet not connected', async () => {
    stellarService.clear();
    await expect(stellarService.requestAccess(1)).rejects.toThrow('Wallet not connected');
  });
});

// ---------------------------------------------------------------------------
// 5. approveAccess
// ---------------------------------------------------------------------------
describe('stellarService - approveAccess', () => {
  it('should invoke with encrypted share', async () => {
    await setupWallet();
    await stellarService.approveAccess(1, 'encrypted-share-data');
  });

  it('should invoke without encrypted share', async () => {
    await setupWallet();
    await stellarService.approveAccess(1);
  });

  it('should throw when wallet not connected', async () => {
    stellarService.clear();
    await expect(stellarService.approveAccess(1)).rejects.toThrow('Wallet not connected');
  });
});

// ---------------------------------------------------------------------------
// 6. acceptGuardianInvite
// ---------------------------------------------------------------------------
describe('stellarService - acceptGuardianInvite', () => {
  it('should invoke successfully', async () => {
    await setupWallet();
    await stellarService.acceptGuardianInvite(7);
  });

  it('should throw when wallet not connected', async () => {
    stellarService.clear();
    await expect(stellarService.acceptGuardianInvite(1)).rejects.toThrow('Wallet not connected');
  });
});

// ---------------------------------------------------------------------------
// 7. registerPublicKey
// ---------------------------------------------------------------------------
describe('stellarService - registerPublicKey', () => {
  it('should invoke successfully', async () => {
    await setupWallet();
    await stellarService.registerPublicKey('stellar-pub-key-123');
  });

  it('should throw when wallet not connected', async () => {
    stellarService.clear();
    await expect(stellarService.registerPublicKey('key')).rejects.toThrow('Wallet not connected');
  });
});

// ---------------------------------------------------------------------------
// 8. user declined errors – rejection normalization across all 6 functions
// ---------------------------------------------------------------------------
describe('stellarService - user declined errors', () => {
  const rejectSigner = () => {
    (freighter.signTransaction as any).mockRejectedValue(new Error('User declined'));
  };

  it('should normalize rejection in createVault', async () => {
    await setupWallet();
    rejectSigner();

    await expect(
      stellarService.createVault('Test', 'Desc', [], 1)
    ).rejects.toThrow('Transaction was rejected by user.');
  });

  it('should normalize rejection in addDocument', async () => {
    await setupWallet();
    rejectSigner();

    await expect(
      stellarService.addDocument(1, 'enc', 'ipfs', 0)
    ).rejects.toThrow('Transaction was rejected by user.');
  });

  it('should normalize rejection in requestAccess', async () => {
    await setupWallet();
    rejectSigner();

    await expect(
      stellarService.requestAccess(1)
    ).rejects.toThrow('Transaction was rejected by user.');
  });

  it('should normalize rejection in approveAccess', async () => {
    await setupWallet();
    rejectSigner();

    await expect(
      stellarService.approveAccess(1, 'share')
    ).rejects.toThrow('Transaction was rejected by user.');
  });

  it('should normalize rejection in acceptGuardianInvite', async () => {
    await setupWallet();
    rejectSigner();

    await expect(
      stellarService.acceptGuardianInvite(1)
    ).rejects.toThrow('Transaction was rejected by user.');
  });

  it('should normalize rejection in registerPublicKey', async () => {
    await setupWallet();
    rejectSigner();

    await expect(
      stellarService.registerPublicKey('key')
    ).rejects.toThrow('Transaction was rejected by user.');
  });

  it('should normalize "cancel" error in createVault', async () => {
    await setupWallet();
    (freighter.signTransaction as any).mockRejectedValue(new Error('cancel'));

    await expect(
      stellarService.createVault('Test', 'Desc', [], 1)
    ).rejects.toThrow('Transaction was rejected by user.');
  });
});

// ---------------------------------------------------------------------------
// 9. Cross-Chain Identity Resolution
// ---------------------------------------------------------------------------
describe('stellarService - Cross-Chain Identity Resolution', () => {
  it('should register and resolve EVM address to Stellar address and public key', async () => {
    const stellarAddress = 'GBZXN7PIRZGNMHGA72STUFTOAITGM522NM3TVYLZMJOXOALPUYSTZFEF';
    const evmAddress = '0x64128680775Ef626379DeF6E5c815AeA8F4707Ef';
    const pubKey = '0x04bfcab5516089d846985a12';

    await stellarService.registerCrossChainIdentity(
      stellarAddress,
      evmAddress,
      pubKey
    );

    const resolvedStellar = await stellarService.resolveEvmToStellar(
      evmAddress
    );
    expect(resolvedStellar).toBe(stellarAddress);

    const resolvedEvm = await stellarService.resolveStellarToEvm(
      stellarAddress
    );
    expect(resolvedEvm).toBe(evmAddress.toLowerCase());

    const resolvedPubKey = await stellarService.resolveEvmToPublicKey(
      evmAddress
    );
    expect(resolvedPubKey).toBe(pubKey);
  });

  it('should return null for unregistered addresses', async () => {
    const resolved = await stellarService.resolveEvmToStellar('0x0000000000000000000000000000000000000000');
    expect(resolved).toBeNull();
  });

  it('should resolve Stellar to EVM after registration', async () => {
    const stellar = 'GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB';
    const evm = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12';

    await stellarService.registerCrossChainIdentity(stellar, evm);

    const resolved = await stellarService.resolveStellarToEvm(stellar);
    expect(resolved).toBe(evm.toLowerCase());
  });

  it('should return null for unregistered Stellar to EVM', async () => {
    const resolved = await stellarService.resolveStellarToEvm('GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(resolved).toBeNull();
  });

  it('should resolve EVM to public key via Stellar fallback', async () => {
    const stellar = 'GBZXN7PIRZGNMHGA72STUFTOAITGM522NM3TVYLZMJOXOALPUYSTZFEF';
    const evm = '0x64128680775Ef626379DeF6E5c815AeA8F4707Ef';
    const pubKey = 'mypubkey123';

    await stellarService.registerCrossChainIdentity(stellar, evm, pubKey);
    const resolved = await stellarService.resolveEvmToPublicKey(evm);
    expect(resolved).toBe(pubKey);
  });
});

// ---------------------------------------------------------------------------
// 10. utility functions
// ---------------------------------------------------------------------------
describe('stellarService - utility functions', () => {
  it('getRpcUrl should return default when no env var set', () => {
    vi.stubEnv('VITE_STELLAR_RPC_URL', '');
    const url = stellarService.getRpcUrl();
    expect(url).toContain('soroban-testnet.stellar.org');
  });

  it('getRpcUrl should return env var when set', () => {
    vi.stubEnv('VITE_STELLAR_RPC_URL', 'https://custom-rpc.example.com');
    const url = stellarService.getRpcUrl();
    expect(url).toBe('https://custom-rpc.example.com');
  });

  it('getContractId should return the configured contract address', () => {
    const id = stellarService.getContractId();
    expect(id).toBe('CCTESTCONTRACT1234567890ABCDEF');
  });

  it('getContractId should return empty string when not configured', () => {
    vi.stubEnv('VITE_STELLAR_CONTRACT_ADDRESS', '');
    const id = stellarService.getContractId();
    expect(id).toBe('');
  });

  it('isConfigured should return true when contract address is set', () => {
    expect(stellarService.isConfigured()).toBe(true);
  });

  it('isConfigured should return false when contract address is empty', () => {
    vi.stubEnv('VITE_STELLAR_CONTRACT_ADDRESS', '');
    expect(stellarService.isConfigured()).toBe(false);
  });
});
