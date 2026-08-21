const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  proveWesolowski,
  fixedTestModulus,
  proofToContractArgs,
  evaluateVdf,
  fiatShamirChallenge,
} = require("./helpers/vdf.cjs");

describe("VDFVerifier", function () {
  let verifier;
  let N;

  before(async function () {
    // 256-bit RSA modulus — fits uint256, keeps verify under 200k gas
    N = fixedTestModulus(256);
  });

  beforeEach(async function () {
    const Factory = await ethers.getContractFactory("VDFVerifier");
    verifier = await Factory.deploy();
    await verifier.waitForDeployment();
  });

  it("verifies a valid Wesolowski proof", async function () {
    const x = 7n;
    const T = 32;
    const proof = proveWesolowski(x, T, N);
    const args = proofToContractArgs(x, T, N, proof);

    const ok = await verifier.verifyWesolowskiView(
      args.x,
      args.y,
      args.pi,
      args.N,
      args.T,
      args.l
    );
    expect(ok).to.equal(true);
  });

  it("rejects an invalid proof", async function () {
    const x = 7n;
    const T = 16;
    const proof = proveWesolowski(x, T, N);
    proof.y = (proof.y + 1n) % N;
    proof.l = fiatShamirChallenge(x, proof.y, T, N);
    const args = proofToContractArgs(x, T, N, proof);

    const ok = await verifier.verifyWesolowskiView(
      args.x,
      args.y,
      args.pi,
      args.N,
      args.T,
      args.l
    );
    expect(ok).to.equal(false);
  });

  it("emits VdfProofVerified on successful state-changing verify", async function () {
    const x = 3n;
    const T = 16;
    const proof = proveWesolowski(x, T, N);
    const args = proofToContractArgs(x, T, N, proof);

    await expect(
      verifier.verifyWesolowski(args.x, args.y, args.pi, args.N, args.T, args.l)
    ).to.emit(verifier, "VdfProofVerified");
  });

  it("Pietrzak round reduces T by half", async function () {
    const x = 5n;
    const T = 16;
    const half = T / 2;
    const mu = evaluateVdf(x, half, N);
    const y = evaluateVdf(x, T, N);

    const result = await verifier.verifyPietrzakRound(x, y, mu, N, T);
    expect(result.newT).to.equal(half);
    expect(result.newX).to.not.equal(0n);
    expect(result.newY).to.not.equal(0n);
  });

  it("Wesolowski verification costs under 200,000 gas", async function () {
    const x = 11n;
    const T = 64;
    const proof = proveWesolowski(x, T, N);
    const args = proofToContractArgs(x, T, N, proof);

    const tx = await verifier.verifyWesolowski(
      args.x,
      args.y,
      args.pi,
      args.N,
      args.T,
      args.l
    );
    const receipt = await tx.wait();
    const gasUsed = Number(receipt.gasUsed);

    // eslint-disable-next-line no-console
    console.log(`    VDFVerifier.verifyWesolowski gas: ${gasUsed}`);
    expect(gasUsed).to.be.below(200_000);
  });
});
