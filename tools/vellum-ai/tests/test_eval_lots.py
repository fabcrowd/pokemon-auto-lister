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


eval_lots = _load_module("eval_lots", DETECT_DIR / "eval_lots.py")

META = {
    "base1-4": {"name": "Charizard", "number": "4"},
    "base4-4": {"name": "Charizard", "number": "4"},
    "base1-58": {"name": "Pikachu", "number": "58"},
}
TRUTH_BOXES = [[0, 0, 10, 14], [20, 0, 30, 14], [40, 0, 50, 14]]


class ScoreImageTests(unittest.TestCase):
    def test_exact_lenient_and_priced(self):
        preds = [
            ([0, 0, 10, 14], "base1-4"),     # exact
            ([20, 0, 30, 14], "base4-4"),    # reprint: lenient only
            ([40, 0, 50, 14], "base1-58"),   # wrong card for truth None? no: truth is base1-58
        ]
        s = eval_lots.score_image(preds, TRUTH_BOXES, ["base1-4", "base1-4", "base1-58"],
                                  priced={"base1-4"}, meta=META)
        self.assertEqual(s["cards"], 3)
        self.assertEqual(s["exact"], 2)
        self.assertEqual(s["lenient"], 3)
        self.assertEqual(s["priced"], 1)
        self.assertEqual(s["detected"], 3)

    def test_unreadable_truth_counts_for_detection_only(self):
        s = eval_lots.score_image([([0, 0, 10, 14], "base1-4")], TRUTH_BOXES[:1], [None],
                                  priced=set(), meta=META)
        self.assertEqual(s["cards"], 0)
        self.assertEqual(s["detected"], 1)
        self.assertEqual(s["unreadable"], 1)

    def test_missed_and_abstained_cards_are_wrong(self):
        preds = [([0, 0, 10, 14], None)]
        s = eval_lots.score_image(preds, TRUTH_BOXES[:2], ["base1-4", "base1-58"], priced=set(), meta=META)
        self.assertEqual((s["cards"], s["exact"], s["detected"]), (2, 0, 1))

    def test_extra_detection_is_false_positive(self):
        preds = [([0, 0, 10, 14], "base1-4"), ([80, 80, 90, 94], "base1-58")]
        s = eval_lots.score_image(preds, TRUTH_BOXES[:1], ["base1-4"], priced=set(), meta=META)
        self.assertEqual(s["false_positives"], 1)

    def test_ignore_region_drops_partial_card_prediction(self):
        preds = [([0, 0, 10, 14], "base1-4"), ([100, 0, 120, 30], "base1-58")]
        s = eval_lots.score_image(preds, TRUTH_BOXES[:1], ["base1-4"], priced=set(), meta=META,
                                  ignore=[[98, 0, 125, 32]])
        self.assertEqual(s["false_positives"], 0)


class PricedIdsTests(unittest.TestCase):
    def test_only_lookups_verified_as_the_right_product_count(self):
        prices = {
            "base1-4": {"market": 310.0, "correct": True},
            "lc-18": {"market": 4.1, "correct": False},   # priced a different Venusaur
            "base1-58": {"market": None, "correct": False},
            "sv1-1": None,
        }
        self.assertEqual(eval_lots.priced_ids(prices), {"base1-4"})

    def test_identity_record_keeps_fields_pricing_needs(self):
        ident = {"name": "Venusaur", "set": "Trading Card Game Classic", "setCode": "CLV", "number": "003",
                 "productId": "label:CLV-003", "grade": "10", "imageUrl": "x"}
        self.assertEqual(eval_lots.identity_record(ident),
                         {"name": "Venusaur", "set": "Trading Card Game Classic", "number": "003"})
        self.assertIsNone(eval_lots.identity_record(None))


if __name__ == "__main__":
    unittest.main()
