const { expect } = require("chai");
const { ethers } = require("hardhat");
const nacl = require("tweetnacl");
const { StrKey } = require("@stellar/stellar-sdk");

const BIND_PREFIX = "0x42696e644964656e74697479"; // "BindIdentity" (12 bytes)

const toHex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");

/**
 * Build a dual-signed binding payload the same way the frontend does:
 * payload = "BindIdentity" || evm(20) || stellarPubkey(32) || timestamp(8, BE)
 * messageHash = keccak256(payload)
 * - EVM signature: signer.signMessage(messageHash) -> 65-byte EIP-191 sig
 * - Stellar signature: nacl Ed25519 detached signature over messageHash
 */
const buildBinding = async ({
  evmWallet,
  stellarKeyPair,
  timestamp,
  registry,
}) => {
  const stellarPublicKey = toHex(stellarKeyPair.publicKey);
  const network = await ethers.provider.getNetwork();
  const messageHash = ethers.solidityPackedKeccak256(
    ["bytes12", "uint256", "address", "address", "bytes32", "uint64"],
    [
      BIND_PREFIX,
      network.chainId,
      await registry.getAddress(),
      evmWallet.address,
      stellarPublicKey,
      timestamp,
    ]
  );
  const evmSignature = await evmWallet.signMessage(
    ethers.getBytes(messageHash)
  );
  const stellarSignature = toHex(
    nacl.sign.detached(ethers.getBytes(messageHash), stellarKeyPair.secretKey)
  );
  return { messageHash, evmSignature, stellarSignature, stellarPublicKey };
};

