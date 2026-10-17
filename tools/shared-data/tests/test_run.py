"""End to end with a fake embedder: contributions on disk in, pack and unsigned manifest out."""
import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest

import numpy as np

import helpers as h
from pipeline.catalog import Catalog
from pipeline.pack import read_pack
from pipeline.run import run_pipeline

IDS = [f"c-{k}" for k in range(8)]
PINS = {"cropVersion": 2, "dim": 512, "reference": {"min": 0.93, "margin": 0.02}, "highTier": {"sim": 0.82, "gap": 0.025}}
COMMON = dict(clip_hash="77538aade655907f", catalog_hash="2f3c50cec84937ff", pack_url="https://example.com/community-pack.bin", seq=9, issued_at="2026-10-15T03:17:00Z")


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


def catalog():
    return Catalog(np.stack([h.unit(k) for k in range(8)]), IDS)


class Run(unittest.TestCase):
    def build(self, root):
        # 10 installs, each teaching c-1 on its own photo on its own server day.
        for i in range(1, 11):
            it = h.item(install=i, photo=h.photo_id(i, "teach"), received=f"2026-10-{10 + i:02d}T12:00:00.000Z", cards=[card_for(1, box=(0.1, 0.1 + i * 0.01, 0.3, 0.4))])
            h.write_item(root, it, f"t{i}.json")
        # An exam photo labelled c-2 that must never reach the pack.
        h.write_item(root, h.item(install=1, split="exam", photo=h.photo_id(50, "exam"), cards=[card_for(2)]), "e1.json")

    def test_pack_and_manifest(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as out:
            self.build(root)
            summary = run_pipeline(data_dir=root, out_dir=out, pins=PINS, embedder=FakeEmbedder(), catalog=catalog(), **COMMON)
            pack_bytes = read(os.path.join(out, "community-pack.bin"))
            pack = read_pack(pack_bytes)
            self.assertEqual(sorted(set(pack.card_ids)), ["c-1"])  # c-2 (exam only) is absent
            self.assertEqual(len(pack.card_ids), 5)  # ten rows qualified; five rows per card is the cap
            manifest = json.loads(read(os.path.join(out, "manifest.json")))
            self.assertEqual(manifest["entries"], 5)
            self.assertEqual(manifest["exam"]["n"], 1)
            self.assertEqual((manifest["seq"], manifest["issuedAt"]), (9, "2026-10-15T03:17:00Z"))
            self.assertIsNone(manifest["regression"])
            self.assertIs(manifest["improved"], False)
            self.assertEqual(manifest["sha256"], hashlib.sha256(pack_bytes).hexdigest())
            self.assertEqual(summary["entries"], 5)
            self.assertFalse(os.path.exists(os.path.join(out, "manifest.sig")))  # signing is another job's work

    def test_regression_set_is_scored_and_reported(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as out:
            self.build(root)
            regression = (np.stack([h.unit(3), h.unit(4)]), ["c-3", "c-4"])
            run_pipeline(data_dir=root, out_dir=out, pins=PINS, embedder=FakeEmbedder(), catalog=catalog(), regression=regression, **COMMON)
            manifest = json.loads(read(os.path.join(out, "manifest.json")))
            self.assertEqual(manifest["regression"], {"before": 1.0, "after": 1.0, "n": 2})

    def test_no_contributions_gives_an_empty_valid_pack(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as out:
            run_pipeline(data_dir=root, out_dir=out, pins=PINS, embedder=FakeEmbedder(), catalog=catalog(), **COMMON)
            self.assertEqual(read_pack(read(os.path.join(out, "community-pack.bin"))).card_ids, [])
            m = json.loads(read(os.path.join(out, "manifest.json")))
            self.assertEqual((m["entries"], m["exam"]["n"], m["improved"]), (0, 0, False))

    def test_a_hostile_image_is_skipped_not_fatal(self):
        class Strict(FakeEmbedder):
            def __call__(self, jpeg_bytes):
                if len(jpeg_bytes) % 2:
                    raise ValueError("bad image")
                return super().__call__(jpeg_bytes)

        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as out:
            self.build(root)
            summary = run_pipeline(data_dir=root, out_dir=out, pins=PINS, embedder=Strict(), catalog=catalog(), **COMMON)
            self.assertIn("embedFailed", summary)


class Keygen(unittest.TestCase):
    def test_refuses_to_write_inside_the_repo_and_prints_the_public_key(self):
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
