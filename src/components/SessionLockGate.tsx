import { useSessionLock } from "../hooks/useSessionLock";
import { SessionLockModal } from "./SessionLockModal";

/**
 * App-level glue: runs the session-lock manager and renders the lock modal when
 * the session is auto-locked. Mounted once near the root of the app.
 */
export function SessionLockGate() {
  const { locked, lockedAccounts, handleUnlock } = useSessionLock();
  return (
    <SessionLockModal open={locked} accounts={lockedAccounts} onUnlock={handleUnlock} />
  );
}