describe("CrossChainIdentityRegistry EVM Contract", function () {
  let registry;
  let user;
  let other;
  let stellarKeyPair;
  let stellarAddress;

  beforeEach(async function () {
    [user, other] = await ethers.getSigners();

    const CrossChainIdentityRegistry = await ethers.getContractFactory(
      "CrossChainIdentityRegistry"
    );
    registry = await CrossChainIdentityRegistry.deploy();
    await registry.waitForDeployment();

    stellarKeyPair = nacl.sign.keyPair();
    stellarAddress = StrKey.encodeEd25519PublicKey(stellarKeyPair.publicKey);
  });

  describe("Dual-signed identity binding", function () {
    it("records a binding when both signatures are valid", async function () {
      const timestamp = Math.floor(Date.now() / 1000);
      const { evmSignature, stellarSignature, stellarPublicKey } =
        await buildBinding({
          evmWallet: user,
          stellarKeyPair,
          timestamp,
          registry,
        });

      await expect(
        registry.bindIdentity(
          user.address,
          stellarAddress,
          stellarPublicKey,
          timestamp,
          evmSignature,
          stellarSignature
        )
      )
        .to.emit(registry, "IdentityBound")
        .withArgs(user.address, stellarAddress, stellarPublicKey, timestamp);

      expect(await registry.isBound(user.address)).to.equal(true);
    });

    it("reverts when the EVM signature is invalid (wrong signer)", async function () {
      const timestamp = Math.floor(Date.now() / 1000);
      // Sign with a different wallet than the one being bound
      const { evmSignature, stellarSignature, stellarPublicKey } =
        await buildBinding({
          evmWallet: other,
          stellarKeyPair,
          timestamp,
          registry,
        });

      await expect(
        registry.bindIdentity(
          user.address,
          stellarAddress,
          stellarPublicKey,
          timestamp,
          evmSignature,
          stellarSignature
        )
      ).to.be.revertedWithCustomError(registry, "InvalidEvmSignature");
    });

    it("reverts when the Stellar signature is invalid (tampered)", async function () {
      const timestamp = Math.floor(Date.now() / 1000);
      const { evmSignature, stellarSignature, stellarPublicKey } =
        await buildBinding({
          evmWallet: user,
          stellarKeyPair,
          timestamp,
          registry,
        });

      const tampered = "0x" + "ff".repeat(64);
      await expect(
        registry.bindIdentity(
          user.address,
          stellarAddress,
          stellarPublicKey,
          timestamp,
          evmSignature,
          tampered
        )
      ).to.be.revertedWithCustomError(registry, "InvalidStellarSignature");
    });

    it("reverts on a single-signed request (no Stellar signature)", async function () {
      const timestamp = Math.floor(Date.now() / 1000);
      const { evmSignature, stellarPublicKey } = await buildBinding({
        evmWallet: user,
        stellarKeyPair,
        timestamp,
        registry,
      });

      await expect(
        registry.bindIdentity(
          user.address,
          stellarAddress,
          stellarPublicKey,
          timestamp,
          evmSignature,
          "0x"
        )
      ).to.be.revertedWithCustomError(registry, "InvalidStellarSignature");
    });

    it("reverts on a single-signed request (no EVM signature)", async function () {
      const timestamp = Math.floor(Date.now() / 1000);
      const { stellarSignature, stellarPublicKey } = await buildBinding({
        evmWallet: user,
        stellarKeyPair,
        timestamp,
        registry,
      });

      await expect(
        registry.bindIdentity(
          user.address,
          stellarAddress,
          stellarPublicKey,
          timestamp,
          "0x",
          stellarSignature
        )
      ).to.be.revertedWithCustomError(registry, "InvalidEvmSignature");
    });

    it("reverts when the timestamp is stale", async function () {
      const staleTimestamp = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60; // 2 days old
      const { evmSignature, stellarSignature, stellarPublicKey } =
        await buildBinding({
          evmWallet: user,
          stellarKeyPair,
          timestamp: staleTimestamp,
          registry,
        });

      await expect(
        registry.bindIdentity(
          user.address,
          stellarAddress,
          stellarPublicKey,
          staleTimestamp,
          evmSignature,
          stellarSignature
        )
      ).to.be.revertedWithCustomError(registry, "InvalidTimestamp");
    });

    it("reverts when the timestamp is too far in the future", async function () {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour ahead
      const { evmSignature, stellarSignature, stellarPublicKey } =
        await buildBinding({
          evmWallet: user,
          stellarKeyPair,
          timestamp: futureTimestamp,
          registry,
        });

      await expect(
        registry.bindIdentity(
          user.address,
          stellarAddress,
          stellarPublicKey,
          futureTimestamp,
          evmSignature,
          stellarSignature
        )
      ).to.be.revertedWithCustomError(registry, "InvalidTimestamp");
    });

    it("reverts when the EVM address is already bound", async function () {
      const timestamp = Math.floor(Date.now() / 1000);
      const { evmSignature, stellarSignature, stellarPublicKey } =
        await buildBinding({
          evmWallet: user,
          stellarKeyPair,
          timestamp,
          registry,
        });

      await registry.bindIdentity(
        user.address,
        stellarAddress,
        stellarPublicKey,
        timestamp,
        evmSignature,
        stellarSignature
      );

      // Second binding attempt with a fresh (valid) payload
      const keyPair2 = nacl.sign.keyPair();
      const stellarAddress2 = StrKey.encodeEd25519PublicKey(keyPair2.publicKey);
      const binding2 = await buildBinding({
        evmWallet: user,
        stellarKeyPair: keyPair2,
        timestamp,
        registry,
      });

      await expect(
        registry.bindIdentity(
          user.address,
          stellarAddress2,
          binding2.stellarPublicKey,
          timestamp,
          binding2.evmSignature,
          binding2.stellarSignature
        )
      ).to.be.revertedWithCustomError(registry, "AlreadyBound");
    });

    it("reverts when the Stellar address is already bound", async function () {
      const timestamp = Math.floor(Date.now() / 1000);
      const { evmSignature, stellarSignature, stellarPublicKey } =
        await buildBinding({
          evmWallet: user,
          stellarKeyPair,
          timestamp,
          registry,
        });

      await registry.bindIdentity(
        user.address,
        stellarAddress,
        stellarPublicKey,
        timestamp,
        evmSignature,
        stellarSignature
      );

      // A different EVM wallet tries to bind the same Stellar address
      const binding2 = await buildBinding({
        evmWallet: other,
        stellarKeyPair,
        timestamp,
        registry,
      });

      await expect(
        registry.bindIdentity(
          other.address,
          stellarAddress,
          stellarPublicKey,
          timestamp,
          binding2.evmSignature,
          binding2.stellarSignature
        )
      ).to.be.revertedWithCustomError(registry, "AlreadyBound");
    });

    it("rejects a binding with a mismatched payload (forged public key)", async function () {
      // Sign the payload with keyPair2 but try to bind a DIFFERENT keypair's
      // G-address. The message hash commits to the public key, so the
      // submitted Ed25519 signature must fail verification.
      const timestamp = Math.floor(Date.now() / 1000);
      const keyPair2 = nacl.sign.keyPair();
      const { evmSignature, stellarSignature, stellarPublicKey } =
        await buildBinding({
          evmWallet: other,
          stellarKeyPair: keyPair2,
          timestamp,
          registry,
        });

      const forged = nacl.sign.keyPair();
      await expect(
        registry.bindIdentity(
          other.address,
          StrKey.encodeEd25519PublicKey(forged.publicKey),
          stellarPublicKey, // key committed by the message hash
          timestamp,
          evmSignature,
          stellarSignature
        )
      ).to.be.revertedWithCustomError(registry, "InvalidStellarAddress");
    });
  });

  describe("Identity resolution", function () {
    beforeEach(async function () {
      const timestamp = Math.floor(Date.now() / 1000);
      const { evmSignature, stellarSignature, stellarPublicKey } =
        await buildBinding({
          evmWallet: user,
          stellarKeyPair,
          timestamp,
          registry,
        });
      await registry.bindIdentity(
        user.address,
        stellarAddress,
        stellarPublicKey,
        timestamp,
        evmSignature,
        stellarSignature
      );
    });

    it("resolves EVM -> Stellar", async function () {
      expect(await registry.resolveEvmToStellar(user.address)).to.equal(
        stellarAddress
      );
    });

    it("resolves Stellar -> EVM", async function () {
      expect(await registry.resolveStellarToEvm(stellarAddress)).to.equal(
        user.address
      );
    });

    it("returns the full binding record", async function () {
      const [resolvedStellar, resolvedPubkey, timestamp] =
        await registry.getBinding(user.address);
      expect(resolvedStellar).to.equal(stellarAddress);
      expect(resolvedPubkey).to.equal(toHex(stellarKeyPair.publicKey));
      expect(timestamp).to.be.gt(0);
    });

    it("reverts when resolving an unbound EVM address", async function () {
      await expect(
        registry.resolveEvmToStellar(other.address)
      ).to.be.revertedWithCustomError(registry, "NotBound");
    });

    it("reverts when resolving an unbound Stellar address", async function () {
      const unbound = StrKey.encodeEd25519PublicKey(
        nacl.sign.keyPair().publicKey
      );
      await expect(
        registry.resolveStellarToEvm(unbound)
      ).to.be.revertedWithCustomError(registry, "NotBound");
    });
  });
});

