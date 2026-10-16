"""Near-duplicate photos of one card stay on one side of the split."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import torch
import torch.nn as nn
from PIL import Image

from vellum_ai import dhash, set_symbol, variant_train  # noqa: E402
from vellum_ai.variant_labels import EDITIONS, FINISHES, STAMPS  # noqa: E402


def _gray(array: np.ndarray) -> Image.Image:
    return Image.fromarray(array.astype(np.uint8), "L")


def _blocks() -> Image.Image:
    array = np.zeros((80, 90), np.uint8)
    for r in range(8):
        for c in range(9):
            array[r * 10:(r + 1) * 10, c * 10:(c + 1) * 10] = (c * 37 + r * 91) % 200 + 20
    return _gray(array)


def _card(seed: int) -> Image.Image:
    rng = np.random.default_rng(seed)
    small = rng.integers(0, 256, (24, 18, 3), dtype=np.uint8)
    return Image.fromarray(small).resize((180, 240), Image.NEAREST)


class DhashParityTests(unittest.TestCase):
    """Expected strings come from scripts/lib/dhash.mjs on the same pixels."""

    def test_horizontal_ramp(self) -> None:
        array = np.tile(np.linspace(255, 0, 90), (80, 1))
        self.assertEqual(dhash.dhash_hex(_gray(array)), "ffffffffffffffff")

    def test_alternating_bands(self) -> None:
        array = np.zeros((80, 90))
        for c in range(9):
            array[:, c * 10:(c + 1) * 10] = 200 if c % 2 == 0 else 40
        self.assertEqual(dhash.dhash_hex(_gray(array)), "aaaaaaaaaaaaaaaa")

    def test_top_ramp_down_bottom_ramp_up(self) -> None:
        ramp = np.tile(np.linspace(255, 0, 90), (40, 1))
        array = np.concatenate([ramp, ramp[:, ::-1]])
        self.assertEqual(dhash.dhash_hex(_gray(array)), "ffffffff00000000")

    def test_irregular_blocks(self) -> None:
        self.assertEqual(dhash.dhash_hex(_blocks()), "0420841082104208")

    def test_hamming_counts_differing_bits(self) -> None:
        self.assertEqual(dhash.hamming(0b1011, 0b0001), 2)
        self.assertEqual(dhash.hamming(0, (1 << 64) - 1), 64)


class ClusterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.crops = Path(self.tmp.name) / "crops"
        self.crops.mkdir()
        self.cache = Path(self.tmp.name) / "cache.json"

    def _save(self, name: str, image: Image.Image, quality: int = 90) -> dict:
        image.save(self.crops / name, quality=quality)
        return {"listing": name.split("_")[0], "file": name}

    def _split_apart_pair(self) -> tuple[str, str]:
        ids = [str(300000000 + n) for n in range(200)]
        a = ids[0]
        b = next(i for i in ids if variant_train.is_holdout(i) != variant_train.is_holdout(a))
        return a, b

    def test_reshot_listing_joins_the_original_cluster(self) -> None:
        a, b = self._split_apart_pair()
        photo = _card(1)
        noisy = np.asarray(photo, dtype=np.int16) + np.random.default_rng(9).integers(-6, 7, (240, 180, 3))
        rows = [
            self._save(f"{a}_00.jpg", photo, 95),
            self._save(f"{b}_00.jpg", Image.fromarray(np.clip(noisy, 0, 255).astype(np.uint8)), 60),
        ]
        clusters = dhash.listing_clusters(rows, self.crops, self.cache)
        self.assertEqual(clusters[a], clusters[b])
        self.assertEqual(clusters[a], min(a, b))
        train, val, holdout = variant_train.split_rows(rows, clusters)
        parts = [{r["listing"] for r in part} for part in (train, val, holdout)]
        self.assertEqual(sum(1 for part in parts if part), 1)

    def test_distinct_cards_can_land_in_different_splits(self) -> None:
        a, b = self._split_apart_pair()
        rows = [self._save(f"{a}_00.jpg", _card(1)), self._save(f"{b}_00.jpg", _card(2))]
        clusters = dhash.listing_clusters(rows, self.crops, self.cache)
        self.assertNotEqual(clusters[a], clusters[b])
        _, _, holdout = variant_train.split_rows(rows, clusters)
        self.assertEqual(len(holdout), 1)

    def test_chain_of_near_duplicates_is_one_cluster(self) -> None:
        rows = []
        for n in range(3):
            array = np.asarray(_blocks()).astype(np.int16)
            array[:, 10 * (n + 1) - 1: 10 * (n + 1)] = 250 if n % 2 else 5
            rows.append(self._save(f"{300 + n}_00.png", _gray(array)))
        clusters = dhash.listing_clusters(rows, self.crops, self.cache, max_distance=64)
        self.assertEqual(len(set(clusters.values())), 1)

    def test_listing_with_two_photos_links_clusters_through_either(self) -> None:
        rows = [
            self._save("111_00.jpg", _card(1)),
            self._save("111_01.jpg", _card(2)),
            self._save("222_00.jpg", _card(2)),
        ]
        clusters = dhash.listing_clusters(rows, self.crops, self.cache)
        self.assertEqual(clusters["111"], clusters["222"])

    def test_rows_without_a_file_are_their_own_cluster(self) -> None:
        rows = [{"listing": "5", "file": "missing.jpg"}]
        self.assertEqual(dhash.listing_clusters(rows, self.crops, self.cache), {"5": "5"})
        self.assertFalse(self.cache.exists())

    def test_cache_skips_unchanged_files_and_rehashes_changed_ones(self) -> None:
        rows = [self._save("1_00.jpg", _card(1))]
        dhash.listing_clusters(rows, self.crops, self.cache)
        stored = json.loads(self.cache.read_text(encoding="utf-8"))
        self.assertIn("1_00.jpg", stored)
        with mock.patch.object(dhash, "dhash_image", side_effect=AssertionError("rehashed")):
            dhash.listing_clusters(rows, self.crops, self.cache)
        path = self.crops / "1_00.jpg"
        stat = path.stat()
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
        with mock.patch.object(dhash, "dhash_image", wraps=dhash.dhash_image) as spy:
            dhash.listing_clusters(rows, self.crops, self.cache)
        self.assertEqual(spy.call_count, 1)

    def test_set_symbol_split_follows_clusters(self) -> None:
        a, b = self._split_apart_pair()
        rows = [{"listing": a, "file": "x"}, {"listing": b, "file": "y"}]
        together = {a: min(a, b), b: min(a, b)}
        train, holdout = set_symbol.split_symbol_rows(rows, together)
        self.assertEqual(len(train) + len(holdout), 2)
        self.assertIn(len(train), (0, 2))


class _Stub(nn.Module):
    def __init__(self, heads: tuple[int, int, int]) -> None:
        super().__init__()
        self.heads = heads

    def forward(self, images: torch.Tensor):
        out = []
        for size in self.heads:
            logits = torch.zeros(images.shape[0], size)
            logits[:, 0] = 1.0
            out.append(logits)
        return tuple(out)


class _FixedDataset(torch.utils.data.Dataset):
    def __init__(self, rows, train=False) -> None:
        self.rows = rows

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index):
        return torch.zeros(3, 4, 4), torch.tensor(self.rows[index]["targets"])


class MinSupportTests(unittest.TestCase):
    def test_class_entry_below_threshold_is_null_and_flagged(self) -> None:
        entry = variant_train.class_entry(support=5, correct=4, predicted=6)
        self.assertEqual(entry, {"support": 5, "correct": 4, "recall": None, "precision": None, "tooFew": True})

    def test_class_entry_at_threshold_reports_numbers(self) -> None:
        entry = variant_train.class_entry(support=30, correct=24, predicted=32)
        self.assertEqual(entry["recall"], 0.8)
        self.assertEqual(entry["precision"], 0.75)
        self.assertNotIn("tooFew", entry)

    def test_zero_predictions_leave_precision_null(self) -> None:
        entry = variant_train.class_entry(support=40, correct=0, predicted=0)
        self.assertEqual(entry["recall"], 0.0)
        self.assertIsNone(entry["precision"])

    def test_holdout_report_marks_small_classes(self) -> None:
        rows = [{"targets": [0, 0, -1]}] * 30 + [{"targets": [1, 0, -1]}] * 5
        with mock.patch.object(variant_train, "CropDataset", _FixedDataset):
            report = variant_train.holdout_report(
                _Stub((len(EDITIONS), len(FINISHES), len(STAMPS))), rows, torch.device("cpu")
            )
        editions = report["heads"]["edition"]["classes"]
        self.assertNotIn("tooFew", editions[EDITIONS[0]])
        self.assertEqual(editions[EDITIONS[0]]["recall"], 1.0)
        self.assertTrue(editions[EDITIONS[1]]["tooFew"])
        self.assertIsNone(editions[EDITIONS[1]]["recall"])
        self.assertEqual(editions[EDITIONS[1]]["support"], 5)

    def test_selection_pass_can_disable_the_floor(self) -> None:
        rows = [{"targets": [0, 0, -1]}] * 5
        with mock.patch.object(variant_train, "CropDataset", _FixedDataset):
            report = variant_train.holdout_report(
                _Stub((len(EDITIONS), len(FINISHES), len(STAMPS))), rows, torch.device("cpu"), min_support=0
            )
        self.assertEqual(report["heads"]["edition"]["classes"][EDITIONS[0]]["recall"], 1.0)

    def test_too_few_lists_head_and_class(self) -> None:
        report = {"heads": {"edition": {"classes": {"a": {"tooFew": True}, "b": {}}}}}
        self.assertEqual(variant_train.too_few_classes(report), ["edition/a"])

    def test_set_symbol_report_marks_small_classes(self) -> None:
        rows = [{"label": "base"}] * 30 + [{"label": "rocket"}] * 3

        class Data(_FixedDataset):
            def __getitem__(self, index):
                return torch.zeros(1, 4, 4), set_symbol.CLASSES.index(self.rows[index]["label"])

        class Model(nn.Module):
            def forward(self, images):
                logits = torch.zeros(images.shape[0], len(set_symbol.CLASSES))
                logits[:, 0] = 1.0
                return logits

        with mock.patch.object(set_symbol, "SymbolDataset", Data):
            report = set_symbol._report(Model(), rows)
        self.assertEqual(report["classes"]["base"]["recall"], 1.0)
        self.assertTrue(report["classes"]["rocket"]["tooFew"])
        self.assertIsNone(report["classes"]["rocket"]["recall"])
        self.assertTrue(report["classes"]["jungle"]["tooFew"])


if __name__ == "__main__":
    unittest.main()
