import * as StellarSdk from '@stellar/stellar-sdk';
const { Contract, nativeToScVal, Address, xdr } = StellarSdk;
const rpc = StellarSdk.rpc;

import { STELLAR_CONFIG } from './config';

const server = new rpc.Server(STELLAR_CONFIG.rpc);
const contract = new Contract(STELLAR_CONFIG.contractId);

// helper para simular call read-only
async function simulateGet(fn: string, ...args: any[]) {
  const dummy = StellarSdk.Keypair.random();
  const acc = await server.getAccount(dummy.publicKey());
  const tx = new StellarSdk.TransactionBuilder(acc, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET,
  }).addOperation(contract.call(fn, ...args)).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationSuccess(sim) && sim.result) return sim.result.retval;
  throw new Error("Sim failed "+JSON.stringify(sim));
}

export async function getVault(vaultId: number) {
  return simulateGet("get_vault", nativeToScVal(vaultId, {type:"u64"}));
}
export async function getDocument(docId: number) {
  return simulateGet("get_document", nativeToScVal(docId, {type:"u64"}));
}

export const arkheLive = {
  contractId: STELLAR_CONFIG.contractId,
  vaultId: STELLAR_CONFIG.activeVaultId,
  docId: STELLAR_CONFIG.activeDocId,
  explorerTx: (hash:string)=> `https://stellar.expert/explorer/testnet/tx/${hash}`,
  explorerContract: STELLAR_CONFIG.explorer
}
