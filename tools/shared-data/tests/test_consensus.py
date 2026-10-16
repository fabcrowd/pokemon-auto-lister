import unittest

import numpy as np

import helpers as h
from pipeline.contributions import build_samples
from pipeline.consensus import cap_install_share, promote


def make(specs):
    """specs: list of (install, photo_n, card_id_or_answer, basis_k). Returns samples, embeddings."""
    items = []
    for install, n, ans, k in specs:
        answer = ans if isinstance(ans, dict) else {"cardId": ans}
        items.append(h.item(install=install, photo=h.photo_id(n, "teach"), cards=[h.card(answer=answer, seed=n)]))
    samples = build_samples(items)
    by_photo = {s.photo_id: s for s in samples}
    emb = np.stack([h.unit(k, noise=0.003, seed=n) for _, n, _, k in specs])
    ordered = [by_photo[h.photo_id(n, "teach")] for _, n, _, _ in specs]
    return ordered, emb


def promoted_ids(result):
    return sorted(r.card_id for r in result.rows)


class Consensus(unittest.TestCase):
    def test_two_installs_agreeing_on_one_cluster_promote(self):
        samples, emb = make([(1, 1, "c-1", 0), (2, 2, "c-1", 0)])
        res = promote(samples, emb, [set(), set()], max_share=1.0)
        self.assertEqual(promoted_ids(res), ["c-1", "c-1"])

    def test_one_install_needs_the_label_in_the_catalog_top_20(self):
        samples, emb = make([(1, 1, "c-1", 0)])
        self.assertEqual(promoted_ids(promote(samples, emb, [{"c-1", "c-9"}], max_share=1.0)), ["c-1"])
        held = promote(samples, emb, [{"c-7"}], max_share=1.0)
        self.assertEqual(held.rows, [])
        self.assertEqual(held.stats["heldUnconfirmed"], 1)

    def test_conflicting_cards_in_one_cluster_are_held_even_with_neighbour_support(self):
        samples, emb = make([(1, 1, "c-1", 0), (2, 2, "c-2", 0)])
        res = promote(samples, emb, [{"c-1", "c-2"}, {"c-1", "c-2"}], max_share=1.0)
        self.assertEqual(res.rows, [])
        self.assertEqual(res.stats["heldConflict"], 2)

    def test_two_agree_but_a_third_disagrees_is_held(self):
        samples, emb = make([(1, 1, "c-1", 0), (2, 2, "c-1", 0), (3, 3, "c-2", 0)])
        res = promote(samples, emb, [set()] * 3, max_share=1.0)
        self.assertEqual(res.rows, [])

    def test_not_a_card_vote_counts_as_disagreement_and_unknown_does_not(self):
        samples, emb = make([(1, 1, "c-1", 0), (2, 2, {"notACard": True}, 0)])
        self.assertEqual(promote(samples, emb, [{"c-1"}, set()], max_share=1.0).rows, [])
        samples, emb = make([(1, 1, "c-1", 0), (2, 2, {"unknown": True}, 0)])
        res = promote(samples, emb, [{"c-1"}, set()], max_share=1.0)
        self.assertEqual(promoted_ids(res), ["c-1"])

    def test_different_clusters_do_not_pool_votes(self):
        samples, emb = make([(1, 1, "c-1", 0), (2, 2, "c-1", 5)])
        res = promote(samples, emb, [set(), set()], max_share=1.0)
        self.assertEqual(res.rows, [])  # each cluster has a single install and no neighbour support

    def test_only_teach_samples_are_accepted(self):
        samples, emb = make([(1, 1, "c-1", 0)])
        samples[0].split = "exam"
        with self.assertRaises(ValueError):
            promote(samples, emb, [{"c-1"}])

    def test_rows_carry_the_sample_embedding(self):
        samples, emb = make([(1, 1, "c-1", 3)])
        res = promote(samples, emb, [{"c-1"}], max_share=1.0)
        np.testing.assert_allclose(res.rows[0].embedding, emb[0])


class Cap(unittest.TestCase):
    class Row:
        def __init__(self, owner, i, multi=False):
            self.owner = owner
            self.multi = multi
            self.sample_key = (f"{i:016x}", "0.00,0.00,1.00,1.00")

    def rows(self, counts):
        return [self.Row(o, i * 1000 + j) for i, (o, n) in enumerate(counts.items()) for j in range(n)]

    def test_no_install_exceeds_its_share_of_the_kept_rows(self):
        counts = {f"i{k}": 10 for k in range(9)}
        counts["big"] = 100
        kept = cap_install_share(self.rows(counts), 0.10)
        per = {}
        for r in kept:
            per[r.owner] = per.get(r.owner, 0) + 1
        self.assertEqual(per["big"], 10)
        self.assertEqual(len(kept), 100)
        for owner, n in per.items():
            self.assertLessEqual(n / len(kept), 0.10 + 1e-9, owner)

    def test_a_balanced_pool_is_untouched(self):
        rows = self.rows({f"i{k}": 5 for k in range(10)})
        self.assertEqual(len(cap_install_share(rows, 0.10)), 50)

    def test_rows_two_installs_agreed_on_are_exempt_and_count_toward_the_total(self):
        multi = [self.Row(f"m{k % 2}", 5000 + k, multi=True) for k in range(20)]
        singles = self.rows({"a": 3})
        kept = cap_install_share(multi + singles, 0.10)
        self.assertEqual(sum(r.multi for r in kept), 20)  # none of the exempt rows is dropped
        self.assertEqual(sum(not r.multi for r in kept), 2)  # floor(10% of 22 total) = 2 singles for install a

    def test_exempt_rows_alone_are_never_capped(self):
        multi = [self.Row("m", k, multi=True) for k in range(5)]
        self.assertEqual(len(cap_install_share(multi, 0.10)), 5)

    def test_too_few_installs_cannot_meet_the_cap_so_no_single_rows_are_kept(self):
        self.assertEqual(cap_install_share(self.rows({"a": 5, "b": 5, "c": 5}), 0.10), [])

    def test_choice_of_dropped_rows_is_deterministic(self):
        counts = {f"i{k}": 10 for k in range(9)}
        counts["big"] = 100
        a = cap_install_share(self.rows(counts), 0.10)
        b = cap_install_share(list(reversed(self.rows(counts))), 0.10)
        self.assertEqual(sorted(r.sample_key for r in a), sorted(r.sample_key for r in b))

    def test_promote_exempts_two_install_agreement_and_caps_the_rest(self):
        specs = [(1, n, "c-1", n) for n in range(1, 4)] + [(2, 10, "c-1", 1)]
        samples, emb = make(specs)
        res = promote(samples, emb, [{"c-1"}] * len(specs))
        # photos 1 and 10 share a cluster and two installs agree: both rows stay. Photos 2 and 3 are single-install
        # rows: 2 of 4 would be 50% for install 1, far over 10%, so they go.
        self.assertEqual(len(res.rows), 2)
        self.assertTrue(all(r.multi for r in res.rows))
        self.assertEqual(res.stats["cappedOut"], 2)


if __name__ == "__main__":
    unittest.main()
