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


review = _load_module("review_proposals", DETECT_DIR / "review_proposals.py")

PROPOSAL = [[0, 0, 10, 14], [20, 0, 30, 14], [40, 0, 50, 14]]


class ApplyDecisionTests(unittest.TestCase):
    def test_ok_accepts_all_proposals(self):
        self.assertEqual(review.apply_decision("ok", PROPOSAL), PROPOSAL)

    def test_neg_is_reviewed_empty(self):
        self.assertEqual(review.apply_decision("neg", PROPOSAL), [])

    def test_skip_excludes_image(self):
        self.assertIsNone(review.apply_decision("skip", PROPOSAL))

    def test_drop_and_add_combine(self):
        boxes = review.apply_decision("drop:0,2 add:[60,0,70,14] add:[1,2,3,4]", PROPOSAL)
        self.assertEqual(boxes, [[20, 0, 30, 14], [60, 0, 70, 14], [1, 2, 3, 4]])

    def test_ignore_moves_boxes_out_of_truth(self):
        self.assertEqual(review.apply_decision("ignore:0", PROPOSAL), PROPOSAL[1:])
        self.assertEqual(review.ignored_boxes("ignore:0 drop:1", PROPOSAL), [PROPOSAL[0]])
        self.assertEqual(review.ignored_boxes("ok", PROPOSAL), [])

    def test_unknown_token_raises(self):
        with self.assertRaises(ValueError):
            review.apply_decision("maybe", PROPOSAL)

    def test_write_reviewed_sidecars_never_touches_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("a", "b"):
                (root / f"{name}.jpg").touch()
                (root / f"{name}.proposal.json").write_text(json.dumps({"boxes": PROPOSAL}))
            written = review.write_reviewed(root, {"a.jpg": "drop:1", "b.jpg": "skip"}, note="test")
            self.assertEqual(written, 1)
            meta = json.loads((root / "a.json").read_text())
            self.assertEqual(meta["reviewed"], True)
            self.assertEqual(meta["boxes"], [[0, 0, 10, 14], [40, 0, 50, 14]])
            self.assertFalse((root / "b.json").exists())
            self.assertEqual(meta["ignore"], [])


class PendingTests(unittest.TestCase):
    def test_only_limits_to_listed_unlabelled_images(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for rel in ("1/00.jpg", "1/01.jpg", "2/00.jpg", "3/00.jpg"):
                (root / rel).parent.mkdir(exist_ok=True)
                (root / rel).write_bytes(b"x")
            (root / "3/00.json").write_text("{}")
            got = [q.relative_to(root).as_posix() for q in review._pending(root, {"1/00.jpg", "3/00.jpg"})]
            self.assertEqual(got, ["1/00.jpg"])
            self.assertEqual(len(review._pending(root, None)), 3)


if __name__ == "__main__":
    unittest.main()
