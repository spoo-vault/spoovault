#!/data/data/com.termux/files/usr/bin/bash
read -p "Pega tu S... (56 chars, empieza con S): " SKEY
cat > mainnet-deploy.js <<JS
import * as StellarSdk from '@stellar/stellar-sdk';
const SECRET = "$SKEY";
async function run(){
  try{
    const kp = StellarSdk.Keypair.fromSecret(SECRET);
    console.log("✅ G...:", kp.publicKey());
    const server = new StellarSdk.rpc.Server("https://mainnet.soroban-rpc.stellar.org");
    const acc = await server.getAccount(kp.publicKey());
    console.log("Balance:", acc.balances[0]?.balance, "XLM");
  }catch(e){
    console.log("Error:", e.message);
    console.log("Intentando RPC alterno...");
    try{
      const server2 = new StellarSdk.SorobanRpc.Server("https://mainnet.soroban-rpc.stellar.org");
      const kp2 = StellarSdk.Keypair.fromSecret(SECRET);
      const acc2 = await server2.getAccount(kp2.publicKey());
      console.log("Balance:", acc2.balances[0]?.balance);
    }catch(e2){ console.log("Error2:", e2.message); }
  }
}
run();
JS
echo "listo"
