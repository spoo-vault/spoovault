import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const forge = JSON.parse(readFileSync("out/SpooVault.sol/SpooVault.json", "utf8"));
const add0x = (s) => s.startsWith("0x") ? s : "0x" + s;
const artifact = {
  contractName: "SpooVault",
  sourceName: "contracts/SpooVault.sol",
  abi: forge.abi,
  bytecode: add0x(forge.bytecode.object),
  deployedBytecode: add0x(forge.deployedBytecode.object),
  linkReferences: forge.bytecode.linkReferences ?? {},
  deployedLinkReferences: forge.deployedBytecode.linkReferences ?? {},
};
const outPath = resolve("artifacts/contracts/SpooVault.sol/SpooVault.json");
mkdirSync(resolve("artifacts/contracts/SpooVault.sol"), { recursive: true });
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log("wrote", outPath);
