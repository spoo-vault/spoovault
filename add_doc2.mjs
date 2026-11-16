import * as StellarSdk from '@stellar/stellar-sdk';
const { Keypair, Contract, TransactionBuilder, Networks, BASE_FEE, nativeToScVal, Address, xdr } = StellarSdk;
const rpc = StellarSdk.rpc;
import fs from 'fs';

const data = JSON.parse(fs.readFileSync(process.env.HOME+'/.spoovault-testnet.json','utf8'));
const kp = Keypair.fromSecret(data.secret);
const gdata = JSON.parse(fs.readFileSync(process.env.HOME+'/.arkhe-guardian.json','utf8'));
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const contractId = "CCYKK34DEO2BJABJQ7DW5MZ6PYFC7MRJYTZL2QPKBFCXHR4P347EUFZL";
const contract = new Contract(contractId);

const vaultId = 2; // usa el vault fix que acabas de crear
console.log("Using Vault", vaultId);

const account = await server.getAccount(kp.publicKey());

// Corrección: para enums AccessLevel / ReleaseCondition en Soroban, pásalos como U32 directamente
// Read=0, Anytime=0
const uploader = new Address(kp.publicKey()).toScVal();
const vault_id = nativeToScVal(vaultId, {type:"u64"});
const encrypted_metadata = nativeToScVal("ARKHE-ZERO genesis - Toluca Lerma - Vault2 - e8d9eac8", {type:"string"});
const ipfs_hash = nativeToScVal("QmARKHEZEROTolucaV2", {type:"string"});
const required_access = xdr.ScVal.scvU32(0); // Read
const release_condition = xdr.ScVal.scvU32(0); // Anytime

// guardians_list y shares deben coincidir: ponemos ambos guardians del vault
const guardians_list = xdr.ScVal.scvVec([
  new Address(kp.publicKey()).toScVal(),
  new Address(gdata.publicKey).toScVal()
]);
const shares = xdr.ScVal.scvVec([
  xdr.ScVal.scvString("share_creator_encrypted_ARKHE"),
  xdr.ScVal.scvString("share_guardian_encrypted_ARKHE")
]);

const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(contract.call("add_document", uploader, vault_id, encrypted_metadata, ipfs_hash, required_access, release_condition, guardians_list, shares))
  .setTimeout(120).build();

const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) {
  console.error("SIM ERROR:", JSON.stringify(sim,null,2));
  process.exit(1);
}
const assembled = rpc.assembleTransaction(tx, sim).build();
assembled.sign(kp);
const res = await server.sendTransaction(assembled);
console.log("TX", res.hash);
let r = await server.getTransaction(res.hash);
let c=0; while(r.status==="NOT_FOUND" && c<20){ await new Promise(x=>setTimeout(x,2000)); r=await server.getTransaction(res.hash); c++; console.log("waiting",c); }
console.log("STATUS", r.status);
console.log(JSON.stringify(r,null,2).slice(0,4000));
if(r.returnValue) console.log("DOC ID RETURN:", r.returnValue);
