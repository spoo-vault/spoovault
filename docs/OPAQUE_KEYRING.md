# RFC 9807 OPAQUE keyring PIN verification

SpooVault uses the audited `@serenity-kit/opaque` WebAssembly bindings for
Meta's `opaque-ke` implementation. OPAQUE is a two-party protocol: the browser
holds the PIN, while an independent server holds the OPAQUE registration record
and long-term server setup key.

## Security boundary

The browser's `spoovault-keyring` IndexedDB record contains:

- the account and public ECIES key;
- timestamps and passkey metadata, when applicable; and
- `opaque: { version, iv, ciphertext }`, where `ciphertext` is the private
  ECIES key wrapped by AES-256-GCM under a key derived from OPAQUE's client-only
  export key.

It does **not** contain a password hash, salt, KDF parameters, OPRF key, OPAQUE
registration record, session key, export key, or server setup key. Consequently,
an IndexedDB-only dump provides no local oracle for testing PIN guesses.

The server stores only OPAQUE registration records indexed by normalized account.
It never receives the PIN, private ECIES key, OPAQUE export key, or decrypted
document material. Online login starts are rate-limited per account.

OPAQUE cannot provide offline PIN unlock: after the in-memory key cache is locked,
the browser must contact the verification server. Hardware-backed WebAuthn PRF
passkeys remain an independent offline-capable unlock method.

## Run the server

Generate the long-term server setup once:

```bash
npx @serenity-kit/opaque create-server-setup
```

Store the result in a secret manager and start the service:

```bash
OPAQUE_SERVER_SETUP='<secret setup>' npm run server:opaque
```

The server prints its static public key. Configure the frontend with that exact
value so the browser pins the OPAQUE server identity:

```dotenv
VITE_OPAQUE_SERVER_URL=https://opaque.example.com
VITE_OPAQUE_SERVER_PUBLIC_KEY=<printed public key>
```

Server configuration:

| Variable | Purpose |
| --- | --- |
| `OPAQUE_SERVER_SETUP` | Required long-term secret. Losing or rotating it invalidates existing registrations. |
| `OPAQUE_CREDENTIAL_STORE_PATH` | Durable JSON credential store; defaults to `.data/opaque-keyring-records.json`. |
| `OPAQUE_ALLOWED_ORIGINS` | Comma-separated exact browser origins. |
| `OPAQUE_PORT` | Listen port; defaults to `3010`. |

The bundled file store uses owner-only permissions and atomic replacement. A
production multi-instance deployment should replace it with a transactional
database and place ephemeral login state in a shared, expiring store. TLS,
backups, rate-limit coordination, monitoring, and server-setup rotation are
deployment responsibilities.

## Protocol flow

Registration:

1. Browser creates an OPAQUE registration request from the PIN.
2. Server evaluates it using `OPAQUE_SERVER_SETUP`.
3. Browser verifies the pinned server public key and produces the registration
   record plus client-only export key.
4. Server durably stores the registration record.
5. Browser derives an AES-256-GCM wrapping key from the export key and writes
   only the wrapped private key to IndexedDB.

Unlock:

1. Browser and server exchange OPAQUE `KE1` and `KE2` messages.
2. The browser validates the password and pinned server identity, producing
   `KE3` and a candidate export key.
3. The server verifies `KE3` and acknowledges success.
4. Only after that acknowledgement does the browser use the export key to
   unwrap the ECIES private key and cache it for the active session.

Legacy PBKDF2 and the former local-HMAC “ZKPP” records are read only for
migration. A successful custom-PIN unlock immediately replaces them with the
OPAQUE envelope. New records never use either legacy format.
