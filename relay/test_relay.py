import http.client
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from relay import init_db, make_handler


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        db = Path(self.temp.name) / "relay.sqlite3"
        init_db(db)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(db, "s" * 32))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method, path, body=None, auth=True):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        headers = {"Authorization": "Bearer " + "s" * 32} if auth else {}
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        result = resp.status, resp.read()
        conn.close()
        return result

    def test_rejects_invalid_requests_and_missing_blobs(self):
        blob_id = "v2-" + "b" * 64
        self.assertEqual(self.request("GET", "/changes?since=bogus")[0], 400)
        self.assertEqual(self.request("GET", "/changes?since=0", auth=False)[0], 401)
        self.assertEqual(self.request("GET", "/blobs/" + blob_id)[0], 404)
        self.assertEqual(self.request("PUT", "/blobs/" + blob_id, b"")[0], 413)

    def test_bearer_token_authentication(self):
        blob_id = "v2-" + "d" * 64
        # Wrong token fails
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        conn.request("GET", "/changes?since=0", headers={"Authorization": "Bearer wrong-token-12345678901234567890"})
        self.assertEqual(conn.getresponse().status, 401)
        conn.close()

        # Non-Bearer auth fails
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        conn.request("GET", "/changes?since=0", headers={"Authorization": "Basic dXNlcjpwYXNz"})
        self.assertEqual(conn.getresponse().status, 401)
        conn.close()

    def test_blob_id_regex_strictness(self):
        # Uppercase hex should fail regex [0-9a-f]
        self.assertEqual(self.request("GET", "/blobs/v2-" + "A" * 64)[0], 404)
        # Short hash
        self.assertEqual(self.request("GET", "/blobs/v2-abcd1234")[0], 404)
        # Non-hex characters
        self.assertEqual(self.request("GET", "/blobs/v2-" + "z" * 64)[0], 404)
        # Query string on blob endpoint is rejected
        self.assertEqual(self.request("GET", "/blobs/v2-" + "a" * 64 + "?foo=bar")[0], 404)

    def test_changes_query_validation(self):
        # Negative cursor
        self.assertEqual(self.request("GET", "/changes?since=-1")[0], 400)
        # Limit zero
        self.assertEqual(self.request("GET", "/changes?since=0&limit=0")[0], 400)
        # Limit exceeding MAX_CHANGES (10000)
        self.assertEqual(self.request("GET", "/changes?since=0&limit=10001")[0], 400)
        # Multiple since parameters
        self.assertEqual(self.request("GET", "/changes?since=0&since=1")[0], 400)
        # Unknown non-changes path
        self.assertEqual(self.request("GET", "/nonexistent")[0], 404)

    def test_blob_overwrite_updates_data_and_emits_new_change(self):
        blob_id = "v2-" + "e" * 64
        self.assertEqual(self.request("PUT", "/blobs/" + blob_id, b"initial-data")[0], 200)
        self.assertEqual(self.request("GET", "/blobs/" + blob_id), (200, b"initial-data"))

        # Overwrite same blob ID
        self.assertEqual(self.request("PUT", "/blobs/" + blob_id, b"updated-data")[0], 200)
        self.assertEqual(self.request("GET", "/blobs/" + blob_id), (200, b"updated-data"))

        # Changes log records both mutations
        status, body = self.request("GET", "/changes?since=0")
        self.assertEqual(status, 200)
        changes = json.loads(body)["changes"]
        self.assertEqual(len(changes), 2)
        self.assertEqual(changes[0]["id"], blob_id)
        self.assertEqual(changes[1]["id"], blob_id)
        self.assertLess(changes[0]["cursor"], changes[1]["cursor"])

    def test_change_pagination(self):
        for ch in "abc":
            self.assertEqual(self.request("PUT", "/blobs/v2-" + ch * 64, b"ciphertext")[0], 200)
        status, body = self.request("GET", "/changes?since=0&limit=2")
        self.assertEqual(status, 200)
        first = json.loads(body)["changes"]
        self.assertEqual(len(first), 2)
        _, body = self.request("GET", "/changes?since=" + str(first[-1]["cursor"]) + "&limit=2")
        self.assertEqual(len(json.loads(body)["changes"]), 1)

    def test_auth_put_get_changes_and_cursor(self):
        blob_id = "v2-" + "a" * 64
        self.assertEqual(self.request("PUT", "/blobs/" + blob_id, b"encrypted", auth=False)[0], 401)
        self.assertEqual(self.request("PUT", "/blobs/../bad", b"secret")[0], 404)
        self.assertEqual(self.request("PUT", "/blobs/" + blob_id, b"encrypted")[0], 200)
        self.assertEqual(self.request("GET", "/blobs/" + blob_id), (200, b"encrypted"))
        status, body = self.request("GET", "/changes?since=0")
        self.assertEqual(status, 200)
        changes = json.loads(body)["changes"]
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["id"], blob_id)
        self.assertEqual(json.loads(self.request("GET", "/changes?since=" + str(changes[0]["cursor"]))[1])["changes"], [])


if __name__ == "__main__":
    unittest.main()
