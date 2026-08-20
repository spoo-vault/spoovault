import { describe, it, expect, beforeEach, vi } from 'vitest';
import { contractService } from '../services/contract.service';
import { stellarService } from '../services/stellar.service';

// In-memory localStorage shim for Vitest Node environment
class MockLocalStorage {
  private store: Record<string, string> = {};

  getItem(key: string): string | null {
    return this.store[key] || null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  clear(): void {
    this.store = {};
  }
}

if (typeof globalThis.localStorage === 'undefined') {
  (globalThis as any).localStorage = new MockLocalStorage();
}
if (typeof globalThis.window === 'undefined') {
  (globalThis as any).window = {
    localStorage: (globalThis as any).localStorage,
  };
}

describe('AccessCenter Network-Aware Token Validation', () => {
  const userAccount = 'GBCDF123456789STEL';
  const evmAccount = '0x64128680775Ef626379DeF6E5c815AeA8F4707Ef';

  beforeEach(() => {
    localStorage.clear();
    stellarService.clear();
    contractService.clear();
  });

  describe('Stellar Soroban Token Pass Ownership Check', () => {
    it('should verify token pass ownership for Stellar vaults via Soroban storage', async () => {
      const vaultId = 101;

      // Mint a Stellar access token to userAccount
      await stellarService.mintAccessToken(vaultId, userAccount, 'ipfs://QmStellarMetadata101');

      // Query token ownership specifically on Stellar network
      const hasToken = await contractService.hasVaultToken(userAccount, vaultId, 'stellar');
      expect(hasToken).toBe(true);
    });

    it('should reject access request when user does NOT hold token pass on Stellar', async () => {
      const vaultId = 102;
      const otherUser = 'GOTHERUSER99999';

      await stellarService.mintAccessToken(vaultId, otherUser, 'ipfs://QmStellarMetadata102');

      const hasToken = await contractService.hasVaultToken(userAccount, vaultId, 'stellar');
      expect(hasToken).toBe(false);
    });
  });

  describe('EVM Vault Token Pass Ownership Check', () => {
    it('should query EVM ERC-721 token pass ownership when network is avalanche', async () => {
      const vaultId = 201;

      // Mock stellarService.hasVaultToken to ensure it is NOT called when checking EVM
      const stellarSpy = vi.spyOn(stellarService, 'hasVaultToken');

      const hasToken = await contractService.hasVaultToken(evmAccount, vaultId, 'avalanche');
      
      // Should not route to Stellar
      expect(stellarSpy).not.toHaveBeenCalled();
      // Since contract is uninitialized/unminted, should return false safely
      expect(hasToken).toBe(false);

      stellarSpy.mockRestore();
    });
  });

  describe('Non-Owner Access Rejection', () => {
    it('should return false for accounts that do not hold any access token', async () => {
      const vaultId = 301;
      const nonOwner = '0x0000000000000000000000000000000000009999';

      const stellarHasToken = await contractService.hasVaultToken(nonOwner, vaultId, 'stellar');
      const evmHasToken = await contractService.hasVaultToken(nonOwner, vaultId, 'avalanche');

      expect(stellarHasToken).toBe(false);
      expect(evmHasToken).toBe(false);
    });
  });

  describe('Ownership Query Failure & Edge Case Handling', () => {
    it('should return false and not grant access when account or vaultId are invalid', async () => {
      expect(await contractService.hasVaultToken('', 101, 'stellar')).toBe(false);
      expect(await contractService.hasVaultToken(userAccount, 0, 'stellar')).toBe(false);
      expect(await contractService.hasVaultToken(userAccount, -1, 'stellar')).toBe(false);
    });

    it('should produce a clear false failure state when Soroban token query throws error', async () => {
      const vaultId = 401;
      vi.spyOn(stellarService, 'hasVaultToken').mockRejectedValueOnce(new Error('RPC Connection Failure'));

      const hasToken = await contractService.hasVaultToken(userAccount, vaultId, 'stellar');
      expect(hasToken).toBe(false);
    });
  });

  describe('Matching Host Network Selection', () => {
    it('should route token pass query to the matching host network specified by parameter', async () => {
      const vaultId = 501;

      const stellarSpy = vi.spyOn(stellarService, 'hasVaultToken').mockResolvedValue(true);

      const resultStellar = await contractService.hasVaultToken(userAccount, vaultId, 'stellar');
      expect(stellarSpy).toHaveBeenCalledWith(userAccount, vaultId);
      expect(resultStellar).toBe(true);

      stellarSpy.mockRestore();
    });
  });
});
