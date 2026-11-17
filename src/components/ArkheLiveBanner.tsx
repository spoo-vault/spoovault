import { STELLAR_CONFIG } from "../services/stellar/config"
import { Card } from "@heroui/react"

export function ArkheLiveBanner(){
  return (
    <Card className="p-4 bg-gradient-to-r from-violet-900/30 to-indigo-900/30 border-violet-700/30 mb-6">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-bold text-violet-200">ARKHE-ZERO LIVE ON TESTNET</p>
        <p className="text-xs text-gray-300 font-mono">Contract: {STELLAR_CONFIG.contractId}</p>
        <p className="text-xs text-gray-300">Vault {STELLAR_CONFIG.activeVaultId} / Doc {STELLAR_CONFIG.activeDocId} — Genesis Toluca Lerma e8d9eac8</p>
        <div className="flex gap-2 mt-2">
          <a href={STELLAR_CONFIG.explorer} target="_blank" className="text-xs underline text-brand-400">View Contract</a>
          <a href={`https://stellar.expert/explorer/testnet/tx/45472f793a1a2bb08d490b2d9e04e0e9433cac1ea64ce87e17fb7a4ce1b128af`} target="_blank" className="text-xs underline text-brand-400">View Doc TX</a>
        </div>
      </div>
    </Card>
  )
}
