import importlib.util
from pathlib import Path
import unittest


DETECT_DIR = Path(__file__).resolve().parents[1] / "detect"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


eval_real = _load_module("eval_real", DETECT_DIR / "eval_real.py")


class MatchBoxesTests(unittest.TestCase):
    def test_exact_match_is_true_positive(self):
        self.assertEqual(eval_real.match_boxes([[0, 0, 10, 10]], [[0, 0, 10, 10]]), (1, 0, 0))

    def test_full_frame_box_over_grid_counts_one_fp_and_all_misses(self):
        truths = [[x, y, x + 10, y + 14] for x in (0, 12, 24) for y in (0, 16, 32)]
        self.assertEqual(eval_real.match_boxes([[0, 0, 34, 46]], truths), (0, 1, 9))

    def test_each_truth_matches_at_most_once(self):
        preds = [[0, 0, 10, 10], [1, 1, 10, 10]]
        self.assertEqual(eval_real.match_boxes(preds, [[0, 0, 10, 10]]), (1, 1, 0))

    def test_any_prediction_on_negative_is_false_positive(self):
        self.assertEqual(eval_real.match_boxes([[5, 5, 9, 9]], []), (0, 1, 0))

    def test_predictions_inside_ignore_regions_are_not_false_positives(self):
        ignore = [[100, 0, 140, 50]]
        self.assertEqual(eval_real.match_boxes([[0, 0, 10, 10], [102, 2, 130, 48]], [[0, 0, 10, 10]], ignore=ignore), (1, 0, 0))

    def test_summary_reports_precision_recall_and_negative_fp_images(self):
        rows = [
            {"tp": 9, "fp": 1, "fn": 0, "negative": False},
            {"tp": 0, "fp": 2, "fn": 0, "negative": True},
            {"tp": 0, "fp": 0, "fn": 0, "negative": True},
        ]
        s = eval_real.summarize(rows)
        self.assertAlmostEqual(s["precision"], 9 / 12)
        self.assertAlmostEqual(s["recall"], 1.0)
        self.assertEqual(s["negative_images_with_fp"], 1)
        self.assertEqual(s["negative_images"], 2)


if __name__ == "__main__":
    unittest.main()
