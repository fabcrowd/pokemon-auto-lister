// Injected into every tab — renders a full-viewport card-scanner overlay.
(function () {
  if (window.__cardScannerLoaded) return;
  window.__cardScannerLoaded = true;

  const CONF_COLORS = {
    high:    '#10b981',
    medium:  '#f59e0b',
    low:     '#4b5563',
    abstain: '#4b5563',
  };

  function confTier(confidence) {
    if (confidence >= 0.80) return 'high';
    if (confidence >= 0.50) return 'medium';
    return 'low';
  }

  let canvas = null;
  let ctx    = null;

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = '__card-scanner-overlay__';
    Object.assign(canvas.style, {
      position:      'fixed',
      top:           '0',
      left:          '0',
      width:         '100vw',
      height:        '100vh',
      pointerEvents: 'none',
      zIndex:        '2147483647',
    });
    document.documentElement.appendChild(canvas);
    fitCanvas();
    window.addEventListener('resize', fitCanvas);
  }

  function fitCanvas() {
    if (!canvas) return;
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    ctx = canvas.getContext('2d');
  }

  function clearOverlay() {
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function renderOverlay(cards, srcWidth, srcHeight) {
    ensureCanvas();
    clearOverlay();

    const scaleX = canvas.width  / srcWidth;
    const scaleY = canvas.height / srcHeight;

    for (const card of cards) {
      if (!card.box || card.box.length < 4) continue;
      const [x1, y1, x2, y2] = card.box;
      const sx1 = x1 * scaleX, sy1 = y1 * scaleY;
      const sx2 = x2 * scaleX, sy2 = y2 * scaleY;
      const tier  = card.abstain ? 'abstain' : confTier(card.confidence);
      const color = CONF_COLORS[tier];
      ctx.save();
      drawCornerBox(sx1, sy1, sx2, sy2, color, card.abstain);
      if (card.identity && !card.abstain) {
        drawBadge(sx1, sy1, card, color);
      }
      ctx.restore();
    }
  }

  function drawCornerBox(x1, y1, x2, y2, color, dashed) {
    const w   = x2 - x1;
    const h   = y2 - y1;
    const arm = Math.min(w, h) * 0.18;

    ctx.strokeStyle = color;
    ctx.lineWidth   = 2.5;
    ctx.lineCap     = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur  = dashed ? 0 : 6;
    if (dashed) ctx.setLineDash([5, 4]);

    ctx.beginPath();
    for (const [cx, cy, dx, dy] of [
      [x1, y1,  1,  1],
      [x2, y1, -1,  1],
      [x2, y2, -1, -1],
      [x1, y2,  1, -1],
    ]) {
      ctx.moveTo(cx + dx * arm, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * arm);
    }
    ctx.stroke();
  }

  function drawBadge(x1, y1, card, accentColor) {
    const id    = card.identity || {};
    const name  = (id.name || 'Unknown').slice(0, 24);
    const price = card.market_price != null
      ? '$' + card.market_price.toFixed(2)
      : null;

    const PAD    = 6;
    const ACCENT = 3;
    const HEIGHT = price ? 38 : 22;

    ctx.font = 'bold 11px -apple-system,BlinkMacSystemFont,sans-serif';
    let contentW = ctx.measureText(name).width;
    if (price) {
      ctx.font = 'bold 13px -apple-system,BlinkMacSystemFont,sans-serif';
      contentW = Math.max(contentW, ctx.measureText(price).width);
    }
    const WIDTH = Math.ceil(contentW) + ACCENT + PAD * 2 + 4;

    const bx = Math.max(0, Math.min(x1, canvas.width - WIDTH));
    const by = Math.max(0, y1 - HEIGHT - 4);

    ctx.fillStyle = 'rgba(8,9,13,0.88)';
    ctx.beginPath();
    ctx.roundRect(bx, by, WIDTH, HEIGHT, 4);
    ctx.fill();

    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.roundRect(bx, by, ACCENT, HEIGHT, [4, 0, 0, 4]);
    ctx.fill();

    ctx.font      = 'bold 11px -apple-system,BlinkMacSystemFont,sans-serif';
    ctx.fillStyle = '#c5cadc';
    ctx.fillText(name, bx + ACCENT + PAD, by + 14);

    if (price) {
      ctx.font      = 'bold 13px -apple-system,BlinkMacSystemFont,sans-serif';
      ctx.fillStyle = '#10b981';
      ctx.fillText(price, bx + ACCENT + PAD, by + 30);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'showOverlay') {
      renderOverlay(msg.cards, msg.srcWidth, msg.srcHeight);
    } else if (msg.action === 'clearOverlay') {
      clearOverlay();
    }
  });

  // Exposed for Playwright demo / testing without going through the relay chain
  window.__cardScanner = { show: renderOverlay, clear: clearOverlay };
}());
