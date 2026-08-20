import { describe, it, expect } from 'vitest';
import { stellarService } from '../services/stellar.service';

describe('stellarService - Cross-Chain Identity Resolution', () => {
  it('should register and resolve EVM address to Stellar address and public key', async () => {
    const stellarAddress = 'GBZXN7PIRZGNMHGA72STUFTOAITGM522NM3TVYLZMJOXOALPUYSTZFEF';
    const evmAddress = '0x64128680775Ef626379DeF6E5c815AeA8F4707Ef';
    const pubKey = '0x04bfcab5516089d846985a12';

    await stellarService.registerCrossChainIdentity(stellarAddress, evmAddress, pubKey);

    const resolvedStellar = await stellarService.resolveEvmToStellar(evmAddress);
    expect(resolvedStellar).toBe(stellarAddress);

    const resolvedEvm = await stellarService.resolveStellarToEvm(stellarAddress);
    expect(resolvedEvm).toBe(evmAddress.toLowerCase());

    const resolvedPubKey = await stellarService.resolveEvmToPublicKey(evmAddress);
    expect(resolvedPubKey).toBe(pubKey);
  });

  it('should fallback to resolving Stellar public key if direct EVM pubkey not registered', async () => {
    const stellarAddress = 'GDJNX7PIRZGNMHGA72STUFTOAITGM522NM3TVYLZMJOXOALPUYSTZFEF';
    const evmAddress = '0x1234567890123456789012345678901234567890';
    const pubKey = 'STELLAR_DIRECT_PUBLIC_KEY';

    // Register with stellar public key first
    await stellarService.registerCrossChainIdentity(stellarAddress, '0x8888888888888888888888888888888888888888', pubKey);

    // Register cross-chain identity without separate pubkey
    await stellarService.registerCrossChainIdentity(stellarAddress, evmAddress);

    const resolvedPubKey = await stellarService.resolveEvmToPublicKey(evmAddress);
    expect(resolvedPubKey).toBe(pubKey);
  });

  it('should return null for unregistered EVM or Stellar addresses', async () => {
    const resolvedStellar = await stellarService.resolveEvmToStellar('0x0000000000000000000000000000000000000000');
    expect(resolvedStellar).toBeNull();

    const resolvedEvm = await stellarService.resolveStellarToEvm('GNOTREGISTEREDADDRESSZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(resolvedEvm).toBeNull();

    const resolvedPubKey = await stellarService.resolveEvmToPublicKey('0x9999999999999999999999999999999999999999');
    expect(resolvedPubKey).toBeNull();
  });
});
