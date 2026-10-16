import base64
import json
import unittest

import _paths  # noqa: F401
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from pipeline.manifest import build_manifest, is_improved, manifest_bytes, sign_bytes, verify_signature
from pipeline.signing import generate_keypair

PINS = {"cropVersion": 2, "dim": 512}
EXAM = {"before": 0.5, "after": 0.6, "n": 40, "wrongAtHigh": {"before": 0.1, "after": 0.05}}
REGRESSION = {"before": 0.8, "after": 0.8, "n": 50}


def manifest(**over):
    args = dict(
        pins=PINS, clip="77538aade655907f", catalog="2f3c50cec84937ff", entries=12,
        pack_bytes=b"pack", url="https://example.com/pack.bin", exam=EXAM,
        regression=REGRESSION, seq=7, issued_at="2026-10-15T03:17:00Z",
    )
    args.update(over)
    return build_manifest(**args)


class Manifest(unittest.TestCase):
    def test_fields(self):
        m = manifest()
        self.assertEqual(m["v"], 1)
        self.assertEqual(m["model"], "77538aade655907f")
        self.assertEqual(m["catalog"], "2f3c50cec84937ff")
        self.assertEqual(m["crop"], 2)
        self.assertEqual(m["entries"], 12)
        self.assertEqual(m["dim"], 512)
        self.assertEqual(m["url"], "https://example.com/pack.bin")
        self.assertEqual(len(m["sha256"]), 64)
        self.assertEqual(m["exam"]["n"], 40)
        self.assertIs(m["improved"], True)
        self.assertEqual(m["seq"], 7)
        self.assertEqual(m["issuedAt"], "2026-10-15T03:17:00Z")
        self.assertEqual(m["regression"], REGRESSION)

    def test_improved_flag(self):
        self.assertIs(manifest(exam={**EXAM, "n": 29})["improved"], False)
        self.assertIs(manifest(exam={**EXAM, "after": 0.5})["improved"], False)
        self.assertTrue(is_improved({"before": 0.0, "after": 0.1, "n": 30}, REGRESSION))

    def test_improved_also_needs_no_drop_on_the_fixed_regression_set(self):
        self.assertIs(manifest(regression={"before": 0.8, "after": 0.79, "n": 50})["improved"], False)
        self.assertIs(manifest(regression={"before": 0.8, "after": 0.81, "n": 50})["improved"], True)
        self.assertIs(manifest(regression={"before": 0.0, "after": 0.0, "n": 0})["improved"], False)  # an empty set proves nothing
        self.assertIs(manifest(regression=None)["improved"], False)  # no regression set: never improved

    def test_sha256_is_of_the_pack_bytes(self):
        import hashlib

        self.assertEqual(manifest(pack_bytes=b"abc")["sha256"], hashlib.sha256(b"abc").hexdigest())

    def test_manifest_bytes_are_stable_compact_json(self):
        a = manifest_bytes(manifest())
        self.assertEqual(a, manifest_bytes(manifest()))
        self.assertNotIn(b" ", a)
        self.assertEqual(json.loads(a)["entries"], 12)


class Signing(unittest.TestCase):
    def setUp(self):
        self.pem, self.spki_b64 = generate_keypair()

    def test_signature_is_64_raw_bytes_and_verifies_with_the_spki_public_key(self):
        data = manifest_bytes(manifest())
        sig = sign_bytes(data, self.pem)
        self.assertEqual(len(base64.b64decode(sig)), 64)
        self.assertTrue(verify_signature(data, sig, self.spki_b64))

    def test_tampered_manifest_or_wrong_key_fails(self):
        data = manifest_bytes(manifest())
        sig = sign_bytes(data, self.pem)
        self.assertFalse(verify_signature(data + b" ", sig, self.spki_b64))
        _, other = generate_keypair()
        self.assertFalse(verify_signature(data, sig, other))
        self.assertFalse(verify_signature(data, "not base64!!", self.spki_b64))
        self.assertFalse(verify_signature(data, base64.b64encode(b"short").decode(), self.spki_b64))

    def test_public_key_is_p256_spki_der(self):
        key = serialization.load_der_public_key(base64.b64decode(self.spki_b64))
        self.assertIsInstance(key.curve, ec.SECP256R1)

    def test_private_key_is_pkcs8_pem(self):
        self.assertTrue(self.pem.startswith(b"-----BEGIN PRIVATE KEY-----"))
        key = serialization.load_pem_private_key(self.pem, password=None)
        self.assertIsInstance(key.curve, ec.SECP256R1)

    def test_signing_without_a_key_fails_fast(self):
        with self.assertRaises(ValueError):
            sign_bytes(b"x", b"")


if __name__ == "__main__":
    unittest.main()
