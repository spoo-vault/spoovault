import { ethers } from "ethers";
import { contractService } from "./contract.service";
import { stellarService } from "./stellar.service";
import { notifyCenter } from "./relayNotification.service";

export interface HeartbeatPayload {
  gid: string;
  gidHash: string;
  vaultId: number;
  evmOwner: string;
  timestamp: number;
}

export interface HeartbeatSignature {
  signature: string;
  recoveryId: number;
}

export interface CrossChainHeartbeatResult {
  evmTransactionHash: string;
  payload: HeartbeatPayload;
  signature: HeartbeatSignature;
  stellarSynchronized: boolean;
}

const HEARTBEAT_PREFIX = "SpooVaultProofOfLife";

export const buildHeartbeatPayload = (
  gid: string,
  vaultId: number,
  evmOwner: string,
  timestamp: number
): HeartbeatPayload => {
  const gidHash = ethers.keccak256(ethers.toUtf8Bytes(gid));
  return { gid, gidHash, vaultId, evmOwner, timestamp };
};

export const buildHeartbeatDigest = (payload: HeartbeatPayload): string => {
  const encoded = ethers.concat([
    ethers.toUtf8Bytes(HEARTBEAT_PREFIX),
    payload.gidHash,
    ethers.zeroPadValue(ethers.toBeHex(payload.vaultId), 8),
    payload.evmOwner,
    ethers.zeroPadValue(ethers.toBeHex(payload.timestamp), 8),
  ]);
  return ethers.keccak256(encoded);
};

export const signHeartbeatPayload = async (
  payload: HeartbeatPayload,
  signer: ethers.Signer
): Promise<HeartbeatSignature> => {
  const digest = buildHeartbeatDigest(payload);
  const signature = await signer.signMessage(ethers.getBytes(digest));
  const parsed = ethers.Signature.from(signature);
  return { signature, recoveryId: parsed.yParity };
};

export const synchronizeHeartbeat = async (
  vaultId: number,
  stellarVaultId: number,
  relayer: string,
  signer: ethers.Signer
): Promise<CrossChainHeartbeatResult> => {
  const notificationId = notifyCenter.trackTask({
    title: `Relaying Vault #${vaultId} proof-of-life`,
    description: `Preparing cross-chain sync to Soroban Vault #${stellarVaultId}`,
    category: "cross-chain-relay",
    network: "avalanche",
    dedupeKey: `heartbeat-relay:${vaultId}:${stellarVaultId}`,
  });

  try {
    const evmOwner = await signer.getAddress();
    const gid = await contractService.getVaultGID(vaultId);
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = buildHeartbeatPayload(gid, vaultId, evmOwner, timestamp);
    const signature = await signHeartbeatPayload(payload, signer);
    const evmTransactionHash = await contractService.recordProofOfLife(vaultId);

    notifyCenter.markSubmitted(notificationId, {
      title: `Relaying Vault #${vaultId} proof-of-life to Soroban`,
      description: `EVM check-in recorded; anchoring on Soroban Vault #${stellarVaultId}`,
      txHash: evmTransactionHash,
      network: "avalanche",
    });

    await stellarService.syncProofOfLife(
      stellarVaultId,
      vaultId,
      payload.gidHash,
      evmOwner,
      timestamp,
      signature.signature,
      signature.recoveryId,
      relayer
    );

    notifyCenter.markConfirmed(notificationId, {
      title: `Cross-chain heartbeat synced for Vault #${vaultId}`,
      description: `Anchored on Avalanche and Soroban Vault #${stellarVaultId}`,
      txHash: evmTransactionHash,
      network: "avalanche",
    });

    return {
      evmTransactionHash,
      payload,
      signature,
      stellarSynchronized: true,
    };
  } catch (error) {
    notifyCenter.markFailed(notificationId, error, {
      title: `Heartbeat relay failed for Vault #${vaultId}`,
    });
    throw error;
  }
};
