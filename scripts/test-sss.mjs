import {
  splitSecret,
  reconstructSecret,
} from "../src/services/secrets.service.ts";

console.log("?? Testing Shamir's Secret Sharing over GF(256)...");

const secret =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const n = 5;
const k = 3;

try {
  console.log(`Original Secret: ${secret}`);
  console.log(`Splitting into ${n} shares (threshold = ${k})...`);
  const shares = splitSecret(secret, n, k);
  shares.forEach((s) => console.log(` - Share: ${s}`));

  // Reconstruct with shares [0, 1, 2] (3 shares)
  console.log("\nReconstructing with shares [1, 2, 3]...");
  const recon1 = reconstructSecret([shares[0], shares[1], shares[2]]);
  console.log(`Reconstructed Secret: ${recon1}`);
  if (recon1 === secret) {
    console.log("? Success: Exact match with shares [1, 2, 3]!");
  } else {
    throw new Error("Failed: Reconstructed secret does not match");
  }

  // Reconstruct with shares [1, 3, 4]
  console.log("\nReconstructing with shares [2, 4, 5]...");
  const recon2 = reconstructSecret([shares[1], shares[3], shares[4]]);
  console.log(`Reconstructed Secret: ${recon2}`);
  if (recon2 === secret) {
    console.log("? Success: Exact match with shares [2, 4, 5]!");
  } else {
    throw new Error("Failed: Reconstructed secret does not match");
  }

  // Reconstruct with 2 shares (below threshold)
  console.log("\nAttempting reconstruction with 2 shares (below threshold)...");
  const recon3 = reconstructSecret([shares[0], shares[2]]);
  console.log(`Reconstructed Secret: ${recon3}`);
  if (recon3 !== secret) {
    console.log("? Success: Failed to match (as expected with 2 shares)!");
  } else {
    throw new Error(
      "Vulnerability: Reconstructed secret matched with fewer shares than threshold"
    );
  }

  console.log("\n? Shamir's Secret Sharing works perfectly!");
} catch (error) {
  console.error("FAIL: SSS test failed:", error);
  process.exit(1);
}
