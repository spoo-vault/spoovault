# Shamir's Secret Sharing (SSS) Cryptographic Mechanics

SpooVault splits document decryption keys using Shamir's Secret Sharing over Galois Field 256 ($GF(256)$).

## mathematical Outline

A secret $S$ is divided into $n$ shares such that any $k$ shares are sufficient to reconstruct $S$, but any $k-1$ shares reveal zero information about the secret.

- A random polynomial $f(x) = a_0 + a_1 x + a_2 x^2 + dots + a_{k-1} x^{k-1}$ of degree $k-1$ is constructed, where $a_0 = S$.
- Shares are pairs $(i, f(i))$ for $i = 1, dots, n$.
- Reconstruction uses Lagrange Interpolation:
  $$
  S = f(0) = sum_{j=1}^{k} y_j prod_{m
  eq j} rac{x_m}{x_m - x_j}
  $$

Our TypeScript implementation is verified by `scripts/test-sss.mjs`, testing splitting, reconstruction, and below-threshold safety.
