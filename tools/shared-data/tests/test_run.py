"""End to end with a fake embedder: contributions on disk in, signed pack out."""
import base64
import hashlib
import json
import os
import tempfile
import unittest

import numpy as np

import helpers as h
from pipeline.catalog import Catalog
from pipeline.manifest import verify_signature
from pipeline.pack import read_pack
from pipeline.run import run_pipeline
from pipeline.signing import generate_keypair

IDS = [f"c-{k}" for k in range(8)]
PINS = {"cropVersion": 2, "dim": 512, "reference": {"min": 0.93, "margin": 0.02}, "highTier": {"sim": 0.82, "gap": 0.025}}


def read(path, mode="rb"):
    with open(path, mode) as f:
        return f.read()


class FakeEmbedder:
    """Embeds a crop as the basis direction named by its JPEG's red channel (seed = card index)."""

    def __call__(self, jpeg_bytes):
        import io

        from PIL import Image

        red = Image.open(io.BytesIO(jpeg_bytes)).convert("RGB").getpixel((0, 0))[0]
        return h.unit(int(round(red / 10)) % 8)


def card_for(k, **kw):
    return h.card(IDS[k], seed=k * 10, **kw)  # red channel ~ seed -> basis k


class Run(unittest.TestCase):
    def build(self, root):
        # 10 installs, each teaching 1 row for card c-1 on its own photo -> every install is 10% of the pack.
        for i in range(1, 11):
            h.write_item(root, h.item(install=i, photo=h.photo_id(i, "teach"), cards=[card_for(1, box=(0.1, 0.1 + i * 0.01, 0.3, 0.4))]), f"t{i}.json")
        # An exam photo labelled c-2 that must never reach the pack.
        h.write_item(root, h.item(install=1, split="exam", photo=h.photo_id(50, "exam"), cards=[card_for(2)]), "e1.json")

    def test_pack_manifest_and_signature(self):
        pem, spki = generate_keypair()
        catalog = Catalog(np.stack([h.unit(k) for k in range(8)]), IDS)
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as out:
            self.build(root)
            summary = run_pipeline(
                data_dir=root, out_dir=out, pins=PINS, embedder=FakeEmbedder(), catalog=catalog,
                clip_hash="77538aade655907f", catalog_hash="2f3c50cec84937ff", signing_key=pem,
                pack_url="https://example.com/community-pack.bin",
            )
            pack = read_pack(read(os.path.join(out, "community-pack.bin")))
            self.assertEqual(sorted(set(pack.card_ids)), ["c-1"])  # c-2 (exam only) is absent
            self.assertEqual(len(pack.card_ids), 10)
            manifest_raw = read(os.path.join(out, "manifest.json"))
            sig = read(os.path.join(out, "manifest.sig"), "r").strip()
            self.assertTrue(verify_signature(manifest_raw, sig, spki))
            manifest = json.loads(manifest_raw)
            self.assertEqual(manifest["entries"], 10)
            self.assertEqual(manifest["exam"]["n"], 1)
            self.assertIs(manifest["improved"], False)  # n < 30
            self.assertEqual(summary["entries"], 10)
            self.assertEqual(manifest["sha256"], hashlib.sha256(read(os.path.join(out, "community-pack.bin"))).hexdigest())

    def test_without_a_signing_key_it_fails_before_writing(self):
        catalog = Catalog(np.stack([h.unit(k) for k in range(8)]), IDS)
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as out:
            self.build(root)
            with self.assertRaises(ValueError):
                run_pipeline(data_dir=root, out_dir=out, pins=PINS, embedder=FakeEmbedder(), catalog=catalog,
                             clip_hash="a" * 16, catalog_hash="b" * 16, signing_key=b"", pack_url="u")
            self.assertEqual(os.listdir(out), [])

    def test_no_contributions_gives_an_empty_valid_pack(self):
        pem, spki = generate_keypair()
        catalog = Catalog(np.stack([h.unit(k) for k in range(8)]), IDS)
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as out:
            run_pipeline(data_dir=root, out_dir=out, pins=PINS, embedder=FakeEmbedder(), catalog=catalog,
                         clip_hash="a" * 16, catalog_hash="b" * 16, signing_key=pem, pack_url="u")
            self.assertEqual(read_pack(read(os.path.join(out, "community-pack.bin"))).card_ids, [])
            m = json.loads(read(os.path.join(out, "manifest.json")))
            self.assertEqual((m["entries"], m["exam"]["n"], m["improved"]), (0, 0, False))
            self.assertTrue(base64.b64decode(read(os.path.join(out, "manifest.sig"), "r")))


class Keygen(unittest.TestCase):
    def test_refuses_to_write_inside_the_repo_and_prints_the_public_key(self):
        import subprocess
        import sys

        script = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "keygen.py")
        inside = os.path.join(os.path.dirname(script), "key.pem")
        r = subprocess.run([sys.executable, script, "--out", inside], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(os.path.exists(inside))
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "key.pem")
            r = subprocess.run([sys.executable, script, "--out", target], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue(read(target).startswith(b"-----BEGIN PRIVATE KEY-----"))
            self.assertTrue(base64.b64decode(r.stdout.strip().splitlines()[-1]))
            again = subprocess.run([sys.executable, script, "--out", target], capture_output=True, text=True)
            self.assertNotEqual(again.returncode, 0)  # never overwrite a key


if __name__ == "__main__":
    unittest.main()
