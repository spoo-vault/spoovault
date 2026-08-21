import { useState } from "react";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input } from "@heroui/react";

interface SessionLockModalProps {
  open: boolean;
  accounts: string[];
  onUnlock: (pin: string) => Promise<void> | void;
}

function shorten(account: string): string {
  if (!account) return "";
  return `${account.slice(0, 6)}…${account.slice(-4)}`;
}

/**
 * Screen-lock modal shown after the session auto-locks. Prompts for the PIN
 * (or passkey-backed secret) used to re-derive the decrypted key material.
 */
export function SessionLockModal({ open, accounts, onUnlock }: SessionLockModalProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onUnlock(pin);
      setPin("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unlock failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={open} hideCloseButton backdrop="blur" isDismissable={false} placement="center">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">Session Locked</ModalHeader>
        <ModalBody>
          <p className="text-sm text-gray-400">
            Your decrypted keys were purged from memory after inactivity. Enter your PIN
            (or use your passkey) to unlock and restore your session.
          </p>
          {accounts.length > 0 && (
            <p className="text-xs text-gray-500">
              Locked accounts: {accounts.slice(0, 3).map(shorten).join(", ")}
              {accounts.length > 3 ? "…" : ""}
            </p>
          )}
          <Input
            label="PIN / Passkey"
            type="password"
            value={pin}
            onValueChange={setPin}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            isInvalid={!!error}
            errorMessage={error ?? undefined}
            isDisabled={busy}
            autoFocus
          />
        </ModalBody>
        <ModalFooter>
          <Button color="primary" onPress={() => void submit()} isLoading={busy}>
            Unlock
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
