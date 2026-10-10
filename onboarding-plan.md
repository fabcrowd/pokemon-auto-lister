# Onboarding plan — novice install UX

**Problem.** A fresh install today works on paper but has three novice-hostile cliffs:

1. The setup overlay only says "Download models." Nothing teaches the user what to do next or that better pricing exists.
2. The ⚙ icon leads to a Settings page that's a form, not an explainer — a novice doesn't know what "PokemonPriceTracker API key" means or why they'd want one.
3. The local-backend path assumes the user is a Node developer. Novices will never, ever use it.

**Goal.** First install → first useful scan in under 60 seconds. By scan #3, the user has either upgraded to PPT or made a conscious choice not to. The backend is invisible unless the user already uses the full dashboard.

**Non-goal.** Convincing everyone to install the dashboard. The dashboard is an advanced add-on and should stay quiet unless the Settings page is open.

---

## 1. First-run flow

Replace the current "Download models" setup overlay with a **3-step wizard**. User can't skip ahead, but each step is simple and visible — no modal nagging, no tour tooltips over the extension UI.

### Step 1 — "Download the AI models"
Same as today but with better copy and a time estimate.

```
┌───────────────────────────────────────┐
│          CARD SCANNER                 │
│                                       │
│          ●─ ○ ─ ○                     │   ← step dots
│                                       │
│   Download the AI models              │
│                                       │
│   One-time, ~140 MB, 1–3 minutes.     │
│   Runs fully on your computer.        │
│                                       │
│         [ Download models ]           │
│                                       │
└───────────────────────────────────────┘
```

Auto-advance to step 2 when the current progress bars all hit 100%. No "Next" button to click.

### Step 2 — "Try your first scan"
Launches a canned demo so the user *sees* value before being asked for anything.

```
┌───────────────────────────────────────┐
│          ✓─ ●─ ○                      │
│                                       │
│   Try your first scan                 │
│                                       │
│   We'll open a sample page with real  │
│   Pokémon cards. Click Scan Page to   │
│   see the overlay in action.          │
│                                       │
│      [ Open the demo page ]           │
│                                       │
│      [ Skip and scan myself ]         │
│                                       │
└───────────────────────────────────────┘
```

Clicking **Open the demo page** opens `chrome-extension://.../demo.html` (bundled with the extension — 6 real card images, same as the test page we already have in `.tmp/testpage/`) in a new tab and automatically closes the setup overlay. The popup now shows the normal UI with a toast: "Click SCAN PAGE to try it →"

Why this step matters: a novice's biggest fear is "does this thing work?" Showing a successful scan in 10 seconds answers that before they're asked to do anything.

### Step 3 — "Unlock full prices" (optional, framed positively)

```
┌───────────────────────────────────────┐
│          ✓─ ✓─ ●                      │
│                                       │
│   One more thing — unlock full prices │
│                                       │
│   Right now you'll see one price per  │
│   card from pokemontcg.io.            │
│                                       │
│   Add a free PokemonPriceTracker key  │
│   to also see:                        │
│   • NM / LP / MP / HP / DMG prices   │
│   • Graded prices (PSA / BGS / CGC)  │
│                                       │
│   Takes 30 seconds and no credit card.│
│                                       │
│    [ Get free key → ]                 │
│                                       │
│    [ I'll do this later ]             │
│                                       │
└───────────────────────────────────────┘
```

Clicking **Get free key →** opens two tabs:
1. `https://www.pokemonpricetracker.com/api-keys` (signup)
2. The extension's Options page, scrolled to the PPT section with the input focused

Clicking **I'll do this later** closes the wizard. The ⚙ icon in the popup header stays visible so they can come back any time, and the popup shows a dismissible single-line hint at the bottom:
> `💡 Add a free API key to see NM/LP/MP/HP/DMG prices · Settings`

(The hint only shows while the user is on pokemontcg.io source. Disappears forever once they add a key OR dismiss it.)

---

## 2. Ongoing UX — teaching through the scan loop

Even for users who skipped Step 3, every scan should quietly remind them that there's more.

### Popup pricing-source pill
Currently each result row shows a tiny `POKEMONTCG` / `PPT` / `BACKEND` badge. Promote this to a **single pill in the header** that shows the dominant source for the last scan.

```
pokemontcg → amber dot      [MARKET ONLY]
ppt        → green dot      [FULL GRID]
backend    → purple dot     [PRO MODE]
```

Click the pill → opens the Options page with the "Pricing sources" section anchored. Tooltip on hover explains what each level unlocks.

