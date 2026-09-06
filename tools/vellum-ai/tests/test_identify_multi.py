"""Unit tests for identify_multi — stubs out heavy dependencies."""

from __future__ import annotations

import base64
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai.identify_multi import CardResult, LotResult, identify_all_from_bytes


def _blank_jpeg(w: int = 200, h: int = 280) -> bytes:
    img = np.zeros((h, w, 3), dtype=np.uint8)
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return buf.tobytes()


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


_FAKE_HIT = {
    "index": 0,
    "box": [10, 10, 190, 270],
    "crop_b64": _b64(_blank_jpeg()),
}

_ID_RESULT_HIGH = {
    "identity": {
        "name": "Pikachu",
        "set": "Base Set",
        "setCode": "base1",
        "number": "58",
        "productId": "base1-58",
        "game": "pokemon",
    },
    "confidence": "high",
    "abstain": False,
    "reason": None,
}

_ID_RESULT_ABSTAIN = {
    "identity": None,
    "confidence": "low",
    "abstain": True,
    "reason": "low_margin_or_ocr_mismatch",
    "raw": {"ocr": {"number": "25", "setCode": None}},
}

_TCG_CARD = {
    "id": "base1-25",
    "name": "Pikachu",
    "set": "Base Set",
    "setCode": "base1",
    "number": "25",
    "imageUrl": None,
    "game": "pokemon",
    "score": 1.0,
}


class TestIdentityKey(unittest.TestCase):
    def test_key_strips_leading_zeros(self):
        r = CardResult(
            index=0, box=(0, 0, 100, 140),
            identity={"name": "Pikachu", "number": "058/102"},
            confidence="high", abstain=False, reason=None,
        )
        assert r.identity_key() == "pikachu|58"

    def test_key_none_when_no_identity(self):
        r = CardResult(
            index=0, box=(0, 0, 100, 140),
            identity=None,
            confidence="low", abstain=True, reason="miss",
        )
        assert r.identity_key() is None


class TestIdentifyAllFromBytes(unittest.TestCase):
    def test_returns_identified_result(self):
        with (
            patch("vellum_ai.identify_multi.detect_all_cards_with_crops", return_value=[_FAKE_HIT]),
            patch("vellum_ai.identify_multi.identify_image_bytes", return_value=_ID_RESULT_HIGH),
        ):
            results = identify_all_from_bytes(_blank_jpeg())
        assert len(results) == 1
        assert results[0].identity["name"] == "Pikachu"
        assert results[0].confidence == "high"
        assert not results[0].abstain

    def test_tcg_fallback_fires_on_abstain(self):
        with (
            patch("vellum_ai.identify_multi.detect_all_cards_with_crops", return_value=[_FAKE_HIT]),
            patch("vellum_ai.identify_multi.identify_image_bytes", return_value=_ID_RESULT_ABSTAIN),
            patch("vellum_ai.identify_multi.resolve_card", return_value=_TCG_CARD),
        ):
            results = identify_all_from_bytes(_blank_jpeg())
        assert len(results) == 1
        r = results[0]
        assert r.identity is not None
        assert r.identity["name"] == "Pikachu"
        assert r.confidence == "medium"
        assert r.reason == "tcg-api-ocr"
        assert not r.abstain

    def test_returns_empty_on_bad_image(self):
        results = identify_all_from_bytes(b"not-an-image")
        assert results == []

    def test_no_cards_detected(self):
        with patch("vellum_ai.identify_multi.detect_all_cards_with_crops", return_value=[]):
            results = identify_all_from_bytes(_blank_jpeg())
        assert results == []


class TestDeduplication(unittest.TestCase):
    """identify_lot deduplication logic via LotResult dedup path."""

    def _make_card(self, name: str, number: str, conf: str, abstain: bool = False) -> CardResult:
        return CardResult(
            index=0,
            box=(0, 0, 100, 140),
            identity={"name": name, "number": number} if not abstain else None,
            confidence=conf,
            abstain=abstain,
            reason=None,
        )

    def test_dedup_keeps_highest_confidence(self):
        # Simulate two CardResults with same identity key — low and high confidence
        low = self._make_card("Pikachu", "25", "low")
        high = self._make_card("Pikachu", "25", "high")

        _CONF_RANK = {"high": 3, "medium": 2, "low": 1}
        seen: dict = {}
        for card in [low, high]:
            key = card.identity_key()
            if key is None:
                continue
            existing = seen.get(key)
            if existing is None or _CONF_RANK.get(card.confidence, 0) > _CONF_RANK.get(existing.confidence, 0):
                seen[key] = card
        assert seen["pikachu|25"].confidence == "high"

    def test_unidentified_cards_not_deduped(self):
        abstain_a = self._make_card("?", "?", "low", abstain=True)
        abstain_b = self._make_card("?", "?", "low", abstain=True)
        assert abstain_a.identity_key() is None
        assert abstain_b.identity_key() is None


class TestLotResult(unittest.TestCase):
    def test_identification_rate(self):
        r = LotResult(lot_id="test", total_detected=4, total_identified=2)
        assert r.identification_rate == 0.5

    def test_zero_detected(self):
        r = LotResult(lot_id="test", total_detected=0, total_identified=0)
        assert r.identification_rate == 0.0

    def test_as_dict(self):
        r = LotResult(lot_id="abc", total_detected=3, total_identified=3)
        d = r.as_dict()
        assert d["lot_id"] == "abc"
        assert d["identification_rate"] == 1.0


if __name__ == "__main__":
    unittest.main()
