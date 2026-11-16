import * as Sdk from '@stellar/stellar-sdk';
const server = new Sdk.rpc.Server("https://mainnet.soroban-rpc.stellar.org");
const G = "GCVOYQPKLLWM7AYVGF3WX6R4WJJL6YB3JLPSM6SLFUBKIEJLCVTX2627";
try {
  const acc = await server.getAccount(G);
  console.log("✅ EXISTE EN MAINNET");
  console.log("G:", G);
  console.log("Balance:", acc.balances[0].balance, "XLM");
} catch(e){
  console.log("❌ NO EXISTE EN MAINNET AÚN");
  console.log("G:", G);
  console.log("Acción: Manda 2 XLM a esa G desde Bitso/Binance/StellarTerm");
}
