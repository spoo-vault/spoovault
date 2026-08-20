import { describe, it, expect } from 'vitest';
import {
  shortenAddress,
  encryptData,
  decryptData,
  formatFileSize,
  formatDate,
  isValidAddress,
  splitKeyAmongGuardians,
  reconstructKey,
  toVaultGID,
  parseVaultGID,
  getVaultGID,
} from '../utils/helpers';

describe('Helper Utilities', () => {
  describe('shortenAddress', () => {
    it('should format Ethereum address correctly', () => {
      const address = '0x64128680775Ef626379DeF6E5c815AeA8F4707Ef';
      expect(shortenAddress(address, 4)).toBe('0x6412...07Ef');
    });

    it('should return short string as is', () => {
      expect(shortenAddress('0x123')).toBe('0x123');
    });

    it('should handle empty or null values gracefully', () => {
      expect(shortenAddress('')).toBe('');
    });
  });

  describe('encryptData & decryptData', () => {
    it('should encrypt and decrypt plaintext using AES key', () => {
      const secretMessage = 'SpooVault-Enterprise-Document-Payload';
      const secretKey = 'super-secret-encryption-key-32b';
      
      const encrypted = encryptData(secretMessage, secretKey);
      expect(encrypted).not.toBe(secretMessage);

      const decrypted = decryptData(encrypted, secretKey);
      expect(decrypted).toBe(secretMessage);
    });
  });

  describe('formatFileSize & formatDate', () => {
    it('should format byte sizes into readable units', () => {
      expect(formatFileSize(0)).toBe('0 Bytes');
      expect(formatFileSize(1024)).toBe('1 KB');
      expect(formatFileSize(1048576)).toBe('1 MB');
      expect(formatFileSize(1073741824)).toBe('1 GB');
    });

    it('should format Unix timestamp into human readable date string', () => {
      const timestamp = 1700000000;
      const formatted = formatDate(timestamp);
      expect(formatted).toBeDefined();
      expect(typeof formatted).toBe('string');
    });
  });

  describe('isValidAddress', () => {
    it('should validate valid Ethereum hex addresses', () => {
      expect(isValidAddress('0x64128680775Ef626379DeF6E5c815AeA8F4707Ef')).toBe(true);
      expect(isValidAddress('0xInvalidAddressLength')).toBe(false);
      expect(isValidAddress('0x0000000000000000000000000000000000000000')).toBe(true);
    });
  });

  describe('splitKeyAmongGuardians & reconstructKey', () => {
    it('should divide key into guardian shares and reconstruct successfully', () => {
      const key = 'abcdef1234567890abcdef1234567890';
      const guardians = ['g1', 'g2', 'g3'];

      const parts = splitKeyAmongGuardians(key, guardians);
      expect(parts.length).toBe(3);

      const reconstructed = reconstructKey(parts);
      expect(reconstructed).toBe(key);
    });
  });

  describe('VaultGID multi-chain composite identifiers', () => {
    it('should format composite VaultGID properly', () => {
      expect(toVaultGID(43113, 1)).toBe('43113:1');
      expect(toVaultGID('stellar-testnet', 1)).toBe('stellar-testnet:1');
    });

    it('should parse composite VaultGID accurately', () => {
      const parsedEvm = parseVaultGID('43113:5');
      expect(parsedEvm).toEqual({ chainId: '43113', vaultId: 5 });

      const parsedStellar = parseVaultGID('stellar-testnet:12');
      expect(parsedStellar).toEqual({ chainId: 'stellar-testnet', vaultId: 12 });

      const fallback = parseVaultGID('42');
      expect(fallback).toEqual({ chainId: '43113', vaultId: 42 });
    });

    it('should generate standard VaultGID based on active ecosystem', () => {
      expect(getVaultGID('stellar', null, 1)).toBe('stellar-testnet:1');
      expect(getVaultGID('avalanche', 43113, 1)).toBe('43113:1');
      expect(getVaultGID('avalanche', null, 2)).toBe('43113:2');
    });
  });
});

