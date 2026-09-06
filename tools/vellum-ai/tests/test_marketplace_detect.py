"""Facebook + HiBid multi-card photos: harvest, cache, and detect."""

from __future__ import annotations

import os
import sys
import unittest
from io import BytesIO
from pathlib import Path
from typing import Dict, List

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["VELLUM_AI_DETECT_ONNX"] = "/nonexistent/model.onnx"

from vellum_ai.detect_multi import _contour_multi  # noqa: E402
from vellum_ai.eval_score import score_identity_list  # noqa: E402
from vellum_ai.marketplace_eval import (  # noqa: E402
    DEFAULT_CACHE,
    cases_by_source,
    cases_from_hibid_lotsearch,
    harvest_sniper_worklist,
    list_cached_images,
    load_manifest_cases,
    materialize_cases,
    merge_cases,
)


def _sniper_state() -> Dict:
    return {
        "worklist": {
            "facebook:111": {
                "source": "facebook",
                "title": "Binder lot",
                "imageUrl": "https://scontent.xx/fb-a.jpg",
                "imageUrls": ["https://scontent.xx/fb-a.jpg", "https://scontent.xx/fb-b.jpg"],
                "identity": {"name": "Umbreon", "number": "41", "set": "Aquapolis"},
                "photosScanned": [
                    {
                        "url": "https://scontent.xx/fb-a.jpg",
                        "identity": {"name": "Umbreon", "number": "41", "set": "Aquapolis"},
                    },
                    {
                        "url": "https://scontent.xx/fb-b.jpg",
                        "identity": {"name": "Espeon", "number": "11", "set": "Aquapolis"},
                    },
                ],
            },
            "hibid:222": {
                "source": "hibid",
                "title": "Pokemon card lot",
                "imageUrls": ["https://cdn.hibid.com/img.axd?id=1", "https://cdn.hibid.com/img.axd?id=2"],
                "identity": {"name": "Charizard", "number": "4", "setCode": "base1"},
            },
            "m123": {
                "source": "mercari",
                "imageUrl": "https://u-mercari-images.mercdn.net/photos/m123_1.jpg",
            },
        },
        "seen": {
            "facebook:333": {
                "source": "facebook",
                "imageUrls": ["https://scontent.xx/fb-c.jpg"],
                "title": "Seen lot",
            }
        },
        "hearted": {
            "hibid:444": {
                "source": "hibid",
                "imageUrl": "https://cdn.hibid.com/img.axd?id=9",
                "title": "Hearted lot",
            }
        },
    }


class TestHarvestSniperWorklist(unittest.TestCase):
    def test_keeps_facebook_and_hibid_drops_mercari(self) -> None:
        cases = harvest_sniper_worklist(_sniper_state())
        grouped = cases_by_source(cases)
        self.assertEqual(len(grouped["facebook"]), 2)
        self.assertEqual(len(grouped["hibid"]), 2)
        self.assertFalse(any(c["itemId"].startswith("m") for c in cases))
        fb = next(c for c in cases if c["itemId"] == "facebook:111")
        self.assertEqual(len(fb["imageUrls"]), 2)
        names = {i["name"] for i in fb["identities"]}
        self.assertEqual(names, {"Umbreon", "Espeon"})

    def test_hibid_lotsearch_payload_is_hibid_only(self) -> None:
        cases = cases_from_hibid_lotsearch(
            {
                "pagedResults": {
                    "results": [
                        {
                            "id": 320686833,
                            "lead": "Pokemon card lot",
                            "featuredPicture": {
                                "hdThumbnailLocation": "https://cdn.hibid.com/img.axd?id=1"
                            },
                        }
                    ]
                }
            }
        )
        self.assertEqual(len(cases), 1)
        self.assertEqual(cases[0]["source"], "hibid")
        self.assertEqual(cases[0]["itemId"], "hibid:320686833")

    def test_merge_keeps_both_sources(self) -> None:
        harvested = harvest_sniper_worklist(_sniper_state())
        manifest = [
            {
                "source": "hibid",
                "itemId": "hibid:320686833",
                "imageUrls": [],
                "expected_min_cards": 2,
            }
        ]
        merged = merge_cases(harvested, manifest)
        self.assertGreaterEqual(len(merged), 3)
        self.assertTrue(any(c["itemId"] == "hibid:320686833" for c in merged))


