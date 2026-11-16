"use strict";
/**
 * @file relayer/crypto.ts
 * @description Payload encryption for guardian notifications.
 *
 * Guardians publish a base64 X25519 public key in the contacts registry. The
 * relayer encrypts every notification to that key using an ephemeral box
 * (nacl.box with a random nonce, ephemeral public key prepended) so only the
 * guardian's private key can decrypt the payload.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateGuardianKeyPair = generateGuardianKeyPair;
exports.encryptForGuardian = encryptForGuardian;
exports.decryptFromRelayer = decryptFromRelayer;
var tweetnacl_1 = require("tweetnacl");
function generateGuardianKeyPair() {
    var pair = tweetnacl_1.default.box.keyPair();
    return {
        publicKey: Buffer.from(pair.publicKey).toString("base64"),
        secretKey: Buffer.from(pair.secretKey).toString("base64"),
    };
}
/** Encrypt a JSON-serializable payload to a guardian's base64 X25519 public key. */
function encryptForGuardian(publicKeyB64, payload) {
    var recipient = decodeBase64Key(publicKeyB64, "guardian public key");
    if (recipient.length !== tweetnacl_1.default.box.publicKeyLength) {
        throw new Error("Invalid guardian public key length: ".concat(recipient.length));
    }
    var ephemeral = tweetnacl_1.default.box.keyPair();
    var nonce = tweetnacl_1.default.randomBytes(tweetnacl_1.default.box.nonceLength);
    var plaintext = Buffer.from(JSON.stringify(payload), "utf-8");
    var ciphertext = tweetnacl_1.default.box(plaintext, nonce, recipient, ephemeral.secretKey);
    // Envelope: version || ephemeralPublicKey || nonce || ciphertext (all base64)
    return Buffer.concat([
        Buffer.from([1]),
        Buffer.from(ephemeral.publicKey),
        nonce,
        ciphertext,
    ]).toString("base64");
}
/** Decrypt an envelope produced by {@link encryptForGuardian}. */
function decryptFromRelayer(secretKeyB64, envelopeB64) {
    var secret = decodeBase64Key(secretKeyB64, "guardian secret key");
    var envelope = Buffer.from(envelopeB64, "base64");
    var version = envelope[0];
    var pkLen = tweetnacl_1.default.box.publicKeyLength;
    var nonceLen = tweetnacl_1.default.box.nonceLength;
    if (version !== 1 || envelope.length < 1 + pkLen + nonceLen + tweetnacl_1.default.box.overheadLength) {
        throw new Error("Malformed encrypted envelope");
    }
    var ephemeralPk = new Uint8Array(envelope.subarray(1, 1 + pkLen));
    var nonce = new Uint8Array(envelope.subarray(1 + pkLen, 1 + pkLen + nonceLen));
    var ciphertext = new Uint8Array(envelope.subarray(1 + pkLen + nonceLen));
    var opened = tweetnacl_1.default.box.open(ciphertext, nonce, ephemeralPk, secret);
    if (!opened)
        throw new Error("Decryption failed");
    return JSON.parse(Buffer.from(opened).toString("utf-8"));
}
function decodeBase64Key(value, label) {
    var bytes = Buffer.from(value, "base64");
    if (bytes.length === 0)
        throw new Error("Could not decode ".concat(label));
    return new Uint8Array(bytes);
}
