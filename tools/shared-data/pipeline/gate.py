"""The one gate: does the candidate bundle beat the live bundle on the fixed regression set, hold on the exam,
and add no wrong "high" reads? Replays search + fusion like exam.score_exam, but with the adapter in the loop.

candidate / live: dicts of optional parts {"memory": pack bytes or Pack, "adapter": adapter.bin bytes, "check": ignored
here: it drops false boxes and does not change what a card is answered}. exam / regression: (embeddings, card ids)
like regression.load_regression. The adapter maps the query and every catalog row; memory rows are compared with the
raw query and must beat the RAW catalog top score (lib/references.js applyMemory does the same). An answer that the adapter or memory changed is advisory, never "high" (self-learning plan, "One gate").
"""
import numpy as np

from .catalog import Catalog
from .exam import TOP_K, is_high
from .pack import Pack, read_pack
from .train_adapter import apply_adapter, parse_adapter

MIN_EXAM_CASES = 30
REF_MIN, REF_MARGIN = 0.93, 0.02  # exam.score_exam defaults (lib/references.js)


def _memory(part):
    if part is None:
        return [], np.zeros((0, 512), dtype=np.float32)
    pack = part if isinstance(part, Pack) else read_pack(part)
    return pack.card_ids, pack.dequantized()


def _replay(parts, embeddings, truths, catalog):
    """(right, wrong_high) counts for one bundle."""
    if len(truths) == 0:
        return 0, 0
    embeddings = np.asarray(embeddings, dtype=np.float32).reshape(-1, 512)
    raw_idx, raw_scores = catalog.top_k_batch(embeddings, TOP_K)
    cat, q = catalog, embeddings
    if parts.get("adapter") is not None:
        adapter = parse_adapter(parts["adapter"])
        cat = Catalog(apply_adapter(adapter, catalog.vectors), catalog.ids)
        q = apply_adapter(adapter, embeddings)
    idx, scores = cat.top_k_batch(q, TOP_K)
    mem_ids, mem_vecs = _memory(parts.get("memory"))
    right = wrong_high = 0
    for i, truth in enumerate(truths):
        top_ids = [cat.ids[j] for j in idx[i]]
        predicted = top_ids[0]
        high = is_high(raw_scores[i]) and predicted == catalog.ids[raw_idx[i][0]]
        if len(mem_ids):
            sims = mem_vecs @ embeddings[i]
            best = int(np.argmax(sims))
            if sims[best] >= REF_MIN and sims[best] - raw_scores[i][0] >= REF_MARGIN and mem_ids[best] in top_ids:
                predicted, high = mem_ids[best], False
        right += predicted == truth
        wrong_high += high and predicted != truth
    return right, wrong_high


def _rate(count, n):
    return round(count / n, 4) if n else 0.0


def evaluate(candidate, live, exam, regression, catalog):
    reg_emb, reg_ids = regression
    exam_emb, exam_ids = exam
    right, wrong_high = {}, {}
    for label, parts in (("after", candidate), ("before", live)):
        reg_right, reg_wh = _replay(parts, reg_emb, reg_ids, catalog)
        ex_right, ex_wh = _replay(parts, exam_emb, exam_ids, catalog)
        right[label] = (reg_right, ex_right)
        wrong_high[label] = _rate(reg_wh + ex_wh, len(reg_ids) + len(exam_ids))
    n_reg, n_exam = len(reg_ids), len(exam_ids)
    improved = (
        n_reg > 0 and right["after"][0] > right["before"][0]
        and wrong_high["after"] <= wrong_high["before"]
        and (n_exam < MIN_EXAM_CASES or right["after"][1] >= right["before"][1])
    )
    return {
        "improved": bool(improved),
        "regression": {"before": _rate(right["before"][0], n_reg), "after": _rate(right["after"][0], n_reg), "n": n_reg},
        "exam": {"before": _rate(right["before"][1], n_exam), "after": _rate(right["after"][1], n_exam), "n": n_exam},
        "wrongHigh": wrong_high,
    }
