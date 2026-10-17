# Drexius relay (self-hosted, single sync group)

The desktop app is the client. This reference relay stores **opaque encrypted
blobs**, HMAC-blinded identifiers and a change cursor in SQLite. It does not
have vault decryption keys. It *does* see request timing, bucketed blob sizes,
client IPs and the bearer token; use a trusted host and HTTPS.

## Local test

```bash
export DREXIUS_RELAY_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
python3 relay/relay.py --host 127.0.0.1 --port 8787
```

On the **same computer**, enter `http://127.0.0.1:8787` and the token in
Settings → Encrypted relay sync. HTTP is accepted only for loopback in the app.
`localhost` on *another computer* points at that other computer and will not
reach your relay.

For multiple devices, put the relay behind a **TLS-terminating reverse proxy**
with a valid HTTPS certificate. Keep its Python server bound to loopback and
proxy `https://your-relay.example` to `http://127.0.0.1:8787`. Set HTTPS and
its high-entropy token on the **existing** desktop first, then choose **Join
existing vault** during first-run setup on a new device. After creating a
*local* master password and saving its recovery kit, paste the pairing link
from the unlocked existing device (both devices on the same LAN for pairing).
The encrypted pairing transfer installs the initial snapshot, shared sync
secret, relay URL and bearer token. Subsequent desktop sync happens when the
app is unlocked, approximately every minute and on focus/network return.

If you paired before configuring a relay, the archive was only a one-time
snapshot: use a new, empty local vault and pair again for sync enrollment.
Do not set up two independent vaults with the same password and expect them to
sync; their local SQLCipher keys are intentionally different.

## Operation & limitations

- One relay instance/token per sync group. Set `DREXIUS_RELAY_TOKEN` to at least
  32 random characters; protect it like a password. **No Drexius-hosted relay
  exists.** You must run and secure this service yourself.
- Database: `relay/relay.sqlite3` by default (override `--db`). Back it up
  using SQLite's online backup API or after stopping the server; keep it out
  of Git. Restoring the relay database from old backup can lose newer changes.
- This reference implementation caps individual blobs at 8 MiB and a single
  change response at 10,000 entries. The client pages 1,000 at a time (up to
  100,000 changes per run); it reports an error instead of silently ignoring
  unavailable changes.
- Only hosts (including inline host secrets), keychain (including private
  keys/passwords), snippets, tunnels and vault metadata sync. AI settings and
  SSH known-host trust remain local. Conflicts resolve at the *record* level
  by last-writer-wins; concurrent edits of the same record can overwrite one
  another. Keep a separate backup of important data.
- Pairing revocation prevents another pairing but cannot retract data an old
  device already downloaded, nor does it rotate the shared sync key or token.
  Do not rely on revocation to exclude a compromised device; rotate credentials
  and create a fresh sync group. No out-of-band sync-seed recovery export is
  implemented yet: keep at least one enrolled device and a backup of its vault.

Run tests: `python3 -m unittest discover -s relay -p 'test_*.py'`.
