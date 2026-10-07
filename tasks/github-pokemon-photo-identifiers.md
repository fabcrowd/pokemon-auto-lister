# GitHub repos that identify Pokemon cards from photos
*Generated: 2026-09-06 | Sources: GitHub search + READMEs | Confidence: High on published methods; Low on accuracy (almost no public benchmarks)*

Companion to `tasks/jimmy-deal-finder-research.md` (apps) and `tasks/github-pokemon-deal-finders.md` (snipers). This note is **photo → card identity**, not listing-title parsers.

## Executive summary

The serious open-source identifiers all converge on the same stack this repo already runs in Vellum:

**detect / rectify → visual embedding (CLIP or hash) → OCR name/number → fuse → abstain if they disagree.**

PokeGrade is the cloud sibling. Do not replace that with OCR-only or a vision-LLM one-shot. The useful public code is in **rerank tricks, multi-card detect, and documented failure modes** (holo glare, reprint art, JP kana), not a better core algorithm.

Stars are small except [NolanAmblard/Pokemon-Card-Scanner](https://github.com/NolanAmblard/Pokemon-Card-Scanner) (65★, last code 2022) and [prateekt/pokemon-card-recognizer](https://github.com/prateekt/pokemon-card-recognizer) (30★, PyPI, still pushed 2026-05).

## 1. Methods (how they actually ID)

| Method | How | Breaks on | Best public examples |
|--------|-----|-----------|----------------------|
| **CLIP / embedding + OCR fuse** | Art vector vs catalog; collector number as a gate | Holo glare vs clean art; same art many sets | This repo Vellum; `qtran1018/TCG`; `ShreyShingala/…Webapp`; `alexwing/CardLens` |
| **OCR → pokemontcg.io / TCGdex** | Read name + `12/102`, lookup API | Glare, JP, stylized names, reprints with same number | `t-sinclair2500/pokemon-scanner`; `EldonT123/Pokemon_card_detector`; `RanaNakul/ChainCard` |
| **Perceptual hash** | pHash / Hamming vs official scans | Lighting, sleeve, perspective, holos | `NolanAmblard` (2022); `1vcian/Pokemon-TCGP-Card-Scanner`; `JustintheBox/PokemonCardDetector` |
| **Vision LLM** | Gemini / Claude / Groq describe the card | Cost, reprint collisions, no abstain | `WatsonMLDev/pokemon-cost-scraper`; Didier estimator; `pacorreia/pokemon-card-scanner` |
| **YOLO + ResNet / CNN** | Detect box, embed crop, NN search | Needs a trained catalog; student projects | `lo-calvin/Trading-Card-Scanner`; `kobozo/tcg-recognizer` |
| **Multi-game fingerprint catalog** | Corner-find, 128-d embed, HF catalog | Pokemon catalog marked experimental | `HanClinto/CollectorVision` |

Vellum’s `pipeline.py` + `fusion.py` is already CLIP top-20 + OCR + fuse + Collectr/TCG fallback + abstain. `qtran1018/TCG` is the most documented twin of that design (RRF, phash rerank, 0.50/0.65 floors).

## 2. Repos worth reading

### prateekt/pokemon-card-recognizer — 30★, PyPI
- https://github.com/prateekt/pokemon-card-recognizer — pushed 2026-05-05
- Only real **library**: `pip install pokemon-card-recognizer`, prebuilt pokemontcg.io references, easyocr (or tesseract), GPU ~5–10×.
- Modes: single image, directory, video, **pulls video**, **booster 11-card estimate**.
- Job is pack-opening video, not marketplace thumbs. GPL-3. Closest “don’t rewrite detection from scratch” if we ever need a third local engine.

### qtran1018/TCG — 0★, best write-up
- https://github.com/qtran1018/TCG — Expo + FastAPI, pushed 2026-06
- CLIP ViT-B/32 **fine-tuned on (official art, simulated photo)** pairs. Art crop = top 12–52% of the card. pgvector IVFFlat over ~47k EN+JP embeddings. **pHash rerank**. OCR via on-device ML Kit (HP line as name anchor; bottom 8% for `047/165`). RRF merge. YOLO11n multi-card. JP kana dictionary.
- They write down what we already feel: holofoil CLIP is unreliable; JP Abra/kana fails OCR; consecutive-frame gate for live scan.
- Steal: phash rerank + explicit score floors + JP number spatial crop. Do not clone the mobile stack.

### ShreyShingala/Pokemon-Card-Scanning-Webapp — 13★
- https://github.com/ShreyShingala/Pokemon-Card-Scanning-Webapp — YOLOv8 boxes → CLIP+FAISS + OCR filename sanity. Next.js camera, FastAPI. Multi-card parallel. Author notes CLIP+FAISS alone would have been faster. Same family as Vellum detect_multi.

### alexwing/CardLens — 0★, on-device
- https://github.com/alexwing/CardLens — Rust + Tauri. Classic CV crop, **MobileCLIP2-S0 ONNX**, `ocrs` name, cosine index. ~0.3s, no cloud at runtime. TCGdex prices. Conf 0.80 / margin 0.05 / OCR weight 0.35. Closest “run identify without PokeGrade” if the cloud is down.

### NolanAmblard/Pokemon-Card-Scanner — 65★ / 19 forks
- https://github.com/NolanAmblard/Pokemon-Card-Scanner — OpenCV detect + MySQL match. Last push **2022-08**. Popularity is age + homework forks, not current accuracy. Do not use as a base.

### t-sinclair2500/pokemon-scanner — 5★
- OpenCV warp + Tesseract + pokemontcg.io + optional HNSW image index. Clean folder layout. OCR-first; embedding is optional. Typical student-complete pipeline.

### lo-calvin/Trading-Card-Scanner — 7★
- YOLO11-seg (synthetic scatter) + ResNet50 embeddings vs official art + pokemontcg.io. Qualcomm-flavored course project. Same detect→embed idea, smaller catalog than CLIP+pokemontcg.io.

### DidierRLopes/pokemon-cards-value-scraper — 1★
- Claude vision → human table confirm → **reconstruct official-art grid** → price from 6 sources. Slow, high-trust. Best **lot-photo verification UX**, not a sniper ID.

### WatsonMLDev/pokemon-cost-scraper — 2★, pushed 2026-09-05
- Flutter camera → **Gemini** → TCGPlayer scrape. Live this week. LLM-only; reprint risk.

### Others (skim)

| Repo | Notes |
|------|--------|
| [HanClinto/CollectorVision](https://github.com/HanClinto/CollectorVision) | Corner dewarp + 128-d embed. `hf://HanClinto/milo/tcgplayer-pokemon` (~13 MB), labeled experimental. Multi-TCG. |
| [EldonT123/Pokemon_card_detector](https://github.com/EldonT123/Pokemon_card_detector) | YOLOv8n + Tesseract + pokemontcg.io. README admits catalog stale (~2021) and Mega Venusaur-EX is the limit. |
| [RanaNakul/ChainCard](https://github.com/RanaNakul/ChainCard) | Google Vision OCR + `12/102` regex + TCGdex. NFT mint bolted on. |
| [pacorreia/pokemon-card-scanner](https://github.com/pacorreia/pokemon-card-scanner) | Plug-in LLM (OpenAI/Groq/Ollama/Claude) + local SQLite catalog. |
| [rhanka/pokemon-cards](https://github.com/rhanka/pokemon-cards) | CardScope local-first PWA + valuation. Method thin in README. |
| [Pyronewbic/casecomp](https://github.com/Pyronewbic/casecomp) | AI **pre-grade** (8 subgrades), not marketplace ID. |
| [Leoglme/GoupixDex](https://github.com/Leoglme/GoupixDex) | Groq vision OCR → Vinted list. Sell-side cousin, Europe. |
| [1vcian/Pokemon-TCGP-Card-Scanner](https://github.com/1vcian/Pokemon-TCGP-Card-Scanner) | Pocket app screenshots: contour + RGB pHash. Different domain (digital, not physical). |
| [kobozo/tcg-recognizer](https://github.com/kobozo/tcg-recognizer) | Custom CNN + pokemontcg.io. Erasmus/MLOps wrapper. |
| [SandeepSawhney2015/Pokemon-Card-Identifier](https://github.com/SandeepSawhney2015/Pokemon-Card-Identifier) | CLIP+FAISS + EXIF/phone-photo preprocess + occlusion heatmap. No OCR gate. |
| [jayusharora/QuickSlab](https://github.com/jayusharora/QuickSlab) | PSA **slab** inventory, not raw-card art match. |
| [danyeaw/whos-that-pokemon](https://github.com/danyeaw/whos-that-pokemon) | PyScript demo. |

Empty/name-only: `efekaankrhn-PRO/pokecard-identifier`.

## 3. Vs this repo

| Layer | This repo | Typical OSS | Implication |
|-------|-----------|-------------|-------------|
| Detect | Vellum contour / `detect_multi` + JS `splitMultiCard` | YOLO8/11 or OpenCV quad | Same job; YOLO may win on messy table photos |
| Rectify | Warp + glare/blur/centering QA | Often skip QA | Keep QA; CardLens/qtran also score confidence |
| Visual ID | Vellum CLIP index **or** PokeGrade API | CLIP/FAISS or pHash | Already in the winning family |
| Text ID | OCR number/set + Collectr/TCG fallback | Tesseract / ML Kit / Gemini | Same |
| Fuse | `fuse_candidates` + require OCR + abstain | qtran RRF; Shrey OCR sanity | Add **pHash rerank** if CLIP ties reprints |
| Dual | PokeGrade ⊕ Vellum conflict → Needs Review | Almost nobody dual-models | Keep. Unique. |
| Output | Mercari list / sniper skip | Collection CSV / Discord | Different product |

Commercial apps (TCGPlayer, Collectr, PriceCharting, Pokeval, Eyevo) still own camera UX. OSS does not beat them on a public leaderboard. Our edge is **dual ID + sell/sniper wiring**, not a new embedding.

## 4. What to steal (small)

1. **pHash rerank of CLIP top-K** (`qtran1018/TCG`) — cheap, helps holo/lighting. Fits `_identify_rectified` after `index.search`.
2. **Spatial OCR** — name above HP; number in bottom 8%. We already have glued-number regexes; crop-first may beat whole-card Tesseract on lots.
3. **Score floors + margin** — CardLens 0.80 / 0.05; qtran 0.50 discard / 0.65 confident. Align with Vellum abstain so sniper `photoConfirmsCard` stays strict.
4. **Didier reconstruct-grid** — for multi-card HiBid/Facebook lots, show official art next to each crop before a human hearts.
5. **CollectorVision Pokemon catalog** — optional third local matcher, only if PokeGrade is down and Vellum index is cold. Experimental; don’t bet the pipeline on it.

Do **not**: swap to Gemini-only; fork Nolan 2022; pull prateekt into the sniper loop (GPL + video-oriented + heavy).

## Sources

- `gh search repos` / `gh repo view` on 2026-09-06 (stars, push dates).
- READMEs: prateekt, qtran1018/TCG, ShreyShingala, CardLens, t-sinclair2500, NolanAmblard, Didier, WatsonMLDev, CollectorVision, EldonT123, ChainCard, lo-calvin.
- Local: `tools/vellum-ai/vellum_ai/pipeline.py`, `fusion.py`, `src/identify/resolver.js`.
