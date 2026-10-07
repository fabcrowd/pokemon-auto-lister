"""HP-anchor and trainer-type name extractors from OCR lines.

Ported from qtran1018/TCG backend/app/services/card_matcher.py
(_find_pokemon_name / _find_trainer_name). JP kana dictionary omitted for v1.
"""

from __future__ import annotations

import re
from typing import Optional, Sequence

HP_RE = re.compile(r"\bHP\s*(\d+)\b", re.I)

_ATTACK_BODY_RE = re.compile(
    r"^(put|this\s+attack|your\s+opponent|you\s+may|flip|discard|search|draw|"
    r"choose|look\s+at|if\s+your|once\s+during|during\s+your|when\s+you|"
    r"attach|move|switch|return|heal|remove|each\s+of|both\s+player|"
    r"the\s+defending|does\s+\d+\s+damage)",
    re.I,
)

# BASIC and OCR misreads: OASIC, DASIC, ASIC, ASIG, etc.
_POKEMON_NON_NAME_RE = re.compile(
    r"^(.{0,2}as[in][cgsq]\w*|stage\s*[12]|mega|"
    r"weakness|resistance|retreat|damage|ability|trainer|item|"
    r"stadium|supporter|energy|water|fire|grass|lightning|psychic|"
    r"fighting|darkness|metal|fairy|colorless|dragon|"
    r"pok[eé]mon|nintendo|game\s*freak|creatures|illus\.?|no\.|"
    r"copyright|overrun|aurora|beam|hp)$",
    re.I,
)

_TRAINER_TYPE_RE = re.compile(r"^(Trainer|Supporter|Item|Tool|Technical\s+Machine)$", re.I)


def find_pokemon_name(lines: Sequence[str]) -> Optional[str]:
    """Return the Pokémon name, anchored to the HP line.

    The card name sits on the same row as HP (or 1-2 lines before it).
    Attack names appear well after the HP line, so we stop searching there.
    """
    cleaned_lines = [str(l).strip() for l in lines if str(l).strip()]
    hp_idx = next((i for i, line in enumerate(cleaned_lines) if HP_RE.search(line)), None)
    # When HP is found, cap search at that line. When absent, search all —
    # attack-name guards still reject flavour text and move names.
    end = min(hp_idx + 1, 6) if hp_idx is not None else len(cleaned_lines)

    for i, line in enumerate(cleaned_lines[:end]):
        clean = HP_RE.sub("", line).strip()
        if not clean:
            continue
        words = clean.split()
        while words and _POKEMON_NON_NAME_RE.match(words[0]):
            words = words[1:]
        clean = " ".join(words)
        if len(clean) < 3:
            continue
        words = clean.split()
        if not 1 <= len(words) <= 3:
            continue
        if any(c.isdigit() for c in clean):
            continue
        # Allow possessive apostrophe ("Misty's Staryu")
        clean_for_punct = re.sub(r"(?<=\w)'s\b", "", clean)
        if re.search(r"[.,!?;:()/\\']", clean_for_punct):
            continue
        if not clean[0].isupper():
            continue
        if clean.replace(" ", "").isupper() and len(clean) > 3:
            continue
        if any(_POKEMON_NON_NAME_RE.match(w) for w in words):
            continue
        # If the next line is attack body text, this candidate is an attack name
        if hp_idx is None and i + 1 < len(cleaned_lines):
            if _ATTACK_BODY_RE.match(cleaned_lines[i + 1].strip()):
                continue
        return clean
    return None


def find_trainer_name(lines: Sequence[str]) -> Optional[str]:
    """Return Trainer/Supporter/Item name by locating the type keyword.

    Trainer cards have a standalone type line with the card name 1–2 lines above.
    Parenthetical subtitles are stripped.
    """
    cleaned_lines = [str(l).strip() for l in lines if str(l).strip()]
    for i, line in enumerate(cleaned_lines):
        if not _TRAINER_TYPE_RE.match(line.strip()):
            continue
        for j in range(max(0, i - 2), i):
            candidate = cleaned_lines[j].strip()
            candidate = re.sub(r"\s*\([^)]*\)\s*$", "", candidate).strip()
            if not candidate or len(candidate) < 3:
                continue
            words = candidate.split()
            if len(words) > 5:
                continue
            if any(c.isdigit() for c in candidate):
                continue
            if not candidate[0].isupper():
                continue
            if candidate.replace(" ", "").isupper() and len(candidate) > 3:
                continue
            clean_for_punct = re.sub(r"(?<=\w)'s\b", "", candidate)
            if re.search(r"[.,!?;:()/\\']", clean_for_punct):
                continue
            return candidate
    return None


def find_card_name(lines: Sequence[str]) -> Optional[str]:
    """Prefer Pokémon name; fall back to trainer/supporter/item."""
    return find_pokemon_name(lines) or find_trainer_name(lines)


def lines_from_ocr_text(text: str) -> list[str]:
    """Split OCR blob into non-empty lines."""
    if not text:
        return []
    # RapidOCR often joins with spaces; also accept newlines
    raw = text.replace("\r\n", "\n").replace("\r", "\n")
    if "\n" in raw:
        return [ln.strip() for ln in raw.split("\n") if ln.strip()]
    # Heuristic: split on known stage/type tokens to recover lines
    parts = re.split(
        r"\s+(?=(?:BASIC|Stage\s*[12]|HP\s*\d+|Trainer|Supporter|Item|Tool)\b)",
        raw,
        flags=re.I,
    )
    return [p.strip() for p in parts if p.strip()]
