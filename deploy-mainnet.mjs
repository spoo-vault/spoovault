import { execSync } from 'fs';
console.log("Usando JS SDK, no CLI");

// 1. Crear config mainnet sin nano
import fs from 'fs';
let cfg = `export const STELLAR_CONFIG = {
  network: "mainnet",
  rpcUrl: "https://mainnet.soroban-rpc.stellar.org",
  testnetContract: "CCYKK34DEO2BJABJQ7DW5MZ6PYFC7MRJYTZL2QPKBFCXHR4P347EUFZL",
  mainnetContract: "PENDIENTE_DEPLOY_MAINNET",
  passphrase: "Public Global Stellar Network ; September 2015"
}`;
fs.writeFileSync('src/lib/stellarConfig.mainnet.ts', cfg);
console.log("creado src/lib/stellarConfig.mainnet.ts");

// 2. Verificar SDK
try{
  execSync('npm list @stellar/stellar-sdk', {stdio:'inherit'});
}catch{
  execSync('npm install @stellar/stellar-sdk', {stdio:'inherit'});
}
