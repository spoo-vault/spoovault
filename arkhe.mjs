import * as StellarSdk from '@stellar/stellar-sdk';
const { Keypair, Contract, TransactionBuilder, Networks, BASE_FEE, nativeToScVal, Address } = StellarSdk;
const rpc = StellarSdk.rpc;
import fs from 'fs';
const data = JSON.parse(fs.readFileSync(process.env.HOME+'/.spoovault-testnet.json','utf8'));
const kp = Keypair.fromSecret(data.secret);
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const contractId = "CCYKK34DEO2BJABJQ7DW5MZ6PYFC7MRJYTZL2QPKBFCXHR4P347EUFZL";
const contract = new Contract(contractId);
const account = await server.getAccount(kp.publicKey());
console.log("Owner:", kp.publicKey());

// Generar guardian externo para ARKHE-ZERO (se guarda local)
let guardianPath = process.env.HOME+'/.arkhe-guardian.json';
let guardianPub;
try {
  const gdata = JSON.parse(fs.readFileSync(guardianPath,'utf8'));
  guardianPub = gdata.publicKey;
} catch {
  const gkp = Keypair.random();
  fs.writeFileSync(guardianPath, JSON.stringify({publicKey:gkp.publicKey(), secret:gkp.secret()}, null,2));
  guardianPub = gkp.publicKey();
}
console.log("Guardian externo:", guardianPub);

const creatorAddr = new Address(kp.publicKey()).toScVal();
const guardianAddr = new Address(guardianPub).toScVal();
const name = nativeToScVal("ARKHE-ZERO-TOLUCA", {type:"string"});
const desc = nativeToScVal("Vault genesis Toluca Lerma - e8d9eac8", {type:"string"});
const guardians = nativeToScVal([guardianAddr], {type:"vec"}); // al menos 1 externo
const threshold = nativeToScVal(1, {type:"u32"}); // 1 de 2 (tu + guardian)

const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(contract.call("create_vault", creatorAddr, name, desc, guardians, threshold))
  .setTimeout(120).build();

const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) { console.error("SIM ERROR:", JSON.stringify(sim,null,2)); process.exit(1); }
const assembled = rpc.assembleTransaction(tx, sim).build();
assembled.sign(kp);
const res = await server.sendTransaction(assembled);
console.log("TX:", res.hash);
let r = await server.getTransaction(res.hash);
let c=0; while(r.status==="NOT_FOUND" && c<15){ await new Promise(x=>setTimeout(x,2000)); r=await server.getTransaction(res.hash); c++; console.log("...waiting", c); }
console.log("STATUS:", r.status);
console.log("Full:", JSON.stringify(r,null,2));
