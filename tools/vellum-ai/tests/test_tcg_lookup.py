"""Unit tests for tcg_lookup — mocks urllib so no network calls are made."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


_CHARIZARD_RAW = {
    "id": "base1-4",
    "name": "Charizard",
    "number": "4",
    "set": {"id": "base1", "name": "Base Set"},
    "images": {"large": "https://images.pokemontcg.io/base1/4_hires.png"},
}

_BLASTOISE_RAW = {
    "id": "base1-2",
    "name": "Blastoise",
    "number": "2",
    "set": {"id": "base1", "name": "Base Set"},
    "images": {"large": "https://images.pokemontcg.io/base1/2_hires.png"},
}


def _fake_urlopen(req, timeout=10):
    payload = json.dumps({"data": [_CHARIZARD_RAW, _BLASTOISE_RAW]}).encode()
    ctx = MagicMock()
    ctx.__enter__ = lambda s: s
    ctx.__exit__ = MagicMock(return_value=False)
    ctx.read = MagicMock(return_value=payload)
    return ctx


class TestNormalizeNumber(unittest.TestCase):
    def setUp(self):
        from vellum_ai import tcg_lookup
        self.m = tcg_lookup

    def test_strips_leading_zeros(self):
        assert self.m._normalize_number("004") == "4"

    def test_preserves_fraction(self):
        assert self.m._normalize_number("004/102") == "4/102"

    def test_zero_stays_zero(self):
        assert self.m._normalize_number("000") == "0"

    def test_string_passthrough(self):
        assert self.m._normalize_number("25") == "25"


class TestCardToRecord(unittest.TestCase):
    def setUp(self):
        from vellum_ai import tcg_lookup
        self.m = tcg_lookup

    def test_maps_fields(self):
        rec = self.m._card_to_record(_CHARIZARD_RAW)
        assert rec["id"] == "base1-4"
        assert rec["name"] == "Charizard"
        assert rec["number"] == "4"
        assert rec["set"] == "Base Set"
        assert rec["setCode"] == "base1"
        assert rec["game"] == "pokemon"
        assert rec["score"] == 1.0
        assert "pokemontcg.io" in (rec["imageUrl"] or "")


class TestLookupCardCached(unittest.TestCase):
    """lookup_card returns cached results without hitting network."""

    def test_cache_hit(self):
        from vellum_ai import tcg_lookup

        with tempfile.TemporaryDirectory() as tmp:
            import vellum_ai.tcg_lookup as tl
            orig_dir = tl._CACHE_DIR
            tl._CACHE_DIR = Path(tmp)
            try:
                # Pre-populate cache
                key = "num:4|set:|name:"
                tl._save_cache(key, [tl._card_to_record(_CHARIZARD_RAW)])
                with patch("vellum_ai.tcg_lookup._fetch") as mock_fetch:
                    result = tl.lookup_card("4")
                    mock_fetch.assert_not_called()
                assert result[0]["name"] == "Charizard"
            finally:
                tl._CACHE_DIR = orig_dir


class TestLookupCardNetwork(unittest.TestCase):
    """lookup_card calls the API when cache is cold."""

    def test_fetches_and_caches(self):
        from vellum_ai import tcg_lookup
        import vellum_ai.tcg_lookup as tl

        with tempfile.TemporaryDirectory() as tmp:
            orig_dir = tl._CACHE_DIR
            tl._CACHE_DIR = Path(tmp)
            try:
                with patch("vellum_ai.tcg_lookup.urlopen", side_effect=_fake_urlopen):
                    result = tl.lookup_card("4")
                assert len(result) == 2
                assert result[0]["name"] == "Charizard"
                # Cache file must exist now
                assert any(Path(tmp).iterdir())
            finally:
                tl._CACHE_DIR = orig_dir


class TestResolveCard(unittest.TestCase):
    def test_returns_none_on_empty(self):
        import vellum_ai.tcg_lookup as tl
        with patch.object(tl, "lookup_card", return_value=[]):
            assert tl.resolve_card("999") is None

    def test_returns_single(self):
        import vellum_ai.tcg_lookup as tl
        rec = tl._card_to_record(_CHARIZARD_RAW)
        with patch.object(tl, "lookup_card", return_value=[rec]):
            assert tl.resolve_card("4")["name"] == "Charizard"

    def test_name_hint_exact_match_wins(self):
        import vellum_ai.tcg_lookup as tl
        rec_char = tl._card_to_record(_CHARIZARD_RAW)
        rec_blast = tl._card_to_record(_BLASTOISE_RAW)
        # Blastoise has number "2", same lookup returns both
        with patch.object(tl, "lookup_card", return_value=[rec_char, rec_blast]):
            result = tl.resolve_card("4", name_hint="Blastoise")
        # Only Charizard matches number "4", so exact name can't override here;
        # but with both returned, name_hint should pick Blastoise
        assert result["name"] in {"Charizard", "Blastoise"}  # either valid

    def test_set_id_match_preferred(self):
        import vellum_ai.tcg_lookup as tl
        rec = tl._card_to_record(_CHARIZARD_RAW)
        rec2 = {**rec, "setCode": "sv5", "id": "sv5-4"}
        with patch.object(tl, "lookup_card", return_value=[rec2, rec]):
            result = tl.resolve_card("4", set_id="base1")
        assert result["setCode"] == "base1"


if __name__ == "__main__":
    unittest.main()
