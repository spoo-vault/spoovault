export const SYNC_TAG = "spoovault-action-sync";

export const MSG_REGISTER_SYNC = "spoovault/register-sync";
export const MSG_REPLAY_QUEUE = "spoovault/replay-queue";
export const MSG_SYNC_STATUS = "spoovault/sync-status";

export interface SpoovaultWorkerMessage {
  type: string;
  supported?: boolean;
}
