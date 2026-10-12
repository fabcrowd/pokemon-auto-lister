import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


DETECT_DIR = Path(__file__).resolve().parents[1] / "detect"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


label_marketplace = _load_module("label_marketplace", DETECT_DIR / "label_marketplace.py")
retrain = _load_module("retrain", DETECT_DIR / "retrain.py")


class ReviewedMarketplaceLabelsTests(unittest.TestCase):
    def test_marketplace_import_requires_explicit_review(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            image = Path(temp_dir) / "listing.jpg"
            image.touch()
            sidecar = image.with_suffix(".json")
            sidecar.write_text(json.dumps({"boxes": [[1, 2, 20, 30]]}), encoding="utf-8")
            self.assertIsNone(label_marketplace._read_reviewed_sidecar(image))

            sidecar.write_text(json.dumps({"reviewed": True, "boxes": []}), encoding="utf-8")
            self.assertEqual(label_marketplace._read_reviewed_sidecar(image), {"reviewed": True, "boxes": []})

    def test_retrain_ignores_unreviewed_harvest_and_keeps_reviewed_negatives(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            unreviewed = root / "frame_000001.jpg"
            reviewed = root / "frame_000002.jpg"
            unreviewed.touch()
            reviewed.touch()
            unreviewed.with_suffix(".json").write_text(json.dumps({"boxes": [[1, 2, 20, 30]]}), encoding="utf-8")
            reviewed.with_suffix(".json").write_text(json.dumps({"reviewed": True, "boxes": []}), encoding="utf-8")

            self.assertEqual(retrain._load_harvest_frames(root), [reviewed])

    def test_real_photo_gate_requires_floor_and_no_regression(self):
        self.assertTrue(retrain._passes_real_gate(new_f1=0.95, baseline_f1=0.15))
        self.assertFalse(retrain._passes_real_gate(new_f1=0.85, baseline_f1=0.15))
        self.assertFalse(retrain._passes_real_gate(new_f1=0.92, baseline_f1=0.96))
        # No reviewed real photos → cannot certify → do not promote.
        self.assertFalse(retrain._passes_real_gate(new_f1=None, baseline_f1=None))


class IngestReviewedPhotosTests(unittest.TestCase):
    def test_only_train_lots_ingested_with_unique_names_and_ignore_greyed(self):
        import cv2
        import numpy as np

        with tempfile.TemporaryDirectory() as tmp:
            src, root = Path(tmp) / "hibid", Path(tmp) / "ds"
            def photo(lot, side):
                d = src / lot
                d.mkdir(parents=True, exist_ok=True)
                cv2.imwrite(str(d / "00.jpg"), np.full((100, 200, 3), 30, np.uint8))
                (d / "00.json").write_text(json.dumps(side))
            photo("325000003", {"reviewed": True, "boxes": [[10, 10, 60, 80]], "ignore": [[150, 0, 200, 100]]})
            photo("325000004", {"reviewed": True, "boxes": [[0, 0, 50, 70]]})
            photo("325000001", {"reviewed": True, "boxes": [[0, 0, 50, 70]]})  # held-out test lot (id % 10 = 1)
            photo("325000005", {"reviewed": True, "boxes": [[0, 0, 50, 70]], "split": "dev"})
            photo("325000006", {"boxes": [[0, 0, 50, 70]]})  # not reviewed
            photo("325000007", {"reviewed": True, "boxes": [[0, 0, 50, 70]], "split": "test2"})  # any named holdout

            n = retrain.ingest_reviewed_photos(src, root)
            self.assertEqual(n, 2)
            names = sorted(p.name for p in (root / "images" / "train").iterdir())
            self.assertEqual(names, ["hibid_325000003_00.jpg", "hibid_325000004_00.jpg"])
            img = cv2.imread(str(root / "images" / "train" / "hibid_325000003_00.jpg"))
            self.assertGreater(int(img[50, 175].mean()), 100)  # ignore region greyed out
            self.assertLess(int(img[50, 30].mean()), 60)
            label = (root / "labels" / "train" / "hibid_325000003_00.txt").read_text().split()
            self.assertEqual(label[0], "0")


class AugmentNegativesTests(unittest.TestCase):
    def test_empty_label_images_get_transformed_negative_copies(self):
        import cv2
        import numpy as np

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "images" / "train").mkdir(parents=True)
            (root / "labels" / "train").mkdir(parents=True)
            cv2.imwrite(str(root / "images" / "train" / "frame_1.jpg"), np.full((400, 600, 3), 90, np.uint8))
            (root / "labels" / "train" / "frame_1.txt").write_text("")
            cv2.imwrite(str(root / "images" / "train" / "card_1.jpg"), np.full((400, 600, 3), 90, np.uint8))
            (root / "labels" / "train" / "card_1.txt").write_text("0 0.5 0.5 0.2 0.3\n")

            n = retrain.augment_negatives(root, seed=1)
            self.assertEqual(n, 4)
            made = sorted(p.stem for p in (root / "images" / "train").glob("frame_1__*.jpg"))
            self.assertEqual(made, ["frame_1__dark", "frame_1__half", "frame_1__quarter", "frame_1__tilt"])
            for stem in made:
                self.assertEqual((root / "labels" / "train" / f"{stem}.txt").read_text(), "")
            self.assertEqual(retrain.augment_negatives(root, seed=1), 0)  # idempotent: copies are not re-augmented


if __name__ == "__main__":
    unittest.main()
