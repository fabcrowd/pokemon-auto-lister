# Team goals after v3.0 (2026-10-23)

Driving philosophy: a scanner earns trust when it is right when it says so, fast when it can be, and out of the way when it can't be sure. Every goal is scored on two numbers: **taps saved per correctly identified card** and **dollars lost per wrongly confirmed card**. A change that raises one without hurting the other ships; a change that trades them needs a measurement that shows the trade is worth it. No claim without a file behind it.

Roles (Opus plans and reviews, specialist Sonnet agents execute): evaluation analyst, extension engineer, release/QA engineer, research scout, blind label reviewer, ML engineer (parked: model track closed).

## Open items from the v3.0 sign-off, as goals

| # | Goal | Why (UX x accuracy) | Owner | Done when |
|---|---|---|---|---|
| G1 | Full QA drive on the exact published head | Three fixes landed after the last drive; the public must get a build that was driven end to end | release/QA | No blocker; counts, prices-on-unconfirmed, tags, flows all clean; screenshots reviewed by the PM |
| G2 | Measure what the Facebook full-size photo path gives | Photos 4 and 5 mostly ask at 960 px; the real flow fetches Facebook's original. The product claim has to rest on a measurement | evaluation + extension | A Facebook-CDN stand-in test shows confirmed cards and top-1 at the served size vs the original size; the `ctp`, site-access and 'Open full-size' paths are exercised |
| G3 | Close the real-Chrome gap | The only live check left; needs the owner's browser and listings | owner, with a checklist | Checklist in `docs/publish-v3.0.md` run on a live listing; findings fed back |
| G4 | Feature-completeness audit against the product job ("price my cards from a listing photo") | Export, condition, lot notes, history, copy: the steps after identification decide whether people finish a lot | research scout | Ranked list of missing features with taps saved per lot and the smallest design for each; no building before review |
| G5 | Speed and progress | Scans take 6 to 36 s and the popup must stay open; a person who cannot see progress assumes it is broken | extension | Cards appear as they are read, a progress line, the scan survives the popup closing; median time to first card under 3 s on a lot photo |
| G6 | Grow the labelled sets | Intervals are wide at a few hundred cards; sites with no labels (eBay) are invisible | blind reviewer + analyst | At least 300 high-confidence labelled cards, at least 40 per site, small crops over-sampled; eBay photos from the owner if provided |
| G7 | Privacy and store text for the new behaviour | The stakes rule fetches prices for candidate cards and the photo path fetches site images; the listing and policy must say so | release/QA | `docs/store/privacy-policy.md` and listing updated, reviewed against what the code sends |
| G8 | Data repo sync (pins, prices snapshot, nightly names) | Without it the shared adapter is off and prices are up to a week old | release/QA, needs a push rule for that repo | Pins match, `prices` release published, nightly mirrors the rule with real names |
| G9 | UX polish backlog | Stale message after a version swap, one overlap on dense photos, the lot-level edition control as chips, a clearer first-run explanation of Choose | extension | Each fixed test-first, screenshots reviewed |
| G10 | Pricing scope: slabs, Japanese, sealed, conditions beyond NM | A raw NM English price shown for a slab or a Japanese card is the costliest silent error left | scout then extension | Measured frequency in real lots, then a visible 'not priced' state for what we can't price |
| G12 | Corrections that stick (owner priority) | A wrong confirmation must be one-tap fixable, and the system must remember the fix AND why it got it wrong, so it does not repeat the mistake. Today the memory is off by default, its thresholds are unmeasured placeholders, and the reason is not recorded | analyst then extension | Every confirmed card carries a 'why' record (source, score, lead, read size, title agreement, tier, price) saved with any correction; positive memory first (a crop resembling a corrected one gets the corrected card weighted heavily, preselected, and confirmed with source 'your correction' when a measured similarity threshold is met) and negative memory (this wrong card is not auto-confirmed for crops like this one) work locally; a corrected row shows 'Corrected, remembered'; leave-one-out on the real labelled photos shows repeat mistakes fixed and zero new wrong confirms before the default is switched on; opt-in shared learning receives aggregated wrong->right pairs with evidence |
| G11 | Release hygiene | The release is live but `main` has none of it | release/QA | PR into `main`, store package submitted after G1 and G3 pass |

## Order and gates
1. **Now:** G1, G2, G4 (G4 is read-only), G12 design and measurement.
2. **Next:** G5, G7, G9, G6.
3. **Needs the owner:** G3 (live Chrome run), G8 (a push rule for the data repo), eBay photos for G6.
4. **After G1 and G3 pass:** G11 and the public store submission.

Rules that hold throughout: stacked cards out of scope; no price until a card is confirmed; choices are images first; every confirmed-wrong card is listed with its dollar cost; nothing is tuned on held-out sets.