### Rate-limit visibility (PPT users)
Once the user has a PPT key, show a tiny counter in the header: `72/100 today`. When it hits 10 remaining, flip to amber. At 0 remaining, show a red pill with "Upgrade to Pro" (links to PPT's pricing page). Prevents the mysterious "why do my prices look worse today" moment.

### Spread warning on the FIRST ambiguous card
First time a scan returns a card with `spreadRatio > 10` (e.g. Base Set Charizard: $4 Pocket vs $38k 1st Ed), show a *one-time* explainer tooltip over the ⚠ chip:

> This card has multiple printings with very different prices. If your copy is different from the one shown, click the Printing dropdown to pick the right one.

Dismiss once, never show again. Stored in `chrome.storage.sync` as `tipsSeen.spread = true`.

---

## 3. Options page redesign

Current page is a stark form. Rebuild as **source cards** with clear status + CTAs.

```
┌─────────────────────────────────────────────────────┐
│   Pricing sources                                   │
│                                                     │
│   The scanner picks the best source available.      │
│                                                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│   ○  pokemontcg.io                [ALWAYS ON]       │
│      Single market price per card. Free, no setup.  │
│                                                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│   ✓  PokemonPriceTracker                            │
│      ─────────────────────                          │
│      Full NM/LP/MP/HP/DMG + PSA/BGS/CGC prices.     │
│      Free: 100 cards/day. Paid plans from $9.99/mo. │
│                                                     │
│      Status: connected · 72/100 today               │
│                                                     │
│      [ Change key ]  [ Disconnect ]                 │
│                                                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│   ▸ Advanced: Local dashboard (optional)            │   ← collapsed
│                                                     │
└─────────────────────────────────────────────────────┘
```

Three source cards, in priority order. States for each:
- `[ALWAYS ON]` for pokemontcg.io
- `○ NOT CONNECTED` / `✓ CONNECTED` for PPT
- Collapsed-by-default accordion for the dashboard

### PPT card — not connected state
```
○  PokemonPriceTracker
   ─────────────────────
   Full NM/LP/MP/HP/DMG + PSA/BGS/CGC prices.
   Free: 100 cards/day. No credit card required.

   1. Click the button below to open signup
   2. Create an account (30 seconds)
   3. Copy your API key from the dashboard
   4. Paste it here

   [ Open PokemonPriceTracker signup → ]

   ┌─────────────────────────────────────────────┐
   │ Paste API key here                          │
   └─────────────────────────────────────────────┘

   [ Save and test ]
```

The **Save and test** button not only saves the key but immediately fires a probe request (price for a known card like `base1-4`). On success, the card flips to the connected state with a checkmark. On failure, show the exact error ("Invalid key" vs "Network error" vs "Rate limit exceeded").

### Advanced accordion — only expanded if the backend is already reachable
If `GET http://127.0.0.1:3000/api/health` responds, auto-expand with:
```
▾  Advanced: Local dashboard                 ✓ CONNECTED
   
   Pokemon-auto-lister dashboard detected at http://127.0.0.1:3000
   with JustTCG priceGrid enabled. Prices use this source first.
```

If NOT reachable, keep collapsed. If expanded by click:
```
▾  Advanced: Local dashboard

   For developers running the pokemon-auto-lister dashboard.
   Serves JustTCG per-condition prices via a local proxy.

   Status: not reachable (http://127.0.0.1:3000)

   [ See installation instructions ]      ← links to repo README
```

This hides the backend from novices entirely while making it one click to recognize for devs who already have it running.

---

## 4. Discoverability + help

### "What's this?" link in the popup footer
A single `?` icon in the lower-right of the popup, next to the version number. Opens a short help modal (not a separate tab) with:
- 3-sentence "how it works"
- Troubleshooting: no cards detected, overlay missing, wrong prices
- Link to INSTALL.md, link to GitHub issues

### Error states route to help, not dead ends
When a scan fails, the message bar should include an action link. Examples:

| Error | Current message | Proposed message |
|---|---|---|
| No scannable tab | `No scannable tab — open a webpage first` | `No scannable tab. Open a page with cards and try again.` |
| Models not loaded | `Models not loaded` | `Models not downloaded yet. [ Setup → ]` |
| PPT key invalid | (silent fallback) | `Pricing key invalid. [ Fix in Settings → ]` |
| Backend 500 | (silent fallback) | `Local backend failed — using fallback source. [ What's this? ]` |

---

## 5. Technical implementation sketch (not now, but when we build it)

### New files
- `dist/extension-wasm/wizard.html` + `wizard.js` — replaces the current `.setup-overlay` block
- `dist/extension-wasm/demo.html` + `dist/extension-wasm/demo-cards/` — bundled sample cards
- `dist/extension-wasm/help.html` — static help modal content

### State
Store wizard progress in `chrome.storage.sync.onboarding = { step: 1|2|3|'done', tipsSeen: { spread: true } }` so a user who closes and reopens picks up where they left off.

### Minimal manifest change
Add `web_accessible_resources` entry for `demo-cards/*` so the demo page can load the bundled card images.

### Backward compat
Users who already installed the extension before this change ship: on next popup open, check if `onboarding.step` is set. If not, assume they're beyond onboarding (set to `'done'`) and show the hint strip instead.

---

## 6. What NOT to build (yet)

- **Tooltip tours over the live UI.** Intrusive, hard to translate, novices click through without reading. The 3-step wizard replaces them.
- **Account signup inside the extension.** We proxy to PPT's signup. Our product has no accounts, keep it that way.
- **"Recommend prices" opinion.** We show what sources return. We don't editorialize ("this card is worth…"). That's a trust risk and a legal risk.
- **Social features (share scans, compare collections).** Scope creep. The extension is one job: scan + price.

---

## 7. Rollout order

If building this in waves:

1. **Wave 1 — the hint strip + source pill**. One day's work. Converts curious users without a flow redesign. Zero risk.
2. **Wave 2 — Options page redesign + Save-and-test**. Two days. Fixes the "I pasted a key, nothing happened" trap.
3. **Wave 3 — 3-step wizard + demo page**. Week-ish. The real conversion lift.
4. **Wave 4 — rate-limit counter + first-time spread tooltip**. Nice-to-have polish.

Build in that order and the first PR already improves things. Don't block the whole plan on the wizard.
