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


if __name__ == "__main__":
    unittest.main()
