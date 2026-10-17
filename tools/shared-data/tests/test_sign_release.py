"""The sign job's gate: it re-checks what the unprivileged build job produced before it signs anything."""
import base64
import datetime
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

import numpy as np

import helpers as h
from pipeline.manifest import build_manifest, manifest_bytes
from pipeline.pack import write_pack
from pipeline.signing import generate_keypair, verify_signature

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "sign_release.py")
spec = importlib.util.spec_from_file_location("sign_release", SCRIPT)
sign_release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sign_release)

URL = "https://github.com/fabcrowd/card-scanner-data/releases/download/pack-20261015-9/community-pack.bin"
NOW = datetime.datetime(2026, 10, 15, 3, 30, tzinfo=datetime.timezone.utc)
PINS = {"cropVersion": 2, "dim": 512}
EXAM = {"before": 0.5, "after": 0.6, "n": 40, "wrongAtHigh": {"before": 0.1, "after": 0.05}}
REG = {"before": 0.8, "after": 0.8, "n": 20}


def release(**over):
    pack = write_pack(["c-1", "c-2"], np.stack([h.unit(1), h.unit(2)]))
    args = dict(pins=PINS, clip="77538aade655907f", catalog="2f3c50cec84937ff", entries=2, pack_bytes=pack, url=URL, exam=EXAM, regression=REG, seq=9, issued_at="2026-10-15T03:17:00Z")
    args.update(over)
    return manifest_bytes(build_manifest(**args)), pack


def check(manifest, pack, **over):
    kw = dict(expected_url=URL, run_number=9, now=NOW)
    kw.update(over)
    return sign_release.verify_release(manifest, pack, **kw)


class Verify(unittest.TestCase):
    def refused(self, manifest, pack, pattern, **over):
        with self.assertRaisesRegex(sign_release.Refused, pattern):
            check(manifest, pack, **over)

    def test_a_good_release_passes(self):
        manifest, pack = release()
        self.assertEqual(check(manifest, pack)["entries"], 2)

    def test_pack_that_does_not_match_the_manifest_is_refused(self):
        manifest, pack = release()
        self.refused(manifest, pack + b"\0", "sha256")
        other = write_pack(["c-1"], np.stack([h.unit(1)]))
        m2, _ = release(pack_bytes=other, entries=2)  # claims 2 entries for a 1-entry pack
        self.refused(m2, other, "entries")

    def test_url_seq_and_issue_time_must_belong_to_this_run(self):
        manifest, pack = release()
        self.refused(manifest, pack, "url", expected_url=URL.replace("pack-20261015-9", "pack-20261015-10"))
        self.refused(manifest, pack, "seq", run_number=10)
        self.refused(manifest, pack, "issuedAt", now=NOW + datetime.timedelta(hours=3))
        m_old, p_old = release(issued_at="2026-01-01T00:00:00Z")
        self.refused(m_old, p_old, "issuedAt")

    def test_improved_must_follow_from_the_numbers(self):
        liar, pack = release(exam={**EXAM, "after": 0.4})
        tampered = json.loads(liar)
        tampered["improved"] = True
        self.refused(json.dumps(tampered, sort_keys=True, separators=(",", ":")).encode(), pack, "improved")
        small, pack = release(exam={**EXAM, "n": 5})
        tampered = json.loads(small)
        tampered["improved"] = True
        self.refused(json.dumps(tampered, sort_keys=True, separators=(",", ":")).encode(), pack, "improved")
        dropped, pack = release(regression={"before": 0.8, "after": 0.7, "n": 20})
        self.assertIs(json.loads(dropped)["improved"], False)
        check(dropped, pack)  # honest "not improved" is fine to sign: it tells clients to drop the pack
        tampered = json.loads(dropped)
        tampered["improved"] = True
        self.refused(json.dumps(tampered, sort_keys=True, separators=(",", ":")).encode(), pack, "improved")

    def test_unknown_fields_and_bad_pack_contents_are_refused(self):
        manifest, pack = release()
        extra = json.loads(manifest)
        extra["evil"] = 1
        self.refused(json.dumps(extra).encode(), pack, "fields")
        bad_ids = write_pack(["", "c-2"], np.stack([h.unit(1), h.unit(2)]))
        m, _ = release(pack_bytes=bad_ids)
        self.refused(m, bad_ids, "card id")
        self.refused(b"not json", pack, "manifest")

    def test_too_many_entries_or_a_huge_pack_are_refused(self):
        big_ids = [f"c-{i}" for i in range(sign_release.MAX_ENTRIES + 1)]
        pack = write_pack(big_ids, np.tile(h.unit(1), (len(big_ids), 1)))
        manifest, _ = release(pack_bytes=pack, entries=len(big_ids))
        self.refused(manifest, pack, "too many")


class Signing(unittest.TestCase):
    def test_main_signs_the_exact_manifest_bytes(self):
        pem, spki = generate_keypair()
        manifest, pack = release()
        with tempfile.TemporaryDirectory() as out:
            with open(os.path.join(out, "manifest.json"), "wb") as f:
                f.write(manifest)
            with open(os.path.join(out, "community-pack.bin"), "wb") as f:
                f.write(pack)
            env = {**os.environ, "PACK_SIGNING_KEY": pem.decode()}
            args = [sys.executable, SCRIPT, "--dir", out, "--url", URL, "--run-number", "9", "--now", "2026-10-15T03:30:00Z"]
            r = subprocess.run(args, env=env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(os.path.join(out, "manifest.sig")) as f:
                sig = f.read()
            self.assertEqual(len(base64.b64decode(sig)), 64)
            self.assertTrue(verify_signature(manifest, sig, spki))
            self.assertFalse(verify_signature(manifest + b" ", sig, spki))

    def test_refused_release_writes_no_signature_and_a_missing_key_stops_early(self):
        pem, _ = generate_keypair()
        manifest, pack = release()
        with tempfile.TemporaryDirectory() as out:
            with open(os.path.join(out, "manifest.json"), "wb") as f:
                f.write(manifest)
            with open(os.path.join(out, "community-pack.bin"), "wb") as f:
                f.write(pack + b"x")
            args = [sys.executable, SCRIPT, "--dir", out, "--url", URL, "--run-number", "9", "--now", "2026-10-15T03:30:00Z"]
            r = subprocess.run(args, env={**os.environ, "PACK_SIGNING_KEY": pem.decode()}, capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertFalse(os.path.exists(os.path.join(out, "manifest.sig")))
            env = {k: v for k, v in os.environ.items() if k != "PACK_SIGNING_KEY"}
            r = subprocess.run(args, env=env, capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)

    def test_the_script_imports_only_the_standard_library_and_cryptography(self):
        with open(SCRIPT, encoding="utf-8") as f:
            text = f.read()
        imports = {line.split()[1].split(".")[0] for line in text.splitlines() if line.startswith(("import ", "from "))}
        self.assertTrue(imports <= {"argparse", "base64", "datetime", "hashlib", "json", "math", "os", "re", "struct", "sys", "cryptography"}, imports)


if __name__ == "__main__":
    unittest.main()
