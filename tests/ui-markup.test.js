import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const html = readFileSync(path.join('public', 'index.html'), 'utf8');
const js = readFileSync(path.join('public', 'app.js'), 'utf8');
const css = readFileSync(path.join('public', 'styles.css'), 'utf8');

test('top nav and plain listings title are present', () => {
  assert.match(html, /class="app-topbar"/);
  assert.match(html, /Autolist/);
  assert.match(html, /href="#scanner-panel"/);
  assert.match(html, /href="#inbox-panel"/);
  assert.match(html, /href="#listings-panel"/);
  assert.match(html, /href="#needs-review-panel"/);
  assert.match(html, /href="#scalper-panel"/);
  assert.match(html, /href="#research-panel"/);
  assert.match(html, /Your listings/);
  assert.match(html, /id="listings-panel"/);
});

test('status copy mentions LIVE MODE and ±5% drift', () => {
  assert.match(html, /LIVE MODE/);
  assert.match(html, /±5%/);
});

test('inbox panel has Connect Mercari/eBay, Download photos, Add new cards', () => {
  assert.match(html, /id="connect-mercari-btn"/);
  assert.match(html, /id="connect-ebay-btn"/);
  assert.match(html, /id="connect-collectrics-btn"/);
  assert.match(html, /Connect to Collectrics/);
  assert.match(html, /id="download-photos-btn"/);
  assert.match(html, /id="add-new-cards-btn"/);
  assert.match(html, /id="rescan-inbox-btn"/);
  assert.match(html, /id="rescan-prices-btn"/);
  assert.match(html, /Connect to Mercari/);
  assert.match(html, /Connect to eBay/);
  assert.match(js, /forceRescan:\s*true/);
  assert.doesNotMatch(html, /id="photo-input"/);
});

test('scanner panel uploads photos and posts /api/scan', () => {
  assert.match(html, /id="scanner-panel"/);
  assert.match(html, /pokedex-shell/);
  assert.match(html, /POKÉDEX/);
  assert.match(html, /CARD SCAN/);
  assert.match(html, /id="scanner-files"/);
  assert.match(html, /id="scanner-pick-btn"/);
  assert.match(html, /id="scanner-run-btn"/);
  assert.match(html, /Choose photos/);
  assert.match(html, /Oxanium/);
  assert.match(html, /Figtree/);
  assert.match(js, /\/api\/scan/);
  assert.match(js, /bindScannerUi/);
  assert.match(js, /pricingSources/);
  assert.match(js, /is-scanning/);
  assert.match(js, /is-lit/);
  assert.match(css, /\.pokedex-shell/);
  assert.match(css, /\.pokedex-screen/);
  assert.match(css, /\.scanner-thumbs/);
  assert.match(css, /\.scanner-comps/);
});

test('marketplace checkboxes default to both checked', () => {
  assert.match(html, /id="marketplace-mercari"[^>]*checked/);
  assert.match(html, /id="marketplace-ebay"[^>]*checked/);
});

test('listings table has POSTED, MARKET, DELTA, HEALTH, STATUS columns', () => {
  assert.match(html, /class="draft-activity-table"/);
  assert.match(html, />POSTED</);
  assert.match(html, />MARKET</);
  assert.match(html, />DELTA</);
  assert.match(html, />HEALTH</);
  assert.match(html, />STATUS</);
  assert.match(html, /id="draft-activity-body"/);
});