describe("Ed25519 library", function () {
  let harness;

  beforeEach(async function () {
    const TestEd25519 = await ethers.getContractFactory("TestEd25519");
    harness = await TestEd25519.deploy();
    await harness.waitForDeployment();
  });

  it("computes SHA-512 correctly for the 'abc' test vector", async function () {
    const digest = await harness.sha512(ethers.toUtf8Bytes("abc"));
    expect(digest).to.equal(
      "0xddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2" +
        "192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
    );
  });

  it("computes SHA-512 correctly for the empty test vector", async function () {
    const digest = await harness.sha512("0x");
    expect(digest).to.equal(
      "0xcf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce" +
        "47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"
    );
  });

  it("verifies the RFC 8032 test vector 1 (empty message)", async function () {
    const publicKey =
      "0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    const signature =
      "0xe5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
      "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
    expect(await harness.verify(signature, publicKey, "0x")).to.equal(true);
  });

  it("verifies the RFC 8032 test vector 2 (single-byte message)", async function () {
    const publicKey =
      "0x3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
    const signature =
      "0x92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da" +
      "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00";
    expect(await harness.verify(signature, publicKey, "0x72")).to.equal(true);
  });

  it("rejects a tampered signature", async function () {
    const publicKey =
      "0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    const signature =
      "0xe5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
      "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
    const tampered =
      "0xe5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
      "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100c";
    expect(await harness.verify(tampered, publicKey, "0x")).to.equal(false);
  });

  it("rejects a wrong public key", async function () {
    const wrongKey =
      "0x3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
    const signature =
      "0xe5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
      "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
    expect(await harness.verify(signature, wrongKey, "0x")).to.equal(false);
  });
});
