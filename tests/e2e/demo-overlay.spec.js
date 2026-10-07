/**
 * Live-tab overlay demo — launches Chromium, opens a real public webpage,
 * and renders the card-detection overlay on top of it using the inline renderer
 * (which mirrors content.js drawing logic exactly).
 *
 * Run: npx playwright test demo-overlay --project=demo
 *
 * Screenshots saved to tests/e2e/screenshots/
 */

import { test, chromium } from '@playwright/test';
import path from 'node:path';
import fs   from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR  = path.join(__dirname, 'screenshots');

// Card data in 640×480 source-space; content.js scales to actual viewport.
const DEMO_CARDS = [
  {
    box: [28, 70, 280, 390],
    identity: { name: 'Charizard', set: 'Base Set', setCode: 'BS', number: '4/102' },
    confidence: 0.94,
    market_price: 647.00,
    price_variant: 'market',
    abstain: false,
  },
  {
    box: [300, 70, 550, 390],
    identity: { name: 'Blastoise', set: 'Base Set', setCode: 'BS', number: '2/102' },
    confidence: 0.88,
    market_price: 182.50,
    price_variant: 'market',
    abstain: false,
  },
  {
    box: [160, 300, 480, 470],
    identity: { name: 'Mewtwo', set: 'Base Set', setCode: 'BS', number: '10/102' },
    confidence: 0.35,
    market_price: null,
    price_variant: null,
    abstain: true,
  },
];

// Mirrors content.js drawing logic — injected directly so the demo works
// without needing Chrome extension auto-injection.
const INLINE_RENDERER = `
(function () {
  if (window.__cardScanner) return;

  const CONF_COLORS = { high:'#10b981', medium:'#f59e0b', low:'#4b5563', abstain:'#4b5563' };
  function confTier(c) { return c >= 0.8 ? 'high' : c >= 0.5 ? 'medium' : 'low'; }

  let canvas = null, ctx = null;
  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = '__card-scanner-overlay__';
    Object.assign(canvas.style, {
      position:'fixed', top:'0', left:'0', width:'100vw', height:'100vh',
      pointerEvents:'none', zIndex:'2147483647',
    });
    document.documentElement.appendChild(canvas);
    canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    ctx = canvas.getContext('2d');
  }
  function clearOverlay() { if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); }
  function renderOverlay(cards, srcW, srcH) {
    ensureCanvas(); clearOverlay();
    const sx = canvas.width / srcW, sy = canvas.height / srcH;
    for (const card of cards) {
      if (!card.box || card.box.length < 4) continue;
      const [x1,y1,x2,y2] = card.box;
      const [bx1,by1,bx2,by2] = [x1*sx, y1*sy, x2*sx, y2*sy];
      const tier  = card.abstain ? 'abstain' : confTier(card.confidence);
      const color = CONF_COLORS[tier];
      const arm   = Math.min(bx2-bx1, by2-by1) * 0.18;
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
      ctx.shadowColor = color; ctx.shadowBlur = card.abstain ? 0 : 6;
      if (card.abstain) ctx.setLineDash([5,4]);
      ctx.beginPath();
      for (const [cx,cy,dx,dy] of [[bx1,by1,1,1],[bx2,by1,-1,1],[bx2,by2,-1,-1],[bx1,by2,1,-1]]) {
        ctx.moveTo(cx+dx*arm,cy); ctx.lineTo(cx,cy); ctx.lineTo(cx,cy+dy*arm);
      }
      ctx.stroke();
      if (card.identity && !card.abstain) {
        const name  = (card.identity.name || 'Unknown').slice(0,24);
        const price = card.market_price != null ? '$' + card.market_price.toFixed(2) : null;
        const PAD=6, ACC=3, H=price?38:22;
        ctx.font='bold 11px sans-serif';
        let cw = ctx.measureText(name).width;
        if (price) { ctx.font='bold 13px sans-serif'; cw=Math.max(cw,ctx.measureText(price).width); }
        const W = Math.ceil(cw)+ACC+PAD*2+4;
        const px=Math.max(0,Math.min(bx1,canvas.width-W)), py=Math.max(0,by1-H-4);
        ctx.fillStyle='rgba(8,9,13,0.88)'; ctx.beginPath(); ctx.roundRect(px,py,W,H,4); ctx.fill();
        ctx.fillStyle=color; ctx.beginPath(); ctx.roundRect(px,py,ACC,H,[4,0,0,4]); ctx.fill();
        ctx.font='bold 11px sans-serif'; ctx.fillStyle='#c5cadc';
        ctx.fillText(name,px+ACC+PAD,py+14);
        if (price) { ctx.font='bold 13px sans-serif'; ctx.fillStyle='#10b981'; ctx.fillText(price,px+ACC+PAD,py+30); }
      }
      ctx.restore();
    }
  }
  window.__cardScanner = { show: renderOverlay, clear: clearOverlay };
}());
`;

test('overlay renders on a live webpage then clears', async () => {
  test.setTimeout(60_000);

  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--window-size=1280,900'],
  });

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 20_000 });

  // Inject the inline renderer (mirrors content.js exactly)
  await page.evaluate(INLINE_RENDERER);

  // ── screenshot 1: page without overlay ──────────────────────────────────
  await page.screenshot({ path: path.join(SHOT_DIR, 'demo-01-before.png') });

  // Trigger the overlay with fixture card data (source frame: 640×480)
  await page.evaluate((cards) => window.__cardScanner.show(cards, 640, 480), DEMO_CARDS);
  await page.waitForTimeout(300);

  // ── screenshot 2: overlay active ────────────────────────────────────────
  await page.screenshot({ path: path.join(SHOT_DIR, 'demo-02-overlay.png') });

  // Clear the overlay
  await page.evaluate(() => window.__cardScanner.clear());
  await page.waitForTimeout(150);

  // ── screenshot 3: overlay cleared ───────────────────────────────────────
  await page.screenshot({ path: path.join(SHOT_DIR, 'demo-03-cleared.png') });

  await browser.close();
});
