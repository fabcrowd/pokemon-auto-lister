import copy
import os
import tempfile
import unittest

import helpers as h
from pipeline.contributions import build_samples, load_contributions, split_for, validate_contribution


class SplitRule(unittest.TestCase):
    def test_low_32_bits_mod_5(self):
        self.assertEqual(split_for("0000000000000005"), "exam")
        self.assertEqual(split_for("0000000000000001"), "teach")
        self.assertEqual(split_for("ffffffff00000005"), "exam")
        self.assertEqual(split_for("00000000ffffffff"), "exam")
        self.assertEqual(split_for("00000000fffffffe"), "teach")

    def test_helper_photo_ids_follow_the_rule(self):
        for n in range(1, 30):
            self.assertEqual(split_for(h.photo_id(n, "exam")), "exam")
            self.assertEqual(split_for(h.photo_id(n, "teach")), "teach")


class Validation(unittest.TestCase):
    def bad(self, mutate):
        it = copy.deepcopy(h.item())
        mutate(it)
        self.assertIsNotNone(validate_contribution(it))

    def test_valid_item_passes(self):
        self.assertIsNone(validate_contribution(h.item()))

    def test_rejections(self):
        self.bad(lambda i: i.update(v=2))
        self.bad(lambda i: i.update(install="nope"))
        self.bad(lambda i: i.update(split="exam"))  # photoId says teach
        self.bad(lambda i: i.update(day="2026-02-30"))
        self.bad(lambda i: i.update(extra=1))
        self.bad(lambda i: i.update(cards=[]))
        self.bad(lambda i: i["cards"][0].update(crop="aGVsbG8="))  # not JPEG
        self.bad(lambda i: i["cards"][0].update(box=[0, 0, 1.5, 1]))
        self.bad(lambda i: i["cards"][0].update(answer={"cardId": "a", "unknown": True}))
        self.bad(lambda i: i["cards"][0]["scanner"].update(stripe="huge"))
        self.bad(lambda i: i["cards"][0].update(source="auto"))
        self.bad(lambda i: i["model"].update(crop=-1))

    def test_answer_shapes(self):
        for answer in ({"cardId": "x-1"}, {"notACard": True}, {"unknown": True}):
            it = h.item(cards=[h.card(answer=answer)])
            self.assertIsNone(validate_contribution(it), answer)


class Loading(unittest.TestCase):
    def test_invalid_files_are_dropped_and_counted(self):
        with tempfile.TemporaryDirectory() as root:
            h.write_item(root, h.item(), "a.json")
            broken = h.item(photo=h.photo_id(2, "teach"))
            broken["v"] = 9
            h.write_item(root, broken, "b.json")
            with open(os.path.join(root, "contributions", "2026-10-15", "c.json"), "w") as f:
                f.write("{not json")
            items, dropped = load_contributions(root)
            self.assertEqual(len(items), 1)
            self.assertEqual(dropped, 2)

    def test_no_contributions_folder_is_empty(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(load_contributions(root), ([], 0))


class Samples(unittest.TestCase):
    def test_duplicates_by_photo_and_rounded_box_merge_and_keep_each_installs_latest_vote(self):
        p = h.photo_id(1, "teach")
        a1 = h.item(install=1, photo=p, cards=[h.card("c-1", box=(0.101, 0.2, 0.3, 0.4))])
        a2 = h.item(install=1, photo=p, day="2026-10-16", cards=[h.card("c-2", box=(0.104, 0.2, 0.3, 0.4))])
        b = h.item(install=2, photo=p, cards=[h.card("c-2", box=(0.1, 0.2, 0.3, 0.4))])
        samples = build_samples([a1, a2, b])
        self.assertEqual(len(samples), 1)
        votes = samples[0].votes
        self.assertEqual(votes[h.install_id(1)].card_id, "c-2")  # later day replaces earlier
        self.assertEqual(votes[h.install_id(2)].card_id, "c-2")

    def test_different_boxes_stay_separate(self):
        p = h.photo_id(1, "teach")
        it = h.item(photo=p, cards=[h.card("c-1", box=(0.1, 0.1, 0.3, 0.3)), h.card("c-2", box=(0.5, 0.5, 0.3, 0.3))])
        self.assertEqual(len(build_samples([it])), 2)

    def test_answers_outside_the_catalog_are_dropped(self):
        it = h.item(cards=[h.card("known-1"), h.card("gone-9", box=(0.5, 0.5, 0.2, 0.2))])
        samples = build_samples([it], valid_ids={"known-1"})
        self.assertEqual([s.key[1] for s in samples], ["0.10,0.20,0.30,0.40"])

    def test_vote_kinds(self):
        it = h.item(cards=[
            h.card(answer={"notACard": True}, box=(0.1, 0.1, 0.2, 0.2)),
            h.card(answer={"unknown": True}, box=(0.5, 0.5, 0.2, 0.2)),
        ])
        kinds = sorted(next(iter(s.votes.values())).kind for s in build_samples([it]))
        self.assertEqual(kinds, ["notACard", "unknown"])


if __name__ == "__main__":
    unittest.main()
