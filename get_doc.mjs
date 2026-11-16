import * as S from '@stellar/stellar-sdk'; const rpc=S.rpc; const {Contract, nativeToScVal, Address} = S;
import fs from 'fs'; const d=JSON.parse(fs.readFileSync(process.env.HOME+'/.spoovault-testnet.json','utf8'));
const kp=S.Keypair.fromSecret(d.secret); const server=new rpc.Server("https://soroban-testnet.stellar.org");
const contractId="CCYKK34DEO2BJABJQ7DW5MZ6PYFC7MRJYTZL2QPKBFCXHR4P347EUFZL"; const contract=new Contract(contractId);
const acc=await server.getAccount(kp.publicKey());
const tx=new S.TransactionBuilder(acc,{fee:S.BASE_FEE, networkPassphrase:S.Networks.TESTNET}).addOperation(contract.call("get_document", nativeToScVal(1,{type:"u64"}))).setTimeout(120).build();
const sim=await server.simulateTransaction(tx); console.log(JSON.stringify(sim,null,2).slice(0,3000));
