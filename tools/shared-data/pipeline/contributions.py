"""Loading, validating and de-duplicating contributions (schema v1, see tools/relay/src/validate.js)."""
import base64
import datetime
import json
import os
import re
from dataclasses import dataclass, field

MAX_CARDS = 30
MAX_CROP_CHARS = 40000

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_HEX16 = re.compile(r"^[0-9a-f]{16}$")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CARD_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_BASE64 = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")
_STRIPES = {"high", "medium", "low", "none"}
_SOURCES = {"pick", "wrong-card", "confirm"}


def split_for(photo_id):
    """The split a photo belongs to: low 32 bits of photoId (its last 8 hex digits) mod 5; 0 is exam."""
    return "exam" if int(photo_id[-8:], 16) % 5 == 0 else "teach"


def _in_unit(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and 0 <= x <= 1


def _valid_day(day):
    if not isinstance(day, str) or not _DAY.match(day):
        return False
    try:
        return datetime.date.fromisoformat(day).isoformat() == day
    except ValueError:
        return False


def _valid_crop(crop):
    if not isinstance(crop, str) or not 8 <= len(crop) <= MAX_CROP_CHARS or len(crop) % 4 or not _BASE64.match(crop):
        return False
    return base64.b64decode(crop[:4])[:3] == b"\xff\xd8\xff"


def _valid_answer(a):
    if not isinstance(a, dict) or len(a) != 1:
        return False
    (key, value), = a.items()
    if key == "cardId":
        return isinstance(value, str) and bool(_CARD_ID.match(value))
    return key in ("notACard", "unknown") and value is True


def _card_error(c):
    if not isinstance(c, dict) or set(c) != {"box", "crop", "answer", "scanner", "source"}:
        return "card fields"
    box = c["box"]
    if not (isinstance(box, list) and len(box) == 4 and all(_in_unit(x) for x in box) and box[2] > 0 and box[3] > 0):
        return "box"
    if not _valid_crop(c["crop"]):
        return "crop"
    if not _valid_answer(c["answer"]):
        return "answer"
    s = c["scanner"]
    if not (isinstance(s, dict) and set(s) == {"cardId", "confidence", "stripe"}):
        return "scanner"
    if s["cardId"] is not None and not (isinstance(s["cardId"], str) and _CARD_ID.match(s["cardId"])):
        return "scanner.cardId"
    if not _in_unit(s["confidence"]) or s["stripe"] not in _STRIPES:
        return "scanner values"
    if c["source"] not in _SOURCES:
        return "source"
    return None


def validate_contribution(it):
    """None when the contribution is valid, else a short reason."""
    if not isinstance(it, dict) or set(it) != {"v", "install", "split", "photoId", "day", "model", "catalog", "cards"}:
        return "fields"
    if it["v"] != 1 or isinstance(it["v"], bool):
        return "v"
    if not (isinstance(it["install"], str) and _UUID.match(it["install"])):
        return "install"
    if not (isinstance(it["photoId"], str) and _HEX16.match(it["photoId"])):
        return "photoId"
    if it["split"] != split_for(it["photoId"]):
        return "split"
    if not _valid_day(it["day"]):
        return "day"
    m = it["model"]
    if not (isinstance(m, dict) and set(m) == {"clip", "crop"} and isinstance(m["clip"], str) and _HEX16.match(m["clip"])
            and isinstance(m["crop"], int) and not isinstance(m["crop"], bool) and m["crop"] >= 0):
        return "model"
    if not (isinstance(it["catalog"], str) and _HEX16.match(it["catalog"])):
        return "catalog"
    cards = it["cards"]
    if not isinstance(cards, list) or not 1 <= len(cards) <= MAX_CARDS:
        return "cards"
    for i, c in enumerate(cards):
        err = _card_error(c)
        if err:
            return f"cards[{i}].{err}"
    return None


def load_contributions(root):
    """Every valid contribution under <root>/contributions/, ordered by (day, file name), and the count dropped."""
    base = os.path.join(root, "contributions")
    found = []
    dropped = 0
    for dirpath, _, files in os.walk(base):
        for name in files:
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(dirpath, name), encoding="utf-8") as f:
                    it = json.load(f)
            except (OSError, ValueError):
                dropped += 1
                continue
            if validate_contribution(it):
                dropped += 1
            else:
                found.append((it["day"], name, it))
    found.sort(key=lambda t: (t[0], t[1]))
    return [t[2] for t in found], dropped


@dataclass
class Vote:
    install: str
    day: str
    kind: str  # "card" | "notACard" | "unknown"
    card_id: str = None
    scanner: dict = None
    source: str = None


@dataclass
class Sample:
    """One physical crop: all installs' votes on (photoId, rounded box) merged."""
    key: tuple
    photo_id: str
    box: list
    crop: bytes
    split: str
    votes: dict = field(default_factory=dict)  # install -> latest Vote

    @property
    def card_votes(self):
        return {i: v for i, v in self.votes.items() if v.kind == "card"}


def _box_key(box):
    return ",".join(f"{x:.2f}" for x in box)


def _vote(it, c):
    a = c["answer"]
    if "cardId" in a:
        return Vote(it["install"], it["day"], "card", a["cardId"], c["scanner"], c["source"])
    return Vote(it["install"], it["day"], "notACard" if "notACard" in a else "unknown", None, c["scanner"], c["source"])


def build_samples(items, valid_ids=None, split=None):
    """Merge cards into samples keyed by (photoId, box rounded to 0.01).

    Duplicates collapse to one sample so one photo is never counted twice, but each install keeps its own vote
    (its latest by day), so agreement between installs stays visible. Votes for a card id outside valid_ids are dropped.
    """
    samples = {}
    for it in sorted(items, key=lambda i: i["day"]):
        if split and it["split"] != split:
            continue
        for c in it["cards"]:
            vote = _vote(it, c)
            if valid_ids is not None and vote.kind == "card" and vote.card_id not in valid_ids:
                continue
            key = (it["photoId"], _box_key(c["box"]))
            s = samples.get(key)
            if s is None:
                s = samples[key] = Sample(key, it["photoId"], c["box"], base64.b64decode(c["crop"]), it["split"])
            s.votes[it["install"]] = vote
    return list(samples.values())