class TestManifestAndCache(unittest.TestCase):
    def test_cache_dir_is_repo_data_detect_marketplace(self) -> None:
        self.assertEqual(DEFAULT_CACHE.name, "detect-marketplace")
        self.assertEqual(DEFAULT_CACHE.parent.name, "data")
        self.assertTrue(
            (DEFAULT_CACHE.parent.parent / "tools" / "vellum-ai").is_dir(),
            f"cache is not under repo root: {DEFAULT_CACHE}",
        )

    def test_manifest_loads_both_sources(self) -> None:
        cases = load_manifest_cases(
            Path(__file__).resolve().parents[1] / "detect" / "marketplace_cases.json"
        )
        sources = {c["source"] for c in cases}
        self.assertIn("facebook", sources)
        self.assertIn("hibid", sources)

    def test_materialize_downloads_into_source_folders(self) -> None:
        cache = Path(self._cache_dir())
        jpeg = _tiny_jpeg()

        def opener(req, timeout=20):  # noqa: ARG001
            return BytesIO(jpeg)

        cases = harvest_sniper_worklist(_sniper_state())
        ready = materialize_cases(cases, cache, download=True, opener=opener)
        grouped = cases_by_source(ready)
        self.assertGreaterEqual(len(grouped["facebook"]), 1)
        self.assertGreaterEqual(len(grouped["hibid"]), 1)
        cached = list_cached_images(cache)
        self.assertGreaterEqual(len(cached["facebook"]), 1)
        self.assertGreaterEqual(len(cached["hibid"]), 1)

    def _cache_dir(self) -> str:
        import tempfile

        return tempfile.mkdtemp(prefix="mkt-detect-")


class TestIdentityListWeight(unittest.TestCase):
    def test_wrong_lot_identity_fails_gate(self) -> None:
        truth = [{"name": "Umbreon", "number": "41", "set": "Aquapolis"}]
        pred = [{"name": "Pikachu", "number": "25"}]
        result = score_identity_list(truth, pred)
        self.assertFalse(result["passes_gate"])
        self.assertLess(result["score"], 0.50)

    def test_recovered_verified_ids_pass_without_boxes(self) -> None:
        truth = [
            {"name": "Umbreon", "number": "41"},
            {"name": "Espeon", "number": "11"},
        ]
        pred = [
            {"name": "Umbreon", "number": "41"},
            {"name": "Espeon", "number": "11"},
        ]
        result = score_identity_list(truth, pred)
        self.assertTrue(result["passes_gate"])
        self.assertEqual(result["identity_hits"], 2)


class TestCachedFacebookDetect(unittest.TestCase):
    def test_facebook_photos_detect_multiple_cards(self) -> None:
        _assert_source_detects_multiple("facebook")


class TestCachedHibidDetect(unittest.TestCase):
    def test_hibid_photos_detect_multiple_cards(self) -> None:
        _assert_source_detects_multiple("hibid")


def _assert_source_detects_multiple(source: str) -> None:
    paths = list_cached_images(DEFAULT_CACHE)[source]
    if len(paths) < 2:
        raise unittest.SkipTest(
            f"Need >=2 cached {source} photos under data/detect-marketplace/{source}/. "
            "Facebook: run a sniper cycle then harvest. "
            "HiBid: python tools/vellum-ai/detect/harvest_marketplace.py --lotsearch"
        )
    misses: List[str] = []
    for path in paths[:6]:
        image = cv2.imread(str(path))
        if image is None:
            misses.append(f"{path.name}: unreadable")
            continue
        hits = _contour_multi(image)
        if len(hits) < 2:
            misses.append(f"{path}: detected {len(hits)}")
    if misses:
        raise AssertionError(f"{source} multi-card misses: {misses}")


def _tiny_jpeg() -> bytes:
    img = np.full((40, 40, 3), 80, dtype=np.uint8)
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return buf.tobytes()


if __name__ == "__main__":
    unittest.main()
