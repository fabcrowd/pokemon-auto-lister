// Injected into the tab the user scans (never declared in the manifest) — renders a full-viewport card-scanner overlay.
(function () {
  // Guard against double-injection — scripting.executeScript may re-run this file
  // on the same page (e.g. a scan followed by an overlay relay).
  if (window.__cardScannerLoaded) return;
  window.__cardScannerLoaded = true;

  // Remove any canvas left by a previous extension context (e.g. after reload).
  const _stale = document.getElementById('__card-scanner-overlay__');
  if (_stale) _stale.remove();

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

  let canvas       = null;
  let ctx          = null;
  let _lastOverlay = null; // { cards, srcWidth, srcHeight } — survives resize

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
    // Resizing a canvas clears it — repaint the last known overlay state.
    if (_lastOverlay) {
      _drawOverlay(_lastOverlay.cards, _lastOverlay.srcWidth, _lastOverlay.srcHeight);
    }
  }

  function clearOverlay() {
    stopObserving();
    _lastOverlay = null;
    if (!canvas) return;
    canvas.remove();
    canvas = null;
    ctx    = null;
  }

  // ─── Lazy-load observer ────────────────────────────────────────────────────
  // Watches for new <img> nodes added to the DOM (infinite scroll, lazy load)
  // and notifies the background to re-scan when card-shaped images appear that
  // weren't present at the last scan baseline.

  let _observer     = null;
  let _observerTimer = null;
  let _baselineSrcs  = new Set();

  function startObserving() {
    _baselineSrcs = _getCardSrcs(); // re-baseline on every scan completion
    if (_observer) return;          // only wire up the observer once
    _observer = new MutationObserver(() => {
      clearTimeout(_observerTimer);
      _observerTimer = setTimeout(_checkNewCardSrcs, 500);
    });
    _observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree:   true,
    });
  }

  function stopObserving() {
    if (_observer) {
      _observer.disconnect();
      _observer = null;
    }
    clearTimeout(_observerTimer);
    _observerTimer = null;
    _baselineSrcs.clear();
  }

  function _getCardSrcs() {
    const srcs = new Set();
    for (const img of document.querySelectorAll('img')) {
      if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) continue;
      const r = img.getBoundingClientRect();
      if (r.width < CARD_MIN_W || r.height < CARD_MIN_H) continue;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) continue;
      const ratio = r.height > 0 ? r.width / r.height : 0;
      if (ratio < CARD_RATIO_MIN || ratio > CARD_RATIO_MAX) continue;
      const src = img.currentSrc || img.src || '';
      if (src) srcs.add(src);
    }
    return srcs;
  }

  function _checkNewCardSrcs() {
    const current = _getCardSrcs();
    let hasNew = false;
    for (const src of current) {
      if (!_baselineSrcs.has(src)) { hasNew = true; break; }
    }
    if (!hasNew) return;
    _baselineSrcs = current; // advance baseline so we don't re-fire for the same images
    chrome.runtime.sendMessage({ action: 'newCardsDetected' }).catch(() => {});
  }

  function renderOverlay(cards, srcWidth, srcHeight) {
    ensureCanvas();
    _lastOverlay = { cards, srcWidth, srcHeight };
    _drawOverlay(cards, srcWidth, srcHeight);
  }

  function _drawOverlay(cards, srcWidth, srcHeight) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

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
        drawBadge(sx1, sy1, sx2, sy2, card, color);
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

  function overlayPrintingNote(card) {
    if (card.display?.printingNote) return card.display.printingNote;
    if (card.display?.price != null) return null;
    const variants = card.price_grid?.variants;
    const names = variants ? Object.keys(variants) : [];
    if (names.length <= 1) return null;
    const values = names
      .map((name) => variants[name]?.market)
      .filter((price) => typeof price === 'number' && price > 0);
    if (values.length < 2) return names.length + ' variants';
    const low = Math.min(...values);
    const high = Math.max(...values);
    return names.length + ' variants · $' + low.toFixed(2) + '–$' + high.toFixed(2);
  }

  function drawBadge(x1, y1, x2, y2, card, accentColor) {
    const id    = card.identity || {};
    const disp  = card.display || null;
    const name  = (id.name || 'Unknown').slice(0, 28);

    // Line 2: set + number — always rendered so the user knows what the price refers to.
    const setCode = id.setCode || disp?.setCode || '';
    const setName = id.set     || disp?.set     || '';
    const number  = id.number  || disp?.number  || '';
    const line2Parts = [];
    if (setName) line2Parts.push(setName);
    if (number)  line2Parts.push('#' + number);
    const line2 = line2Parts.join(' · ');

    // Line 3: printing + price
    const note = overlayPrintingNote(card);
    const price = disp?.price != null
      ? '$' + Number(disp.price).toFixed(2)
      : (!note && card.market_price != null ? '$' + Number(card.market_price).toFixed(2) : null);
    const printing = disp?.printing || null;
    const cond     = disp?.condition || null;
    const priceLine = price
      ? [printing, cond, price].filter(Boolean).join(' · ')
      : null;

    const footer = disp?.footer || null;
    const spread = disp?.spreadRatio || 1;
    const warn   = !note && spread > 10 ? `⚠ ${spread.toFixed(1)}× spread` : null;

    const PAD      = 9;
    const ACCENT_W = 4;
    const NAME_PX  = 14;
    const SUB_PX   = 11;
    const PRICE_PX = 17;
    const WARN_PX  = 10;
    const GAP      = 3;

    let height = PAD + NAME_PX;
    if (line2)     height += GAP + SUB_PX;
    if (priceLine) height += GAP + PRICE_PX;
    if (note)      height += GAP + WARN_PX;
    if (footer)    height += GAP + WARN_PX;
    if (warn)      height += GAP + WARN_PX;
    height += PAD;

    ctx.font = `700 ${NAME_PX}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
    let widest = ctx.measureText(name).width;
    if (line2) {
      ctx.font = `500 ${SUB_PX}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
      widest = Math.max(widest, ctx.measureText(line2).width);
    }
    if (priceLine) {
      ctx.font = `800 ${PRICE_PX}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
      widest = Math.max(widest, ctx.measureText(priceLine).width);
    }
    if (note) {
      ctx.font = `700 ${WARN_PX}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
      widest = Math.max(widest, ctx.measureText(note).width);
    }
    if (footer) {
      ctx.font = `500 ${WARN_PX}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
      widest = Math.max(widest, ctx.measureText(footer).width);
    }
    if (warn) {
      ctx.font = `700 ${WARN_PX}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
      widest = Math.max(widest, ctx.measureText(warn).width);
    }
    const WIDTH = Math.ceil(widest) + ACCENT_W + PAD * 2 + 4;

    const vy1 = Math.max(0, y1);
    const vy2 = Math.min(canvas.height, y2);
    const vx1 = Math.max(0, x1);
    const bx = Math.max(6, Math.min(vx1 + 6, canvas.width - WIDTH - 6));
    const by = Math.max(6, Math.min(vy1 + 6, vy2 - height - 6));

    ctx.save();
    ctx.shadowColor  = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur   = 14;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = 'rgba(10,12,18,0.95)';
    ctx.beginPath();
    ctx.roundRect(bx, by, WIDTH, height, 6);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.roundRect(bx, by, ACCENT_W, height, [6, 0, 0, 6]);
    ctx.fill();

    const textLeft = bx + ACCENT_W + PAD;
    let cy = by + PAD;
    ctx.textBaseline = 'top';

    ctx.font      = `700 ${NAME_PX}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
    ctx.fillStyle = '#dde1ee';
    ctx.fillText(name, textLeft, cy);
    cy += NAME_PX + GAP;

    if (line2) {
      ctx.font      = `500 ${SUB_PX}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
      ctx.fillStyle = '#8b92ab';
      ctx.fillText(line2, textLeft, cy);
      cy += SUB_PX + GAP;
    }
    if (priceLine) {
      ctx.font      = `800 ${PRICE_PX}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
      ctx.fillStyle = '#10b981';
      ctx.fillText(priceLine, textLeft, cy);
      cy += PRICE_PX + GAP;
    }
    if (note) {
      ctx.font      = `700 ${WARN_PX}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
      ctx.fillStyle = '#f59e0b';
      ctx.fillText(note, textLeft, cy);
      cy += WARN_PX + GAP;
    }
    if (footer) {
      ctx.font      = `500 ${WARN_PX}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
      ctx.fillStyle = '#8b92ab';
      ctx.fillText(footer, textLeft, cy);
      cy += WARN_PX + GAP;
    }
    if (warn) {
      ctx.font      = `700 ${WARN_PX}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
      ctx.fillStyle = '#f59e0b';
      ctx.fillText(warn, textLeft, cy);
    }
  }

  // ─── DOM-based card finder ────────────────────────────────────────────────
  // Pokémon card aspect ratio is 2.5 × 3.5 inches → ~0.714 portrait.
  // Accept a wider band (0.55–0.95) to catch borders, protective sleeves,
  // and photos shot with slight rotation. Lower size threshold lets us pick
  // up marketplace thumbnails (HiBid, eBay) that are often ~70×100 px.
  const CARD_RATIO_MIN = 0.55;
  const CARD_RATIO_MAX = 0.95;
  const CARD_MIN_W     = 60;
  const CARD_MIN_H     = 85;

  // Images bigger than this (CSS px) are candidates for "multi-card photo" treatment —
  // run YOLO inside them to find individual cards. Marketplace lot shots and FB
  // Marketplace listings fall here (landscape / square multi-card photos).
  const PHOTO_MIN_SIDE = 180;
  // Box art that says what it sells. A bare "tin", "bundle", "binder" or "playmat" also names cards
  // photographed in one, so those need a sealed context word to count.
  const SEALED_PRODUCT_LABEL = /\b(?:ultra[\s-]*premium collection|premium collection|collection (?:box|chest|set)|booster(?: box| pack| bundle)?|elite trainer box|starter deck|battle deck|gift set|trading card game classic)\b/i;

  function isSealedLabel(text) {
    return SEALED_PRODUCT_LABEL.test(String(text || ''));
  }

  // Only the image's own alt and aria text: a link's visible text names the whole tile, not the picture.
  function hasSealedProductContext(node) {
    const link = node.closest('a');
    const label = [
      node.alt,
      node.getAttribute('aria-label'),
      link?.getAttribute('aria-label'),
    ].filter(Boolean).join(' ');
    return isSealedLabel(label);
  }

  function tidyText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  const MAX_ANCESTORS = 12;

  // Clip a box (viewport px) by the ancestors that really clip this element. chain[0] is the element
  // (position only); the rest are its ancestors, nearest first, as {position, clipX, clipY, root, rect}.
  // body/html never clip; a fixed element is not clipped by ancestors; an absolutely positioned element
  // is only clipped from its containing block outward; the walk stops at a fixed ancestor.
  function clipBox(box, chain) {
    let { x1, y1, x2, y2 } = box;
    const self = chain[0] || {};
    if (self.position === 'fixed') return { x1, y1, x2, y2 };
    let skipping = self.position === 'absolute';
    for (let i = 1; i < chain.length && i <= MAX_ANCESTORS; i++) {
      const a = chain[i];
      if (a.root) break;
      if (skipping) {
        if (a.position === 'static') continue;
        skipping = false;
      }
      if (a.clipX) { x1 = Math.max(x1, a.rect.left); x2 = Math.min(x2, a.rect.right); }
      if (a.clipY) { y1 = Math.max(y1, a.rect.top); y2 = Math.min(y2, a.rect.bottom); }
      if (a.position === 'fixed') break;
      if (a.position === 'absolute') skipping = true;
    }
    return { x1, y1, x2, y2 };
  }

  // What surrounds an image, for the background's page-focus decision: landmarks, aria labels,
  // and the short heading ("Similar items") that sits just before a block of images. Raw
  // strings only; the judging lives in lib/page-focus.js.
  const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  let _headingBefore = new WeakMap();

  // Only the start of an element's text is ever judged (headings are short), so a huge subtree is never joined into one string.
  const TEXT_LIMIT = 200;
  const TEXT_NODE_LIMIT = 200;
  const MAX_TEXT_CHILDREN = 20;
  function boundedText(el) {
    if (!el || el.childElementCount > MAX_TEXT_CHILDREN) return '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text = '';
    let nodes = 0;
    for (let node = walker.nextNode(); node && text.length < TEXT_LIMIT && nodes < TEXT_NODE_LIMIT; node = walker.nextNode(), nodes++) {
      text += node.nodeValue || '';
    }
    return text.slice(0, TEXT_LIMIT);
  }

  function headingBefore(el) {
    if (_headingBefore.has(el)) return _headingBefore.get(el);
    let found = '';
    let sibling = el.previousElementSibling;
    for (let step = 0; sibling && step < 2 && !found; step++, sibling = sibling.previousElementSibling) {
      const text = tidyText(boundedText(sibling));
      const isHeading = sibling.matches(HEADING_SELECTOR) || sibling.querySelector(HEADING_SELECTOR);
      if (isHeading && text && text.length <= 100 && !sibling.querySelector('img,picture,video')) found = text;
    }
    _headingBefore.set(el, found);
    return found;
  }

  // Stable ids for elements, so the background can ask "is this image inside that section" without
  // the DOM: an element's chain is its own id followed by its ancestors', nearest first.
  const _ids = new WeakMap();
  let _nextId = 1;
  function idOf(el) {
    let id = _ids.get(el);
    if (!id) {
      id = _nextId++;
      _ids.set(el, id);
    }
    return id;
  }
  function chainOf(el) {
    const chain = [];
    for (let p = el; p && chain.length < 80; p = p.parentElement) chain.push(idOf(p));
    return chain;
  }

  // Inside a horizontally scrolling or clipped strip that is wider than what it shows: a carousel.
  let _scrollsX = new WeakMap();

  // Layout and sibling headings are cached while one scan walks the page; the next scan sees the page as it is then.
  function resetScanCaches() {
    _headingBefore = new WeakMap();
    _scrollsX = new WeakMap();
  }
  function scrollsHorizontally(el) {
    let depth = 0;
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement && depth < MAX_ANCESTORS; p = p.parentElement, depth++) {
      let scrolls = _scrollsX.get(p);
      if (scrolls === undefined) {
        const overflow = getComputedStyle(p).overflowX;
        scrolls = (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden') && p.scrollWidth > p.clientWidth + 1;
        _scrollsX.set(p, scrolls);
      }
      if (scrolls) return true;
    }
    return false;
  }

  const LABELLED_CONTAINERS = new Set(['SECTION', 'ASIDE', 'DIV', 'UL', 'OL', 'NAV', 'ARTICLE']);

  // Short titles of sections: headings and labelled containers, with the chain of the element that carries
  // them. Judging which are "similar items" happens in lib/page-focus.js.
  function collectHeadings() {
    const out = [];
    for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],section[aria-label],aside[aria-label],div[aria-label],ul[aria-label],ol[aria-label],nav[aria-label],article[aria-label],[role="region"][aria-label]')) {
      if (out.length >= 300) break;
      const label = el.getAttribute('aria-label');
      const heading = /^H[1-6]$/.test(el.tagName) || el.getAttribute('role') === 'heading';
      if (!heading && !(label && LABELLED_CONTAINERS.has(el.tagName))) continue;
      if (heading && !label && el.querySelector('img,picture,video')) continue;
      const text = tidyText(label || boundedText(el));
      if (!text || text.length > 100) continue;
      out.push({ text, chain: chainOf(el) });
    }
    return out;
  }

  // Where the page keeps larger renditions of this image; the background decides which to try.
  const FULL_SIZE_ATTR = /^data-.*(?:zoom|large|full|orig|hi-?res|big|master|lightbox|src)/i;

  function sourceHints(img) {
    const sets = [img.srcset || ''];
    if (img.parentElement?.tagName === 'PICTURE') {
      for (const source of img.parentElement.querySelectorAll('source[srcset]')) sets.push(source.srcset || '');
    }
    const attrs = [];
    for (const attr of img.attributes || []) {
      if (FULL_SIZE_ATTR.test(attr.name) && attr.value && attr.value.length <= 2000 && attrs.length < 6) attrs.push(attr.value);
    }
    return {
      srcset: sets.filter(Boolean).join(', ').slice(0, 6000),
      attrs,
      link: img.closest('a[href]')?.href || '',
    };
  }

  function contextOf(node) {
    const landmarks = [];
    const headings = [];
    const labels = [];
    let depth = 0;
    for (let el = node; el && el !== document.documentElement && depth < 12; el = el.parentElement, depth++) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'main' || tag === 'aside' || tag === 'nav' || tag === 'footer' || tag === 'article') landmarks.push(tag);
      const role = el.getAttribute('role');
      if (role) landmarks.push(role.toLowerCase());
      const label = el.getAttribute('aria-label');
      if (label) labels.push(label.slice(0, 100));
      const heading = headingBefore(el);
      if (heading) headings.push(heading);
    }
    return { landmarks, headings, labels, sealedLabel: hasSealedProductContext(node), chain: chainOf(node), hscroll: scrollsHorizontally(node) };
  }

  // Hostnames the page itself loaded pictures from. The background only fetches full-size renditions from these.
  const MAX_IMAGE_HOSTS = 200;
  const MAX_IMAGE_ELEMENTS = 1000;
  const MAX_RESOURCE_ENTRIES = 3000;

  function srcsetUrls(text) {
    const out = [];
    for (const match of String(text || '').matchAll(/(\S+)(?:\s+[\d.]+[wx])?\s*(?:,|$)/g)) out.push(match[1].replace(/,+$/, ''));
    return out;
  }

  function collectImageHosts() {
    const hosts = new Set();
    const add = (raw) => {
      if (!raw || hosts.size >= MAX_IMAGE_HOSTS) return;
      try {
        const host = new URL(raw, document.baseURI).hostname.toLowerCase();
        if (host) hosts.add(host);
      } catch { /* not a URL */ }
    };
    let seen = 0;
    for (const img of document.querySelectorAll('img')) {
      if (seen++ >= MAX_IMAGE_ELEMENTS) break;
      add(img.currentSrc);
      add(img.src);
      srcsetUrls(img.srcset).forEach(add);
    }
    for (const source of document.querySelectorAll('picture source[srcset]')) srcsetUrls(source.srcset).forEach(add);
    if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
      for (const entry of performance.getEntriesByType('resource').slice(0, MAX_RESOURCE_ENTRIES)) {
        if (entry.initiatorType === 'img' || entry.initiatorType === 'css') add(entry.name);
      }
    }
    return [...hosts];
  }

  function metaContent(selector) {
    return document.querySelector(selector)?.getAttribute('content') || '';
  }

  // What the page says it is about: used to recognise the listing photo and sealed products.
  function pageInfo() {
    const ogImages = [
      metaContent('meta[property="og:image"]'),
      metaContent('meta[property="og:image:secure_url"]'),
      metaContent('meta[name="twitter:image"]'),
      document.querySelector('link[rel="image_src"]')?.getAttribute('href') || '',
    ].filter(Boolean).map((url) => {
      try { return new URL(url, document.baseURI).href; } catch { return ''; }
    }).filter(Boolean);
    return {
      title: (document.title || '').slice(0, 200),
      ogTitle: metaContent('meta[property="og:title"]').slice(0, 200),
      h1: (document.querySelector('h1')?.textContent || '').trim().slice(0, 200),
      ogImages,
      headings: collectHeadings(),
      imageHosts: collectImageHosts(),
    };
  }

  // The part of an image that is actually on screen: inside the viewport and inside the ancestors that
  // clip it. A carousel slide pushed out of an overflow:hidden strip has a layout box and nothing to see.
  function visibleBox(el, r) {
    const viewport = {
      x1: Math.max(0, r.left), y1: Math.max(0, r.top),
      x2: Math.min(window.innerWidth, r.right), y2: Math.min(window.innerHeight, r.bottom),
    };
    const pvw = Math.max(0, viewport.x2 - viewport.x1);
    const pvh = Math.max(0, viewport.y2 - viewport.y1);
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return { vx: viewport.x1, vy: viewport.y1, vw: 0, vh: 0, pvw, pvh };
    }
    const chain = [{ position: getComputedStyle(el).position }];
    let depth = 0;
    for (let p = el.parentElement; p && depth < MAX_ANCESTORS; p = p.parentElement, depth++) {
      const root = p === document.body || p === document.documentElement;
      const style = getComputedStyle(p);
      const clipX = style.overflowX !== 'visible';
      const clipY = style.overflowY !== 'visible';
      chain.push({
        position: style.position, clipX, clipY, root,
        rect: clipX || clipY ? p.getBoundingClientRect() : null,
      });
      if (root) break;
    }
    const c = clipBox(viewport, chain);
    return { vx: c.x1, vy: c.y1, vw: Math.max(0, c.x2 - c.x1), vh: Math.max(0, c.y2 - c.y1), pvw, pvh };
  }

  function findCardImages(opts = {}) {
    resetScanCaches();
    const found = [];
    const photos = [];  // large non-card-aspect images for YOLO-inside-image treatment
    const rejected = []; // only populated when opts.diag === true
    const seen  = new Set();
    const imgs  = document.querySelectorAll('img');
    let pending = 0; // card-shaped pictures that have not finished loading yet

    const bgCandidates = scanBackgroundImages();

    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      const ratio = r.height ? r.width / r.height : 0;
      const src = img.currentSrc || img.src || '';

      const cardShaped = r.width >= CARD_MIN_W && r.height >= CARD_MIN_H
        && ratio >= CARD_RATIO_MIN && ratio <= CARD_RATIO_MAX
        && r.right > 0 && r.bottom > 0
        && r.left < window.innerWidth && r.top < window.innerHeight;
      // Layout is already card-sized, but the bytes have not arrived. A finished
      // image with no pixels is broken, not "still loading".
      if (!img.complete && cardShaped) pending += 1;

      let reason = null;
      if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) reason = 'not-loaded';
      else if (r.width < CARD_MIN_W || r.height < CARD_MIN_H)                  reason = 'too-small';
      else if (r.right <= 0 || r.bottom <= 0 ||
               r.left >= window.innerWidth || r.top >= window.innerHeight)     reason = 'off-screen';
      else if (ratio < CARD_RATIO_MIN || ratio > CARD_RATIO_MAX)               reason = 'wrong-ratio';
      else if (hasSealedProductContext(img))                                    reason = 'sealed-product';

      // Rect visible within the viewport and every overflow-clipping ancestor. Skipped for images
      // already rejected as unloaded, tiny or off-screen: they are never scanned.
      const gone = reason === 'not-loaded' || reason === 'too-small' || reason === 'off-screen';
      const { vx, vy, vw, vh, pvw, pvh } = gone ? { vx: 0, vy: 0, vw: 0, vh: 0, pvw: 0, pvh: 0 } : visibleBox(img, r);
      const visibleCoverage = r.width > 0 && r.height > 0
        ? (vw * vh) / (r.width * r.height)
        : 0;
      if (!reason && visibleCoverage < 0.75) reason = 'mostly-clipped';

      // Treat ANY sufficiently-large loaded image as a photo candidate too — YOLO
      // runs inside it to find individual cards. Multi-card photos (lot shots,
      // lightbox-expanded listing photos) match here regardless of aspect ratio.
      const isLargePhoto = img.complete && img.naturalWidth > 0 &&
        pvw >= PHOTO_MIN_SIDE && pvh >= PHOTO_MIN_SIDE;

      if (reason) {
        if (opts.diag) rejected.push({ reason, src: src.slice(0, 160), w: Math.round(r.width), h: Math.round(r.height), ratio: Number(ratio.toFixed(3)) });
        // A sealed product's box art is kept as a photo candidate too, so the background can see that
        // the listing's main picture is a product and not a card; it never scans it for cards.
        if ((reason === 'wrong-ratio' || reason === 'sealed-product') && isLargePhoto) {
          const key = 'p:' + src + ':' + Math.round(r.left) + ':' + Math.round(r.top);
          if (!seen.has(key)) {
            seen.add(key);
            const style = getComputedStyle(img);
            photos.push({
              rect: { x: r.left, y: r.top, w: r.width, h: r.height, vx, vy, vw, vh, pvw, pvh },
              naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
              src: img.currentSrc || img.src || '',
              render: { fit: style.objectFit || 'fill', position: style.objectPosition || '50% 50%' },
              ctx: contextOf(img),
              sources: sourceHints(img),
            });
          }
        }
        continue;
      }
      const key = src + ':' + Math.round(r.left) + ':' + Math.round(r.top);
      if (seen.has(key)) continue;
      seen.add(key);
      const imageStyle = getComputedStyle(img);
      found.push({
        rect: { x: r.left, y: r.top, w: r.width, h: r.height, vx, vy, vw, vh, pvw, pvh },
        naturalWidth:  img.naturalWidth,
        naturalHeight: img.naturalHeight,
        src: img.currentSrc || img.src || '',
        render: { fit: imageStyle.objectFit || 'fill', position: imageStyle.objectPosition || '50% 50%' },
        ctx: contextOf(img),
      });
      // ALSO add big card-shaped images to the photos list, so a single large
      // image that actually contains multiple cards (e.g. a stack photo cropped
      // tall) can be split by YOLO. The background prefers YOLO hits when ≥ 2.
      if (pvw >= PHOTO_MIN_SIDE && pvh >= PHOTO_MIN_SIDE) {
        const pkey = 'p:' + src + ':' + Math.round(r.left) + ':' + Math.round(r.top);
        if (!seen.has(pkey)) {
          seen.add(pkey);
          photos.push({
            rect: { x: r.left, y: r.top, w: r.width, h: r.height, vx, vy, vw, vh, pvw, pvh },
            naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
            src: img.currentSrc || img.src || '',
            render: { fit: imageStyle.objectFit || 'fill', position: imageStyle.objectPosition || '50% 50%' },
            ctx: contextOf(img),
            sources: sourceHints(img),
          });
        }
      }
    }

    for (const candidate of bgCandidates) {
      const { rect, ratio } = candidate;
      const key = 'bg:' + candidate.bg + ':' + Math.round(rect.x) + ':' + Math.round(rect.y);
      if (ratio >= CARD_RATIO_MIN && ratio <= CARD_RATIO_MAX && !seen.has(key)) {
        seen.add(key);
        found.push({ rect, naturalWidth: null, naturalHeight: null, ctx: candidate.ctx });
      }
      if (rect.vw >= PHOTO_MIN_SIDE && rect.vh >= PHOTO_MIN_SIDE) {
        const photoKey = 'bgp:' + candidate.bg + ':' + Math.round(rect.x) + ':' + Math.round(rect.y);
        if (!seen.has(photoKey)) {
          seen.add(photoKey);
          photos.push({
            rect,
            naturalWidth: null,
            naturalHeight: null,
            src: candidate.src,
            render: { fit: 'background', size: candidate.size, position: candidate.position, repeat: candidate.repeat },
            ctx: candidate.ctx,
          });
        }
      }
    }
    return { cards: found, photos, pending, rejected, bgCandidates, totalImgs: imgs.length };
  }

  // Scan for card-sized elements that use CSS background-image instead of <img>.
  // These are a common failure mode on image viewers (Facebook, HiBid lightboxes).
  function scanBackgroundImages() {
    const out = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    let n = 0;
    while (node && n < 2000) {
      if (node.nodeType === 1) {
        const r = node.getBoundingClientRect();
        if (r.width >= CARD_MIN_W && r.height >= CARD_MIN_H &&
            r.right > 0 && r.bottom > 0 &&
            r.left < window.innerWidth && r.top < window.innerHeight) {
          const vx = Math.max(0, r.left);
          const vy = Math.max(0, r.top);
          const vw = Math.min(window.innerWidth, r.right) - vx;
          const vh = Math.min(window.innerHeight, r.bottom) - vy;
          const visibleCoverage = (vw * vh) / (r.width * r.height);
          if (visibleCoverage >= 0.75) {
            const style = getComputedStyle(node);
            const bg = style.backgroundImage;
            if (style.visibility !== 'hidden' && style.display !== 'none' &&
                style.opacity !== '0' && bg && bg !== 'none' && bg.includes('url(') &&
                !hasSealedProductContext(node)) {
              const ratio = r.width / r.height;
              const urlMatch = bg.match(/url\((?:\s*["']?)(.*?)(?:["']?\s*)\)/i);
              let src = '';
              try { src = urlMatch ? new URL(urlMatch[1], document.baseURI).href : ''; } catch { /* unsupported URL */ }
              out.push({
                rect: { x: r.left, y: r.top, w: r.width, h: r.height, vx, vy, vw, vh },
                w: Math.round(r.width), h: Math.round(r.height), ratio: Number(ratio.toFixed(3)),
                tag: node.tagName, bg: bg.slice(0, 120),
                ctx: contextOf(node),
                src,
                size: style.backgroundSize,
                position: style.backgroundPosition,
                repeat: style.backgroundRepeat,
              });
            }
          }
        }
        n++;
      }
      node = walker.nextNode();
    }
    return out;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'showOverlay') {
      renderOverlay(msg.cards, msg.srcWidth, msg.srcHeight);
    } else if (msg.action === 'clearOverlay') {
      clearOverlay();
    } else if (msg.action === 'findCards') {
      const { cards, photos, pending } = findCardImages();
      sendResponse({
        cards,
        photos,
        pending,
        page: pageInfo(),
        viewportWidth:  window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      });
      return false;
    } else if (msg.action === 'startObserving') {
      startObserving();
    // dev-only:start
    } else if (msg.action === 'findCardsDiag') {
      const diag = findCardImages({ diag: true });
      sendResponse({
        ...diag,
        viewportWidth:  window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      });
      return false;
    // dev-only:end
    }
  });

  // dev-only:start
  // Exposed for Playwright demo / testing without going through the relay chain
  window.__cardScanner = { show: renderOverlay, clear: clearOverlay, find: findCardImages, startObserving, stopObserving, pure: { tidyText, clipBox, isSealedLabel, chainOf, idOf, sourceHints, boundedText, headingBefore, collectHeadings, scrollsHorizontally, collectImageHosts, srcsetUrls } };
  // dev-only:end
}());
