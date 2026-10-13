"""Read grading-slab labels (PSA-style) and resolve them to catalog cards.

A slab label states year, set abbreviation, card number and name, e.g.
``2023 POKEMON CLV EN #003 VENUSAUR GEM MT 10``. That is authoritative for the
exact print, which pixels cannot be: the 2023 Classic decks reuse original
artwork, so visual matching lands on the Legendary Collection reprint.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .local_verify import is_digital_only

_YEAR = re.compile(r"^\s*((?:19|20)\d{2})")
_NUMBER = re.compile(r"^#\s*([A-Za-z]*\d+[A-Za-z]*)$")
_GRADE = re.compile(r"^(10|[1-9](?:\.5)?)$")
_CERT = re.compile(r"^\d{7,}$")
_GRADE_WORDS = {
    "GEMMT", "GEMMINT", "MINT", "NMMT", "NM-MT", "NM", "EXMT", "EX-MT", "EX", "VGEX", "VG-EX", "VG",
    "GOOD", "FAIR", "PR", "PRISTINE", "AUTHENTIC", "PSA", "PA",
}
_LANG_SUFFIX = re.compile(r"(EN|JP|JAPANESE|ENGLISH)$")
# PSA appends the finish to the name ("KOGA-HOLO", "HAUNTER-REV.FOIL") and prefixes rarity ("FA/MIMIKYU").
_NAME_SUFFIX = re.compile(r"[-\s]*(HOLO|REV\.?\s*FOIL|REV(ERSE)?\.?\s*HOLO|1ST\s*EDITION|SHADOWLESS)$", re.I)
_NAME_PREFIX = re.compile(r"^(FA|SR|AR|SAR|IR|SIR)/", re.I)
# Promo sets run for years; PSA prints the card's own year, not the set's start year.
_PROMO_SET = re.compile(r"p$")

# PSA set abbreviations → TCGdex set ids, only where the catalog has the set.
SET_CODES = {
    "BASE": "base1", "BASESET": "base1", "BASEII": "base4", "BASESET2": "base4", "JUNGLE": "base2",
    "FOSSIL": "base3", "TEAMROCKET": "base5", "GYMHEROES": "gym1", "GYMCHALLENGE": "gym2",
    "LEGENDARYCOLLECTION": "lc", "POR": "me03", "MEW": "sv03.5", "151": "sv03.5",
}

# Out-of-catalog PSA codes → the set name pricing sources use, so a label id prices the labelled product.
LABEL_SET_NAMES = {"CLV": "Trading Card Game Classic", "CLB": "Trading Card Game Classic",
                   "CLC": "Trading Card Game Classic"}


def _key(text: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


def _norm_number(value: Any) -> str:
    s = str(value or "").lower().split("/")[0].strip()
    return s.lstrip("0") or "0"


def parse_label(lines: Sequence[str]) -> Optional[Dict[str, Any]]:
    tokens = [str(t).strip() for t in lines if str(t).strip()]
    header_idx = next((i for i, t in enumerate(tokens) if "POKEMON" in t.upper().replace("É", "E")), None)
    number_idx = next((i for i, t in enumerate(tokens) if _NUMBER.match(t.replace(" ", ""))), None)
    if header_idx is None or number_idx is None:
        return None
    header = tokens[header_idx].upper().replace("É", "E")
    year = _YEAR.match(header[:4].replace("O", "0") + header[4:])
    after = re.sub(r"\s+", "", header.split("POKEMON", 1)[1]).replace("GAME", "")
    set_code = _LANG_SUFFIX.sub("", after) or None

    # Reading order is unreliable (OCR sorts by box top), so classify tokens by content.
    name = grade = cert = None
    extras: List[str] = []
    for i, t in enumerate(tokens):
        if i in (header_idx, number_idx):
            continue
        squashed = t.replace(" ", "").upper()
        if _CERT.match(squashed):
            cert = squashed
        elif _GRADE.match(squashed):
            grade = squashed
        elif squashed in _GRADE_WORDS or squashed.isdigit():
            continue
        elif name is None:
            name = t
        elif set_code is None:
            set_code = squashed
        else:
            extras.append(squashed)
    if name is None:
        return None
    name = _NAME_PREFIX.sub("", _NAME_SUFFIX.sub("", name.strip()))
    return {
        "year": year.group(1) if year else None,
        "set_code": set_code,
        "number": _NUMBER.match(tokens[number_idx].replace(" ", "")).group(1),
        "name": name.title(),
        "name_key": _key(name),
        "grade": grade,
        "cert": cert,
        "extras": extras,
    }


# PSA prints the set release year; a slack of 1 let 2022 Pokemon GO claim 2023 Classic labels.
_YEAR_SLACK = 0


def _year_fits(set_code: Any, label_year: Optional[str], set_years: Optional[Mapping[str, int]]) -> bool:
    if not label_year or not set_years or set_code not in set_years or _PROMO_SET.search(str(set_code)):
        return True
    return abs(int(set_years[set_code]) - int(label_year)) <= _YEAR_SLACK


def resolve_label(
    parsed: Dict[str, Any],
    meta: Sequence[Dict[str, Any]],
    set_years: Optional[Mapping[str, int]] = None,
) -> Optional[Dict[str, Any]]:
    """Catalog identity for a parsed label; a ``label:`` id only for an uncatalogued Classic set.

    ``set_years`` (setCode → release year) rejects same-name/number reprints from other
    eras, e.g. a 2023 Classic Charizard #003 is neither Legendary Collection nor Secret Wonders.
    """
    number = _norm_number(parsed["number"])
    matches = [
        m for m in meta
        if _key(m.get("name")) == parsed["name_key"] and _norm_number(m.get("number")) == number
        and not is_digital_only(m.get("id")) and _year_fits(m.get("setCode"), parsed.get("year"), set_years)
    ]
    want_set = SET_CODES.get(str(parsed.get("set_code") or ""))
    if want_set:
        in_set = [m for m in matches if m.get("setCode") == want_set]
        if not in_set:
            # Number alone is only safe when the set has no card by the name that was read.
            # A clear "Venusaur" plus a misread #16 must not become Zapdos.
            name_in_set = [
                m for m in meta
                if m.get("setCode") == want_set and _key(m.get("name")) == parsed["name_key"]
            ]
            if not name_in_set:
                in_set = [m for m in meta if m.get("setCode") == want_set and _norm_number(m.get("number")) == number]
        matches = in_set or matches
    if len(matches) > 1:
        # The variety line often names the set outright ("EVOLUTIONS", "HIDDENFATES").
        extra_keys = [_key(x) for x in parsed.get("extras") or []]
        named = [m for m in matches if _key(m.get("set")) and _key(m.get("set")) in extra_keys]
        matches = named or matches
    grading = {"grade": parsed.get("grade"), "cert": parsed.get("cert"), "gradingCompany": "PSA"}
    if len(matches) == 1:
        m = matches[0]
        return {"name": m.get("name"), "set": m.get("set"), "setCode": m.get("setCode"),
                "number": m.get("number"), "productId": m.get("id"), "game": "pokemon", **grading}
    if not matches and parsed.get("set_code") in LABEL_SET_NAMES:
        code = parsed["set_code"]
        return {"name": parsed["name"], "set": LABEL_SET_NAMES[code], "setCode": code, "number": parsed["number"],
                "productId": f"label:{code}-{parsed['number']}", "game": "pokemon", "outOfCatalog": True, **grading}
    return None


def label_lines(ocr_result: Optional[List[Any]]) -> List[str]:
    """Text lines from a RapidOCR result list ([[box, text, score], ...])."""
    return [r[1] for r in (ocr_result or []) if len(r) > 1]
