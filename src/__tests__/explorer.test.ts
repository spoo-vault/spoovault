import { describe, it, expect } from 'vitest';
import {
  getExplorerBaseUrl,
  getExplorerTxUrl,
  getExplorerTokenUrl,
} from '../utils/explorer';

describe('Explorer URL Utilities', () => {
  describe('getExplorerBaseUrl', () => {
    it('should return Snowtrace testnet URL for Avalanche', () => {
      expect(getExplorerBaseUrl('avalanche')).toBe('https://testnet.snowtrace.io');
    });

    it('should return Stellar BEX testnet URL for Stellar', () => {
      expect(getExplorerBaseUrl('stellar')).toBe('https://testnet.bex.stellar.org');
    });

    it('should default to Avalanche when no network is provided', () => {
      expect(getExplorerBaseUrl()).toBe('https://testnet.snowtrace.io');
    });
  });

  describe('getExplorerTxUrl', () => {
    const mockTxHash = '0xabc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890';

    it('should build Avalanche Snowtrace transaction URL', () => {
      const url = getExplorerTxUrl(mockTxHash, 'avalanche');
      expect(url).toBe(`https://testnet.snowtrace.io/tx/${mockTxHash}`);
    });

    it('should build Stellar BEX transaction URL', () => {
      const url = getExplorerTxUrl(mockTxHash, 'stellar');
      expect(url).toBe(`https://testnet.bex.stellar.org/tx/${mockTxHash}`);
    });

    it('should default to Avalanche when network is omitted', () => {
      const url = getExplorerTxUrl(mockTxHash);
      expect(url).toBe(`https://testnet.snowtrace.io/tx/${mockTxHash}`);
    });

    it('should handle Stellar hash format', () => {
      const stellarHash = 'a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890';
      const url = getExplorerTxUrl(stellarHash, 'stellar');
      expect(url).toBe(`https://testnet.bex.stellar.org/tx/${stellarHash}`);
    });
  });

  describe('getExplorerTokenUrl', () => {
    const contractAddress = '0x1234567890abcdef1234567890abcdef12345678';

    it('should build Avalanche Snowtrace token URL', () => {
      const url = getExplorerTokenUrl(42, contractAddress, 'avalanche');
      expect(url).toBe(`https://testnet.snowtrace.io/token/${contractAddress}?a=42`);
    });

    it('should build Stellar BEX token URL', () => {
      const url = getExplorerTokenUrl(7, contractAddress, 'stellar');
      expect(url).toBe(`https://testnet.bex.stellar.org/token/${contractAddress}?a=7`);
    });

    it('should default to Avalanche when network is omitted', () => {
      const url = getExplorerTokenUrl(1, contractAddress);
      expect(url).toBe(`https://testnet.snowtrace.io/token/${contractAddress}?a=1`);
    });
  });
});
