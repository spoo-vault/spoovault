export function ArkheDocCard(){
  return (
    <div className="rounded-xl border border-violet-700/30 p-4 bg-gray-900/60">
      <p className="font-bold text-violet-200">ARKHE-ZERO Genesis Doc</p>
      <p className="text-xs text-gray-400 mt-1">Vault 2 / Doc 1 — Toluca Lerma</p>
      <p className="text-xs font-mono mt-2">IPFS: QmARKHEZEROTolucaV2</p>
      <p className="text-xs font-mono">TX: 45472f793a1a2bb08d490b2d9e04e0e9433cac1ea64ce87e17fb7a4ce1b128af</p>
      <div className="flex gap-2 mt-3">
        <a className="text-xs underline text-brand-400" target="_blank" href="https://stellar.expert/explorer/testnet/contract/CCYKK34DEO2BJABJQ7DW5MZ6PYFC7MRJYTZL2QPKBFCXHR4P347EUFZL">Contract</a>
        <a className="text-xs underline text-brand-400" target="_blank" href="https://ipfs.io/ipfs/QmARKHEZEROTolucaV2">IPFS Gateway</a>
      </div>
    </div>
  )
}
