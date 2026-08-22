import { useCallback, useEffect, useRef, useState } from "react";
import { clientKeyringService } from "../services/clientKeyring.service";
import { SessionLockManager } from "../services/sessionLock.service";
import { useWeb3 } from "../context/Web3Context";

/**
 * Wire the session-lock manager into a React component. Starts monitoring when
 * an account is connected and unlocked, presents a lock modal on auto-lock, and
 * re-derives the key material from the user's PIN on unlock.
 */
export function useSessionLock(idleTimeoutMs?: number) {
  const { account } = useWeb3();
  const [locked, setLocked] = useState(false);
  const [lockedAccounts, setLockedAccounts] = useState<string[]>([]);
  const managerRef = useRef<SessionLockManager | null>(null);

  const start = useCallback(() => {
    managerRef.current?.stop();
    managerRef.current = new SessionLockManager({
      idleTimeoutMs,
      accountsProvider: () =>
        account
          ? clientKeyringService.isUnlocked(account)
            ? [account]
            : []
          : [],
      onLock: (accounts) => {
        setLockedAccounts(accounts);
        setLocked(true);
      },
    });
    managerRef.current.start();
  }, [account, idleTimeoutMs]);

  useEffect(() => {
    if (!account) return;
    start();
    return () => {
      managerRef.current?.stop();
      managerRef.current = null;
    };
  }, [account, start]);

  const handleUnlock = useCallback(
    async (pin: string) => {
      const accounts = lockedAccounts.length
        ? lockedAccounts
        : account
        ? [account]
        : [];
      if (accounts.length === 0) {
        throw new Error("No active account to unlock");
      }
      // Re-derive (and re-cache) the decrypted key for each locked account.
      for (const a of accounts) {
        await clientKeyringService.getDecryptedPrivateKey(a, pin);
      }
      setLocked(false);
      setLockedAccounts([]);
      start();
    },
    [lockedAccounts, account, start]
  );

  return { locked, lockedAccounts, handleUnlock };
}
