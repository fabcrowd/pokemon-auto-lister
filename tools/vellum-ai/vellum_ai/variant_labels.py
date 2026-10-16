"""Labels a ShopGoodwill title can support for variant training.

Training pictures are photographs of physical cards. A title that describes a
lot, a scan, a proxy, or a digital image is not a label.
"""

from __future__ import annotations

import re

EDITIONS = ("first", "shadowless", "standard")
FINISHES = ("holofoil", "reverse", "normal")
STAMPS = ("none", "prerelease", "staff", "league", "setstamp")

_LOT = re.compile(
    r"\b(lots?|binder|bulk|collection|assorted|mixed|cards|pcs|pounds?|lbs|bundle)\b",
    re.IGNORECASE,
)
_NOT_A_PHOTO = re.compile(
    r"\b(scans?|prox(?:y|ies)|digital|screenshot|printable|japanese|korean|chinese|german|french|italian|spanish|sealed|topps|plush|dvd|cartridge|custom|reprints?|orica|fake|replica)\b",
    re.IGNORECASE,
)
_NON_HOLO = re.compile(r"non[-\s]?holo", re.IGNORECASE)
_REVERSE = re.compile(r"reverse(?:\s+holo|\s+foil)?", re.IGNORECASE)
_HOLO = re.compile(r"\b(holo|holofoil|foil)\b", re.IGNORECASE)
_FIRST = re.compile(r"\b1st\s*ed(?:ition|\.)?\b|\bfirst\s+edition\b", re.IGNORECASE)
_SHADOWLESS = re.compile(r"\bshadowless\b", re.IGNORECASE)
_NEGATED = re.compile(r"\b(?:not|non|no)[-\s]+(?:a\s+)?(?:1st|first|shadowless)\b", re.IGNORECASE)
_UNLIMITED = re.compile(r"unlimited", re.IGNORECASE)
_PRERELEASE = re.compile(r"pre[-\s]?release", re.IGNORECASE)
_STAFF = re.compile(r"\bstaff\b", re.IGNORECASE)
_LEAGUE = re.compile(r"league\s+(?:promo|stamp)|black\s+star\s+league", re.IGNORECASE)
# "1st Edition Stamped" names the edition stamp, not an expansion stamp.
_SETSTAMP = re.compile(r"(?<!edition )(?<!ed )\bstamped\b", re.IGNORECASE)


def variant_labels(title: str) -> dict[str, str] | None:
    """Edition, finish, and promo stamp stated by a single-card listing title.

    ``stamp`` is ``none`` when the title names an edition or a finish and does
    not mention a promo stamp. Returns None when the title is a lot, not a
    photograph, or names no variant.
    """
    text = title or ""
    if _LOT.search(text) or _NOT_A_PHOTO.search(text) or _NEGATED.search(text):
        return None
    labels: dict[str, str] = {}
    if _PRERELEASE.search(text):
        labels["stamp"] = "prerelease"
    elif _STAFF.search(text):
        labels["stamp"] = "staff"
    elif _LEAGUE.search(text):
        labels["stamp"] = "league"
    elif _SETSTAMP.search(text):
        labels["stamp"] = "setstamp"
    if _SHADOWLESS.search(text) and not _FIRST.search(text):
        labels["edition"] = "shadowless"
    elif _FIRST.search(text):
        labels["edition"] = "first"
    elif _UNLIMITED.search(text) or "stamp" in labels:
        labels["edition"] = "standard"
    holo_besides_non = _HOLO.search(_NON_HOLO.sub(" ", text))
    if _NON_HOLO.search(text) and holo_besides_non:
        return None
    if _NON_HOLO.search(text):
        labels["finish"] = "normal"
    elif _REVERSE.search(text):
        labels["finish"] = "reverse"
    elif _HOLO.search(text):
        labels["finish"] = "holofoil"
    if "edition" not in labels and "finish" not in labels and "stamp" not in labels:
        return None
    labels.setdefault("stamp", "none")
    # Sellers often leave 1st Edition or Shadowless out of a title, so silence
    # is not "standard". A reverse holo was never printed in either.
    if "edition" not in labels and labels.get("finish") == "reverse":
        labels["edition"] = "standard"
    return labels
