"""TEACH consensus: which user labels are trustworthy enough to become pack rows.

Crops are grouped into clusters of near-identical embeddings (the same card seen in several photos). In a
cluster, every install's vote is one of: a card id, "not a card", or "unknown".

A cluster is *clean* when no two votes disagree. "Not a card" disagrees with every card id; "unknown" is an
abstention and disagrees with nothing. Anything not clean is held, whole: a single dissenting install
blocks the cluster rather than being outvoted, which is the safe direction for a pack that other people's
scanners will trust.

A clean cluster's card id is promoted when
  * at least two distinct installs voted for it, or
  * one install did and the id is also among the catalog's top-20 neighbours of that crop.
Rows promoted by the neighbour rule alone are capped: no install may own more than `max_share` of the promoted
rows (see cap_install_share). Rows two installs agreed on are exempt; the exam gate is the real safety check.
"""
import hashlib
import math
from dataclasses import dataclass, field

import numpy as np

CLUSTER_SIM = 0.95
MAX_INSTALL_SHARE = 0.10


@dataclass
class PackRow:
    card_id: str
    embedding: np.ndarray
    owner: str
    sample_key: tuple
    multi: bool = False  # two or more distinct installs voted for this card on this cluster


@dataclass
class Promotion:
    rows: list
    stats: dict = field(default_factory=dict)


def cluster(embeddings, threshold=CLUSTER_SIM, block=1024):
    """Cluster index per row: rows linked by cosine >= threshold (directly or through others) share one."""
    n = len(embeddings)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    emb = np.asarray(embeddings, dtype=np.float32)
    for start in range(0, n, block):
        sims = emb[start : start + block] @ emb.T
        rows, cols = np.nonzero(sims >= threshold)
        for r, c in zip(rows, cols):
            a, b = find(start + int(r)), find(int(c))
            if a != b:
                parent[max(a, b)] = min(a, b)
    return [find(i) for i in range(n)]


def _owner(sample, card_id):
    voters = [v for v in sample.votes.values() if v.kind == "card" and v.card_id == card_id]
    return min(voters, key=lambda v: (v.day, v.install)).install


def _order_key(row):
    return hashlib.sha256(f"{row.sample_key[0]}|{row.sample_key[1]}".encode()).hexdigest()


def cap_install_share(rows, max_share=MAX_INSTALL_SHARE):
    """Caps single-install rows so no install owns more than max_share of all promoted rows.

    Rows that two or more installs agreed on (row.multi) are exempt: they are never dropped, but they count
    in the total. Dropping single rows lowers the total, which lowers every install's allowance, so it repeats
    until stable. Which rows go is decided by a hash of the sample key, so the result does not depend on input order.
    """
    exempt = [r for r in rows if r.multi]
    by_owner = {}
    for row in rows:
        if not row.multi:
            by_owner.setdefault(row.owner, []).append(row)
    for owned in by_owner.values():
        owned.sort(key=_order_key)
    counts = {o: len(r) for o, r in by_owner.items()}
    while True:
        total = len(exempt) + sum(counts.values())
        allowed = math.floor(max_share * total + 1e-9)
        over = {o: allowed for o, c in counts.items() if c > allowed}
        if not over:
            break
        counts.update(over)
    return exempt + [row for o, owned in by_owner.items() for row in owned[: counts[o]]]


def promote(samples, embeddings, neighbours, cluster_sim=CLUSTER_SIM, max_share=MAX_INSTALL_SHARE):
    """TEACH samples -> promoted pack rows.

    samples: Sample objects, all split "teach"; embeddings: matching (n, 512) unit vectors;
    neighbours: per sample, the set of card ids in the catalog's top-20 for that crop.
    """
    if any(s.split != "teach" for s in samples):
        raise ValueError("only teach samples may be promoted")
    stats = {"samples": len(samples), "clusters": 0, "heldConflict": 0, "heldUnconfirmed": 0, "cappedOut": 0}
    groups = {}
    for i, c in enumerate(cluster(embeddings, cluster_sim) if len(samples) else []):
        groups.setdefault(c, []).append(i)
    stats["clusters"] = len(groups)

    rows = []
    for members in groups.values():
        votes = [v for i in members for v in samples[i].votes.values() if v.kind != "unknown"]
        labelled = [i for i in members if samples[i].card_votes]
        if not votes:
            continue
        ids = {v.card_id for v in votes if v.kind == "card"}
        if len(ids) != 1 or any(v.kind == "notACard" for v in votes):
            stats["heldConflict"] += len(labelled)
            continue
        card_id = next(iter(ids))
        installs = {v.install for v in votes}
        for i in labelled:
            if len(installs) >= 2 or card_id in neighbours[i]:
                rows.append(PackRow(card_id, np.asarray(embeddings[i], dtype=np.float32), _owner(samples[i], card_id), samples[i].key, len(installs) >= 2))
            else:
                stats["heldUnconfirmed"] += 1

    kept = cap_install_share(rows, max_share)
    stats["cappedOut"] = len(rows) - len(kept)
    kept.sort(key=lambda r: (r.card_id, _order_key(r)))
    return Promotion(kept, stats)
