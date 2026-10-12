import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

import cv2
import numpy as np


DETECT_DIR = Path(__file__).resolve().parents[1] / "detect"
sys.path.insert(0, str(DETECT_DIR))


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


synth_binder = _load_module("synth_binder", DETECT_DIR / "synth_binder.py")


def _fake_catalog(root: Path, n: int = 6) -> Path:
    cat = root / "catalog"
    cat.mkdir()
    for i in range(n):
        card = np.full((352, 252, 3), (40 * i % 255, 120, 200), dtype=np.uint8)
        cv2.rectangle(card, (20, 30), (230, 170), (10, 10, 10), -1)
        cv2.imwrite(str(cat / f"c{i}.png"), card)
    return cat


class SynthBinderTests(unittest.TestCase):
    def test_writes_image_and_label_per_sample_with_valid_card_boxes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            out = root / "ds"
            written = synth_binder.generate(out, _fake_catalog(root), count=8, seed=3, split="train")
            self.assertEqual(written, 8)
            images = sorted((out / "images" / "train").glob("binder_synth_*.jpg"))
            self.assertEqual(len(images), 8)
            total_boxes = 0
            for img in images:
                label = out / "labels" / "train" / f"{img.stem}.txt"
                self.assertTrue(label.is_file())
                h, w = cv2.imread(str(img)).shape[:2]
                for line in label.read_text().splitlines():
                    cls, xc, yc, bw, bh = line.split()
                    self.assertEqual(cls, "0")
                    vals = [float(v) for v in (xc, yc, bw, bh)]
                    self.assertTrue(all(0.0 <= v <= 1.0 for v in vals))
                    self.assertLess(vals[2] * vals[3], 0.9)
                    aspect = (vals[2] * w) / (vals[3] * h)
                    self.assertTrue(0.3 < aspect < 2.5, aspect)
                    total_boxes += 1
            self.assertGreater(total_boxes, 8 * 3)

    def test_includes_sideways_photos_and_small_images(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            out = root / "ds"
            synth_binder.generate(out, _fake_catalog(root), count=40, seed=11, split="train")
            landscape_boxes = 0
            small_images = 0
            for img in (out / "images" / "train").glob("*.jpg"):
                h, w = cv2.imread(str(img)).shape[:2]
                if max(h, w) <= 520:
                    small_images += 1
                for line in (out / "labels" / "train" / f"{img.stem}.txt").read_text().splitlines():
                    _, _, _, bw, bh = (float(v) for v in line.split())
                    if bw * w > 1.1 * bh * h:
                        landscape_boxes += 1
            self.assertGreater(landscape_boxes, 0)
            self.assertGreater(small_images, 0)

    def test_includes_single_large_card_photos(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            out = root / "ds"
            synth_binder.generate(out, _fake_catalog(root), count=40, seed=12, split="train")
            singles = 0
            for label in (out / "labels" / "train").glob("*.txt"):
                lines = label.read_text().splitlines()
                if len(lines) == 1 and float(lines[0].split()[4]) >= 0.35:
                    singles += 1
            self.assertGreater(singles, 0)

    def test_same_seed_is_deterministic(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cat = _fake_catalog(root)
            synth_binder.generate(root / "a", cat, count=2, seed=9, split="val")
            synth_binder.generate(root / "b", cat, count=2, seed=9, split="val")
            for name in ("binder_synth_9_0000.txt", "binder_synth_9_0001.txt"):
                self.assertEqual(
                    (root / "a" / "labels" / "val" / name).read_text(),
                    (root / "b" / "labels" / "val" / name).read_text(),
                )


class TiltTests(unittest.TestCase):
    def test_tilt_rotates_page_and_quads_together_without_mirrored_borders(self):
        import random

        import numpy as np

        canvas = np.full((600, 800, 3), 200, np.uint8)
        quad = np.float32([[300, 200], [420, 200], [420, 368], [300, 368]])
        canvas[200:368, 300:420] = (0, 0, 255)
        out, moved = synth_binder._tilt(canvas, [quad], random.Random(3))
        q = moved[0]
        angle = abs(np.degrees(np.arctan2(q[1][1] - q[0][1], q[1][0] - q[0][0])))
        self.assertGreaterEqual(min(angle, 180 - angle), 15)
        cx, cy = q.mean(axis=0).astype(int)
        self.assertGreater(int(out[cy, cx, 2]), 200)  # red card centre still under the moved quad
        self.assertEqual(out.shape, canvas.shape)
        corner = out[0, 0].astype(int)
        self.assertTrue(abs(int(corner[2]) - int(corner[0])) < 10)  # border is flat grey, not a reflected card


if __name__ == "__main__":
    unittest.main()
