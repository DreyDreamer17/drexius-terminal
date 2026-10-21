# Sync & pairing — operations guide

> How to run your own relay, enroll a second device, rotate credentials, and back up
> without lying to yourself about what the relay can and cannot see.

DrexiusTerminal offers two ways to get your vault onto another machine:

| | **LAN pairing** | **Relay sync** |
|---|---|---|
| Transport | Direct, device-to-device, over the LAN | Through a relay **you** host |
| Shape | **One-time snapshot** | Continuous, record-level merge |
| Needs a server | No | Yes — you run it |
| Carries a group seed | Only if the source already had a relay | Yes |
| New device's master password | Its own, chosen by you | Its own, chosen by you |
| Best for | Moving to a new laptop | Keeping a desktop and a phone in step |

Neither is a backup system. See [Backups](#5-backups) before you rely on either.

---

## 1. The model in one paragraph

A **sync group** is identified by a *group seed*: 32 random bytes, generated once, stored
inside each device's SQLCipher vault, and never derived from your master password. That
separation is what lets two devices share a group while having completely different local
master passwords. The seed is the only thing that lets two vaults read each other's data;
two vaults created independently — even with the same password — are cryptographically
unrelated and will never sync.

From the seed, HKDF derives two subkeys:

```
K_sync  = HKDF-SHA256(seed, "drexius/sync/v2")     # encrypts payloads
K_index = HKDF-SHA256(seed, "drexius/index/v2")    # blinds record identifiers
```

Each record is then:

1. serialised to CBOR,
2. padded up to a **256-byte bucket** (so blob sizes leak only a size class),
3. sealed with **XChaCha20-Poly1305**, using the **blinded ID as additional authenticated
   data**.

The blinded ID is `HMAC(K_index, table:id)`. The relay therefore cannot tell which record a
blob belongs to, cannot correlate the same host across two tables, and cannot recognise a
stable identifier over time.

Merges use **hybrid logical clocks** with last-writer-wins per record, plus **tombstones**
so a deletion propagates instead of being resurrected by a stale device.

---

## 2. What syncs — and what does not

| Synced | Stays local |
|---|---|
| Hosts, **including inline host secrets** | AI provider configurations and API keys |
| Keychain entries, **including private keys and passwords** | Known-host trust (the TOFU store) |
| Snippets | Tailscale credentials |
| Tunnels | Local shell state |
| Vault metadata (the vault list itself) | |

Two consequences worth stating plainly:

- **The relay holds ciphertext of your private keys and passwords.** That is what
  end-to-end encryption means here, and it is also why the relay must be trusted to not be
  a traffic analyser, and why a compromised *device* is a real risk.
- **Known-host trust does not travel.** Your phone will still ask you to approve a host
  fingerprint it has never seen. That is the intended behaviour, not a bug.

---

## 3. Run your own relay

There is **no Drexius-hosted relay**. If you want sync, you run the service.

### 3.1 The reference implementation

`relay/relay.py` is a **stdlib-only** Python service (no pip install required). It stores
opaque blobs, blinded IDs and a change cursor in SQLite.

```bash
export DREXIUS_RELAY_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
python3 relay/relay.py --host 127.0.0.1 --port 8787
```

The token is the only credential. Generate at least **32 random characters**, store it
somewhere safe, and treat it as a password: anyone holding it can write blobs into your
group and can read your group's traffic.

### 3.2 Expose it over HTTPS

Plain HTTP is accepted by the app **only for loopback**. `http://localhost:8787` from
*another* machine resolves to *that* machine and will never reach your relay.

For more than one device, put the relay behind a **TLS-terminating reverse proxy** with a
valid certificate, and keep the Python service bound to loopback:

```nginx
server {
    listen 443 ssl http2;
    server_name relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

The app **enforces HTTPS** for any non-loopback relay URL, and refuses plain HTTP to a
remote host.

### 3.3 A production-shaped service unit

```ini
# /etc/systemd/system/drexius-relay.service
[Unit]
Description=DrexiusTerminal relay
After=network.target

[Service]
Type=simple
User=drexius
Group=drexius
Environment=DREXIUS_RELAY_TOKEN=...        # better: EnvironmentFile
EnvironmentFile=/etc/drexius/relay.env
WorkingDirectory=/opt/drexius-relay
ExecStart=/usr/bin/python3 relay.py --host 127.0.0.1 --port 8787
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/drexius-relay

[Install]
WantedBy=multi-user.target
```

Run it as a **dedicated unprivileged user**, with the database on a volume that is backed
up (§5) but *not* in Git.

### 3.4 Limits of the reference implementation

| Limit | Value |
|---|---|
| Maximum single blob | 8 MiB |
| Maximum changes in one response | 10,000 |
| Client page size | 1,000 |
| Client maximum per run | 100,000 changes |

The client **reports an error** if it cannot retrieve every available change; it never
silently ignores the gap. If you see a sync error after a long outage, that is the
mechanism working as intended.

---

## 4. Enroll a device

### 4.1 Set up the relay on the **existing** device first

This ordering matters. The sync group seed lives in the vault, and the relay settings ride
along in the encrypted pairing archive — so the source device must already know about the
relay before you pair.

1. Open the app, unlock the vault.
2. Click the cloud icon in the icon rail → **Encrypted relay sync**.
3. Enter the relay URL (`https://relay.example.com`) and the bearer token.
4. Click **Save**, then **Sync now** to confirm the round trip works.

### 4.2 Pair the new device over the LAN

1. On the **existing** device: click the QR icon in the icon rail → **Direct Device
   Pairing** → **Share Vault**.
2. You get a **6-digit PIN**, a **QR code**, and a pairing link
   (`drxpair://host:port?pin=…&pk=…`). The device listens on LAN port **48291**, falling
   back to an OS-assigned port.
3. On the **new** device: choose **Link to Device**, then scan the QR or paste the link.
4. Type the PIN to confirm.

### 4.3 What actually happens on the wire

- The new device performs an **X25519 key exchange** with the source.
- The **PIN is only an HKDF salt.** It is never transmitted.
- The new device proves knowledge of the PIN with an **HMAC** bound to the ECDH secret and
  to *both* public keys. The source verifies it with a **constant-time** comparison.
- The peer's public key is **pinned**, not taken from the wire, so a man-in-the-middle
  cannot substitute their own key.
- The vault archive travels under an **XChaCha20-Poly1305** key derived from the same
  secret.
- The pairing endpoints send **no CORS headers**, so a browser on the LAN cannot make a
  cross-origin request against the listener.
- Limits: **5 attempts**, **600 seconds**, and a **64 KiB** body cap.

### 4.4 After pairing

The new device has its **own local master password** and its **own recovery key** —
generate and save that recovery key; it is not the source device's. The encrypted transfer
installed the initial snapshot, the shared group seed, the relay URL and the bearer token.

Subsequent sync happens automatically while the app is unlocked, roughly **every minute**
and on focus/network return.

> **If you paired *before* configuring a relay**, the archive was only a one-time
> snapshot. To enroll in sync, create a **new, empty local vault** on the new device and
> pair again.

---

## 5. Backups

**Neither pairing nor relay sync is a backup.** They replicate forward; they do not
protect against deleting a host everywhere at once, a ransomware event, or losing every
enrolled device.

### What to back up

| Artifact | Why |
|---|---|
| The **relay SQLite database** | It is the transport's only state. Losing it loses unsent history. |
| Each device's **vault file** (`drexius.vault`) | The authoritative copy of your data. |
| Your **Emergency Recovery Key** | The only way into a vault whose password is lost. |
| The **relay bearer token** | Rotating it requires re-enrolling every device. |

### How to back up the relay database

Use SQLite's **online backup API**, or stop the server first and copy the file:

```bash
# Online, while the relay is running
sqlite3 relay/relay.sqlite3 ".backup '/backups/relay-$(date +%F).sqlite3'"
```

> **Restoring an old relay database loses newer changes.** It is a recovery tool, not a
> way to rewind a group. Devices will re-push what they still hold, but anything that only
> existed on the relay is gone.

### What "backup" means for the vault

The vault file is encrypted with a key derived from your master password, so a copy of it
is safe to store — but it is only useful with the **master password** *and*, if you use
one, the **recovery key**. Losing both means losing the data. There is no master-key reset
and no back door, by design.

---

## 6. Rotating credentials

### The relay token

1. Generate a new token on the server: `python3 -c 'import secrets; print(secrets.token_urlsafe(48))'`.
2. Restart the relay with the new `DREXIUS_RELAY_TOKEN`.
3. In the app, update the bearer token and click **Save**.

**Limitation:** the token is **one per sync group**, and it is stored per device. You must
update it on **every enrolled device** — a device with a stale token gets an auth error
and stops syncing. The token is not tied to an individual device, so rotating it does not
require re-pairing.

### The group seed

**There is no in-app rotation.** If you believe the seed is compromised:

1. Create a **fresh sync group** — a new empty vault on a trusted device becomes the source
   of truth.
2. Re-pair your other devices from it.
3. Treat the old group as compromised: the old relay can no longer serve it, and any device
   that still holds the old seed can still read the old blobs it already fetched.

Revoking a paired device is a **separate** action and does **not** rotate the seed. See
[Security model §6](SECURITY.md#6-what-is-deliberately-not-defended).

### Losing a device

- **Revoke** it if the app offers you the option — this prevents future pairings.
- **Rotate the relay token** and update the remaining devices.
- Assume the lost device's copy of the data is **gone**. Rotate any credential that was
  stored in it: host passwords, private keys, API keys, the relay token.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Connection refused" on `http://<host>:8787` | You used HTTP with a non-loopback address | The app requires HTTPS for remote relays. Put a TLS proxy in front. |
| `localhost` on device B does not reach device A's relay | `localhost` means device B | Use the LAN IP *and* HTTPS, or tunnel over SSH. |
| Devices sync but changes are missing | The change set exceeded the 10,000 cap | The client reports an error; run sync again, or upgrade the relay. |
| A revoked device still sees old data | Revocation is not erasure | Rotate the token and the seed; the old device keeps what it already downloaded. |
| "Relay auth failed" on one device only | That device has a stale token | Update the bearer token on **that** device. |
| Two vaults with the same password never sync | They were created independently | Use **Join existing vault** during first-run setup on one of them. |
| Sync stopped after a relay restart | The database was not on a persistent volume | The reference relay defaults to `relay/relay.sqlite3` — put it somewhere that survives redeploys. |
| Pairing link does not open | The custom scheme is not registered on the platform | Use the **Link to Device** tab and paste the link instead of the QR. |

---

## 8. Reference

- [relay/README.md](../relay/README.md) — the relay implementation and its own limits.
- [ARCHITECTURE.md §4](../ARCHITECTURE.md#4-vaults-sharing-and-sync) — the vault, sharing
  and sync design.
- [Security model](SECURITY.md) — what the relay can and cannot see.