test('stats strip has live, drafts, total value, queue, needs review, errors, all-time', () => {
  for (const id of [
    'stat-listed',
    'stat-drafts',
    'stat-total-value',
    'stat-queue',
    'stat-needs-review',
    'stat-errors',
    'stat-all-time',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('viewport meta tag is present for phone usability', () => {
  assert.match(html, /name="viewport"/);
});

test('index.html links styles.css and app.js', () => {
  assert.match(html, /href="\/?styles\.css"/);
  assert.match(html, /src="\/?app\.js"/);
});

test('app.js polls /api/stats and /api/cards without full page reload', () => {
  assert.match(js, /setInterval/);
  assert.match(js, /\/api\/stats/);
  assert.match(js, /\/api\/cards/);
});

test('app.js connects Mercari/eBay and scans inbox / downloads photos', () => {
  assert.match(js, /\/api\/mercari\/connect/);
  assert.match(js, /\/api\/ebay\/connect/);
  assert.match(js, /\/api\/collectrics\/connect/);
  assert.match(js, /\/api\/collectrics\/status/);
  assert.match(js, /\/api\/mercari\/status/);
  assert.match(js, /\/api\/ebay\/status/);
  assert.match(js, /\/api\/inbox\/scan/);
  assert.match(js, /\/api\/inbox\/download-photos/);
  assert.match(js, /refreshMarketplaceStatus/);
  assert.match(js, /method:\s*['"]POST['"]/);
});

test('styles.css defines the calm ops shell and phone-friendly layout', () => {
  assert.match(css, /max-width/);
  assert.match(css, /\.app-topbar/);
  assert.match(css, /\.panel-title/);
  assert.match(css, /\.draft-activity-table/);
  assert.match(css, /Figtree/);
});

test('needs review section shows identity, comps, reason, and actions', () => {
  assert.match(html, /class="needs-review-list"/);
  assert.match(html, /id="needs-review-body"/);
  assert.match(html, /Needs Review/);
  assert.match(js, /cardLabel/);
  assert.match(js, /reviewReason/);
  assert.match(js, /\['Collectr'/);
  assert.match(js, /TCGPlayer market/);
  assert.match(js, /JustTCG market/);
  assert.match(js, /PokéWallet market/);
  assert.match(js, /RapidAPI TCG market/);
  assert.match(js, /eBay last~5 sold median/);
  assert.match(js, /\/api\/cards\/\$\{[^}]+\}\/photo\?index=/);
  assert.match(js, /photos\/roles/);
  assert.match(js, /Set front/);
  assert.match(js, /Set back/);
  assert.match(js, /Choose front from local inbox/);
  assert.match(js, /front-from-inbox/);
  assert.match(js, /Browse inbox photos/);
  assert.match(css, /\.nr-photo-strip/);
  assert.match(css, /\.nr-inbox-photo-grid/);
});

test('app.js polls collectr status for api-v2 and CSV banner modes', () => {
  assert.match(js, /\/api\/collectr-status/);
  assert.match(js, /refreshCollectrBanner/);
  assert.match(js, /status\.mode === ['"]api-v2['"]/);
  assert.match(js, /COLLECTR_TOKEN/);
  assert.match(html, /id="collectr-banner"/);
});

test('app.js polls identity status for VellumAI solo / dual banner', () => {
  assert.match(js, /\/api\/identity-status/);
  assert.match(js, /refreshIdentityBanner/);
  assert.match(html, /id="identity-banner"/);
  assert.match(js, /VellumAI/);
});

test('app.js confirms with Go/Repost and shows LIVE toast; skip via fetch POST', () => {
  assert.match(js, /\/api\/cards\/\$\{[^}]+\}\/confirm/);
  assert.match(js, /\/api\/cards\/\$\{[^}]+\}\/skip/);
  assert.match(js, /['"]Go['"]/);
  assert.match(js, /['"]Repost['"]/);
  assert.match(js, /showLiveToast/);
  assert.match(js, /live-badge/);
  assert.match(js, /method:\s*['"]POST['"]/g);
});

test('scalper panel matches live-activity ops chrome with deal lanes', () => {
  assert.match(html, /id="scalper-panel"/);
  assert.match(html, /Deal Watch/);
  assert.match(html, /HiBid\/Facebook are ledger-only/);
  assert.match(html, /id="scalper-armed-badge"/);
  assert.match(html, /id="scalper-thresholds"/);
  assert.match(html, /id="sniper-hearted"/);
  assert.match(html, /id="sniper-worklist-count"/);
  assert.match(html, /id="sniper-suspect-items"/);
  assert.match(html, /id="sniper-recent-hearts"/);
  assert.match(html, /id="sniper-worklist-items"/);
  assert.match(html, /id="scalper-strategy-chips"/);
  assert.match(js, /\/api\/sniper/);
  assert.match(js, /refreshSniper/);
  assert.match(js, /renderSniperTable/);
  assert.match(js, /sniperListingUrl/);
  assert.match(js, /facebook\.com\/marketplace\/item/);
  assert.match(js, /hibid\.com\/lot/);
  assert.match(js, /officialArtUrl/);
  assert.match(js, /scalper-thumb-pair/);
  assert.match(js, /scalper-thumb-official/);
  assert.match(js, /scalper-badge-armed/);
  assert.match(css, /\.scalper-table/);
  assert.match(css, /\.scalper-thumb-pair/);
  assert.match(css, /\.scalper-thumb-official/);
  assert.match(css, /\.threshold-heart/);
  assert.match(css, /\.ratio-suspect/);
});

test('research panel can be refreshed from the UI and shows ranked cards/sets', () => {
  assert.match(html, /id="research-panel"/);
  assert.match(html, /Market research/);
  assert.match(html, /id="run-research-btn"/);
  assert.match(html, /Run research/);
  assert.match(html, /id="research-cards-body"/);
  assert.match(html, /id="research-sets-body"/);
  assert.match(html, /id="research-status"/);
  assert.match(js, /\/api\/research\/run/);
  assert.match(js, /\/api\/research/);
  assert.match(js, /refreshResearch/);
  assert.match(css, /\.research-table/);
});
