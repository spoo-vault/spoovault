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
const account = await server.getAccount(kp.publicKey());

const uploader = new Address(kp.publicKey()).toScVal();
const vault_id = nativeToScVal(1, {type:"u64"});
const encrypted_metadata = nativeToScVal("ARKHE-ZERO genesis - Toluca Lerma 2025 - e8d9eac8", {type:"string"});
const ipfs_hash = nativeToScVal("QmARKHEZEROgenesisTolucaLerma", {type:"string"});

let accessLevelScVal, releaseCondScVal;
try {
  accessLevelScVal = xdr.ScVal.fromXdr(nativeToScVal({tag:"Read", values:[]}).toXdr("base64"), "base64");
} catch {
  accessLevelScVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Read")]);
}
try {
  releaseCondScVal = xdr.ScVal.fromXdr(nativeToScVal({tag:"Anytime", values:[]}).toXdr("base64"), "base64");
} catch {
  releaseCondScVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Anytime")]);
}

const guardians_list = xdr.ScVal.scvVec([new Address(gdata.publicKey).toScVal()]);
const shares = xdr.ScVal.scvVec([xdr.ScVal.scvString("ENCRYPTED_SHARE_GENESIS_ARKHE_ZERO")]);

const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(contract.call("add_document", uploader, vault_id, encrypted_metadata, ipfs_hash, accessLevelScVal, releaseCondScVal, guardians_list, shares))
  .setTimeout(120).build();

const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) { 
  console.error("SIM ERROR:", JSON.stringify(sim,null,2)); 
  process.exit(1);
}

const assembled = rpc.assembleTransaction(tx, sim).build();
assembled.sign(kp);
const res = await server.sendTransaction(assembled);
console.log("TX:", res.hash);
let r = await server.getTransaction(res.hash);
let c=0; while(r.status==="NOT_FOUND" && c<20){ await new Promise(x=>setTimeout(x,2000)); r=await server.getTransaction(res.hash); c++; console.log("...waiting", c); }
console.log("STATUS:", r.status);
console.log("RETURN:", r.returnValue, r.resultMetaXdr ? "has meta" : "");
if(r.returnValue) console.log("Doc ID:", r.returnValue);
console.log(JSON.stringify(r,null,2).slice(0,2000));
