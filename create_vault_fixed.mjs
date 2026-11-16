import * as StellarSdk from '@stellar/stellar-sdk';
const { Keypair, Contract, TransactionBuilder, Networks, BASE_FEE, nativeToScVal, Address } = StellarSdk;
const rpc = StellarSdk.rpc;
import fs from 'fs';
const data = JSON.parse(fs.readFileSync(process.env.HOME+'/.spoovault-testnet.json','utf8'));
const kp = Keypair.fromSecret(data.secret);
const gdata = JSON.parse(fs.readFileSync(process.env.HOME+'/.arkhe-guardian.json','utf8'));
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const contractId = "CCYKK34DEO2BJABJQ7DW5MZ6PYFC7MRJYTZL2QPKBFCXHR4P347EUFZL";
const contract = new Contract(contractId);
const account = await server.getAccount(kp.publicKey());

// Ahora guardians = [creator, external]
const guardians = [new Address(kp.publicKey()).toScVal(), new Address(gdata.publicKey).toScVal()];

const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(contract.call("create_vault",
    new Address(kp.publicKey()).toScVal(),
    nativeToScVal("ARKHE-ZERO-TOLUCA", {type:"string"}),
    nativeToScVal("Vault genesis Toluca Lerma - FIX e8d9eac8", {type:"string"}),
    nativeToScVal(guardians),
    nativeToScVal(1, {type:"u32"})
  )).setTimeout(120).build();

const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) { console.error(JSON.stringify(sim,null,2)); process.exit(1); }
const assembled = rpc.assembleTransaction(tx, sim).build();
assembled.sign(kp);
const res = await server.sendTransaction(assembled);
console.log("TX", res.hash);
let r = await server.getTransaction(res.hash);
let c=0; while(r.status==="NOT_FOUND" && c<15){ await new Promise(x=>setTimeout(x,2000)); r=await server.getTransaction(res.hash); c++; console.log("waiting",c); }
console.log(JSON.stringify(r,null,2).slice(0,3000));
