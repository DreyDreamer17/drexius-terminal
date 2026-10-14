#!/usr/bin/env python3
"""Minimal single-group Nexus sync relay. Stores opaque ciphertext only.

Bind loopback by default; deploy behind an HTTPS reverse proxy for remote use.
Every request needs the same high-entropy bearer token. One instance/token per
sync group. Never put the bearer token in a URL or commit it to the repository.
"""

import argparse
import hmac
import json
import os
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ID = re.compile(r"v2-[0-9a-f]{64}\Z")
MAX_BLOB = 8 * 1024 * 1024
MAX_CHANGES = 10_000


def init_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path, timeout=30) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS changes (cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL)")
        db.execute("CREATE INDEX IF NOT EXISTS changes_cursor ON changes(cursor)")


def make_handler(path: Path, token: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "NexusRelay/1"

        def send_body(self, status: int, body: bytes, content_type: str = "application/json") -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def authenticated(self) -> bool:
            supplied = self.headers.get("Authorization", "")
            if not hmac.compare_digest(supplied, "Bearer " + token):
                self.send_body(401, b'{"error":"unauthorized"}')
                return False
            return True

        def blob_id(self):
            parts = urlsplit(self.path)
            if parts.query or not parts.path.startswith("/blobs/"):
                return None
            blob_id = parts.path[len("/blobs/"):]
            return blob_id if ID.fullmatch(blob_id) else None

        def do_PUT(self):
            if not self.authenticated():
                return
            blob_id = self.blob_id()
            if blob_id is None:
                self.send_body(404, b'{"error":"not found"}')
                return
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                length = -1
            if length < 1 or length > MAX_BLOB:
                self.send_body(413, b'{"error":"invalid blob length"}')
                return
            body = self.rfile.read(length)
            if len(body) != length:
                self.send_body(400, b'{"error":"incomplete blob"}')
                return
            with sqlite3.connect(path, timeout=30) as db:
                db.execute("INSERT INTO blobs(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", (blob_id, body))
                db.execute("INSERT INTO changes(id) VALUES(?)", (blob_id,))
            self.send_body(200, b'{}')

        def do_GET(self):
            if not self.authenticated():
                return
            blob_id = self.blob_id()
            if blob_id is not None:
                with sqlite3.connect(path, timeout=30) as db:
                    row = db.execute("SELECT data FROM blobs WHERE id=?", (blob_id,)).fetchone()
                if row is None:
                    self.send_body(404, b'{"error":"not found"}')
                else:
                    self.send_body(200, row[0], "application/octet-stream")
                return
            parsed = urlsplit(self.path)
            if parsed.path != "/changes":
                self.send_body(404, b'{"error":"not found"}')
                return
            params = parse_qs(parsed.query)
            values = params.get("since", ["0"])
            limits = params.get("limit", [str(MAX_CHANGES)])
            if len(values) != 1 or not values[0].isdigit() or len(limits) != 1 or not limits[0].isdigit():
                self.send_body(400, b'{"error":"invalid cursor or limit"}')
                return
            since = int(values[0])
            limit = int(limits[0])
            if since > 2**63 - 1 or not 1 <= limit <= MAX_CHANGES:
                self.send_body(400, b'{"error":"invalid cursor or limit"}')
                return
            with sqlite3.connect(path, timeout=30) as db:
                rows = db.execute("SELECT cursor,id FROM changes WHERE cursor>? ORDER BY cursor LIMIT ?", (since, limit)).fetchall()
            body = json.dumps({"changes": [{"cursor": n, "id": i} for n, i in rows]}).encode()
            self.send_body(200, body)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: loopback)")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--db", type=Path, default=Path(__file__).with_name("relay.sqlite3"))
    args = parser.parse_args()
    token = os.environ.get("NEXUS_RELAY_TOKEN", "")
    if len(token) < 32:
        parser.error("set NEXUS_RELAY_TOKEN to a random secret of at least 32 characters")
    init_db(args.db)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(args.db, token))
    print(f"Nexus relay listening on {args.host}:{server.server_port}; use HTTPS reverse proxy for remote clients", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
