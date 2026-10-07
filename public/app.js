const POLL_INTERVAL_MS = 5000;

const addNewCardsBtn = document.getElementById('add-new-cards-btn');
const downloadPhotosBtn = document.getElementById('download-photos-btn');
const rescanInboxBtn = document.getElementById('rescan-inbox-btn');
const rescanPricesBtn = document.getElementById('rescan-prices-btn');
const connectMercariBtn = document.getElementById('connect-mercari-btn');
const connectEbayBtn = document.getElementById('connect-ebay-btn');
const connectCollectricsBtn = document.getElementById('connect-collectrics-btn');
const statusEl = document.getElementById('add-card-status');

async function refreshMarketplaceStatus() {
  const mercariEl = document.getElementById('mercari-connect-status');
  const ebayEl = document.getElementById('ebay-connect-status');
  try {
    const collectricsEl = document.getElementById('collectrics-connect-status');
    const [mercariRes, ebayRes, collectricsRes] = await Promise.all([
      fetch('/api/mercari/status'),
      fetch('/api/ebay/status'),
      fetch('/api/collectrics/status'),
    ]);
    if (mercariRes.ok && mercariEl) {
      const m = await mercariRes.json();
      if (m.loggedIn) {
        mercariEl.textContent = 'Mercari: connected';
        mercariEl.className = 'connect-status connect-ok';
      } else if (m.connecting) {
        mercariEl.textContent = 'Mercari: waiting for login in Chrome…';
        mercariEl.className = 'connect-status connect-wait';
      } else if (m.error) {
        mercariEl.textContent = `Mercari: error — ${m.error}`;
        mercariEl.className = 'connect-status connect-bad';
      } else {
        mercariEl.textContent = 'Mercari: not connected';
        mercariEl.className = 'connect-status';
      }
    }
    if (collectricsRes?.ok && collectricsEl) {
      const c = await collectricsRes.json();
      if (c.loggedIn) {
        collectricsEl.textContent = 'Collectrics: connected';
        collectricsEl.className = 'connect-status connect-ok';
      } else if (c.connecting) {
        collectricsEl.textContent = 'Collectrics: waiting for login in Chrome…';
        collectricsEl.className = 'connect-status connect-wait';
      } else if (c.error) {
        collectricsEl.textContent = `Collectrics: error — ${c.error}`;
        collectricsEl.className = 'connect-status connect-bad';
      } else {
        collectricsEl.textContent = 'Collectrics: not connected';
        collectricsEl.className = 'connect-status';
      }
    }
    if (ebayRes.ok && ebayEl) {
      const e = await ebayRes.json();
      if (e.connected) {
        ebayEl.textContent = 'eBay: connected';
        ebayEl.className = 'connect-status connect-ok';
      } else if (!e.configured) {
        ebayEl.textContent = 'eBay: missing .env tokens';
        ebayEl.className = 'connect-status connect-bad';
      } else if (e.error) {
        ebayEl.textContent = `eBay: ${e.error}`;
        ebayEl.className = 'connect-status connect-bad';
      } else {
        ebayEl.textContent = 'eBay: not connected — click Connect';
        ebayEl.className = 'connect-status';
      }
    }
  } catch {
    // ignore poll errors
  }
}

if (connectMercariBtn) {
  connectMercariBtn.addEventListener('click', async () => {
    connectMercariBtn.disabled = true;
    statusEl.textContent = 'Opening Mercari Chrome — log in there if asked…';
    try {
      const res = await fetch('/api/mercari/connect', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Mercari connect failed (${res.status})`);
      }
      statusEl.textContent = data.message || 'Mercari connect started';
      await refreshMarketplaceStatus();
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      connectMercariBtn.disabled = false;
    }
  });
}

if (connectCollectricsBtn) {
  connectCollectricsBtn.addEventListener('click', async () => {
    connectCollectricsBtn.disabled = true;
    statusEl.textContent = 'Opening Collectrics Chrome — log in on the dashboard if asked…';
    try {
      const res = await fetch('/api/collectrics/connect', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Collectrics connect failed (${res.status})`);
      }
      statusEl.textContent = data.message || 'Collectrics connect started';
      await refreshMarketplaceStatus();
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      connectCollectricsBtn.disabled = false;
    }
  });
}

if (connectEbayBtn) {
  connectEbayBtn.addEventListener('click', async () => {
    connectEbayBtn.disabled = true;
    statusEl.textContent = 'Testing eBay OAuth token…';
    try {
      const res = await fetch('/api/ebay/connect', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || `eBay connect failed (${res.status})`);
      }
      statusEl.textContent = data.message || 'eBay connected';
      await refreshMarketplaceStatus();
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      await refreshMarketplaceStatus();
    } finally {
      connectEbayBtn.disabled = false;
    }
  });
}

async function refreshInboxStatus() {
  const res = await fetch('/api/inbox/status');
  if (!res.ok) {
    return;
  }
  const status = await res.json();
  const pathEl = document.getElementById('inbox-folder-path');
  const sourceEl = document.getElementById('inbox-photos-source');
  const pendingEl = document.getElementById('inbox-pending');
  const headerLabel = document.getElementById('header-inbox-label');
  if (pathEl) {
    pathEl.textContent = status.exists
      ? `Inbox: ${status.inboxDir}`
      : `Inbox missing: ${status.inboxDir}`;
  }
  if (sourceEl) {
    sourceEl.textContent = status.photosDir
      ? `Photos source: ${status.photosDir}${status.photosExists ? '' : ' (missing)'}`
      : 'Photos source: not configured';
  }
  if (pendingEl) {
    pendingEl.textContent = `Pending new cards: ${status.pendingTotal ?? 0}`;
  }
  if (headerLabel && status.inboxDir) {
    const parts = String(status.inboxDir).replace(/\\/g, '/').split('/');
    headerLabel.textContent = `${parts[parts.length - 1] || status.inboxDir}/`;
  }
}

if (downloadPhotosBtn) {
  downloadPhotosBtn.addEventListener('click', async () => {
    downloadPhotosBtn.disabled = true;
    statusEl.textContent = 'Downloading from iCloud Photos…';
    try {
      const res = await fetch('/api/inbox/download-photos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sinceHours: 72 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Download failed (${res.status})`);
      }
      statusEl.textContent =
        data.copied === 0
          ? `No new photos (skipped ${data.skipped ?? 0}). Pending cards: ${data.pendingTotal ?? 0}`
          : `Downloaded ${data.copied} photo(s) · pending cards: ${data.pendingTotal ?? 0}. Next: Add new cards.`;
      await refreshInboxStatus();
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      downloadPhotosBtn.disabled = false;
    }
  });
}

async function runInboxScan({ forceRescan = false } = {}) {
  const body = {
    mercari: document.getElementById('marketplace-mercari').checked,
    ebay: document.getElementById('marketplace-ebay').checked,
    forceRescan,
  };
  const res = await fetch('/api/inbox/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Scan failed (${res.status})`);
  }
  return data;
}

if (addNewCardsBtn) {
  addNewCardsBtn.addEventListener('click', async () => {
    addNewCardsBtn.disabled = true;
    if (rescanInboxBtn) rescanInboxBtn.disabled = true;
    statusEl.textContent = 'Scanning inbox…';
    try {
      const data = await runInboxScan({ forceRescan: false });
      const n = data.count ?? (data.enqueued || []).length;
      statusEl.textContent =
        n === 0
          ? 'No new cards found.'
          : `Found ${n} new · processing through detect & list…`;
      await refreshInboxStatus();
      await poll();
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      addNewCardsBtn.disabled = false;
      if (rescanInboxBtn) rescanInboxBtn.disabled = false;
    }
  });
}

if (rescanInboxBtn) {
  rescanInboxBtn.addEventListener('click', async () => {
    if (
      !window.confirm(
        'Rescan the whole inbox?\n\nThis regroups all photos and re-runs identity/pricing on existing (non-listed) cards. Listed cards are left alone.',
      )
    ) {
      return;
    }
    rescanInboxBtn.disabled = true;
    if (addNewCardsBtn) addNewCardsBtn.disabled = true;
    statusEl.textContent = 'Rescanning inbox (including current cards)…';
    try {
      const data = await runInboxScan({ forceRescan: true });
      const added = data.count ?? (data.enqueued || []).length;
      const updated = data.updatedCount ?? (data.updated || []).length;
      statusEl.textContent =
        added === 0 && updated === 0
          ? 'Rescan finished — nothing to update.'
          : `Rescan: ${updated} updated · ${added} new · reprocessing…`;
      await refreshInboxStatus();
      await poll();
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      rescanInboxBtn.disabled = false;
      if (addNewCardsBtn) addNewCardsBtn.disabled = false;
    }
  });
}

if (rescanPricesBtn) {
  rescanPricesBtn.addEventListener('click', async () => {
    rescanPricesBtn.disabled = true;
    statusEl.textContent = 'Rescanning listing prices…';
    try {
      const res = await fetch('/api/listings/rescan-prices', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Rescan failed (${res.status})`);
      }
      statusEl.textContent = `Checked ${data.checked ?? 0} · ${data.drifted ?? 0} outside ±5%`;
      await poll();
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      rescanPricesBtn.disabled = false;
    }
  });
}

function money(value) {
  return `$${Number(value).toFixed(2)}`;
}

function numericValues(obj) {
  return obj ? Object.values(obj).filter((value) => typeof value === 'number') : [];
}

function suggestedListPrice(suggested) {
  const values = numericValues(suggested);
  return values.length > 0 ? Math.max(...values) : null;
}

function baseValue(comps) {
  const values = numericValues(comps);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function cardLabel(card) {
  const identity = card.pricedCache?.identity;
  if (identity?.name) {
    const parts = [identity.name];
    if (identity.number) {
      parts.push(identity.number);
    }
    if (identity.set) {
      parts.push(identity.set);
    }
    return parts.join(' · ');
  }
  return card.title || 'Pokemon Card';
}

function cardMeta(card) {
  const identity = card.pricedCache?.identity;
  if (!identity) {
    return card.title || '';
  }
  return [identity.setCode, identity.rarity, card.title].filter(Boolean).join(' · ');
}

function reviewReason(card) {
  if (card.pricedCache?.reason) {
    return card.pricedCache.reason;
  }
  const comps = card.pricedCache?.comps || {};
  const missing = ['pokegrade', 'tcgplayer', 'ebay'].filter((key) => typeof comps[key] !== 'number');
  if (missing.length) {
    return `missing comps: ${missing.join(', ')} — only ${3 - missing.length} of 3 sources available`;
  }
  return 'needs review';
}

function formatComp(value, missingLabel) {
  if (typeof value === 'number') {
    return money(value);
  }
  return missingLabel;
}

async function refreshStats() {
  const res = await fetch('/api/stats');
  if (!res.ok) {
    return;
  }
  const stats = await res.json();
  const listedEl = document.getElementById('stat-listed');
  if (listedEl) {
    listedEl.textContent = stats.listed ?? 0;
  }
  document.getElementById('stat-drafts').textContent = stats.drafts;
  document.getElementById('stat-total-value').textContent = money(stats.totalListValue);
  document.getElementById('stat-queue').textContent = stats.queue;
  document.getElementById('stat-needs-review').textContent = stats.needsReview;
  document.getElementById('stat-errors').textContent = stats.errors;
  document.getElementById('stat-all-time').textContent = stats.allTime;
}

function showLiveToast(messageHtml) {
  const toast = document.getElementById('live-toast');
  if (!toast) {
    return;
  }
  toast.hidden = false;
  toast.innerHTML = messageHtml;
  window.clearTimeout(showLiveToast._timer);
  showLiveToast._timer = window.setTimeout(() => {
    toast.hidden = true;
  }, 12000);
}

function listingUrlFor(card) {
  return card.drafts?.mercari?.listingUrl || card.drafts?.ebay?.listingUrl || null;
}

function formatDeltaPct(delta) {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) {
    return '—';
  }
  const pct = delta * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function postedPriceFor(card) {
  if (typeof card.listPrice === 'number') {
    return card.listPrice;
  }
  if (typeof card.priceMonitor?.posted === 'number') {
    return card.priceMonitor.posted;
  }
  return suggestedListPrice(card.pricedCache?.suggested);
}

function marketPriceFor(card) {
  if (typeof card.priceMonitor?.market === 'number') {
    return card.priceMonitor.market;
  }
  return suggestedListPrice(card.pricedCache?.suggested);
}

async function refreshDraftActivity() {
  const res = await fetch('/api/cards');
  if (!res.ok) {
    return;
  }
  const cards = await res.json();
  const listings = cards.filter((card) =>
    ['drafted', 'listed', 'needs_review'].includes(card.status),
  );

  const tbody = document.getElementById('draft-activity-body');
  tbody.innerHTML = '';
  listings.forEach((card) => {
    const posted = postedPriceFor(card);
    const market = marketPriceFor(card);
    const delta =
      typeof card.priceMonitor?.delta === 'number'
        ? card.priceMonitor.delta
        : typeof posted === 'number' && typeof market === 'number' && posted > 0
          ? (market - posted) / posted
          : null;
    const withinBand =
      card.priceMonitor?.withinBand !== undefined
        ? card.priceMonitor.withinBand
        : typeof delta === 'number'
          ? Math.abs(delta) <= 0.05
          : true;
    const listingUrl = listingUrlFor(card);

    const row = document.createElement('tr');
    if (!withinBand || card.pricedCache?.action === 'price_drift') {
      row.className = 'listing-drift';
    }

    const titleCell = document.createElement('td');
    titleCell.textContent = cardLabel(card);
    row.appendChild(titleCell);

    const postedCell = document.createElement('td');
    postedCell.className = 'list-price';
    postedCell.textContent = posted == null ? '—' : money(posted);
    row.appendChild(postedCell);

    const marketCell = document.createElement('td');
    marketCell.textContent = market == null ? '—' : money(market);
    row.appendChild(marketCell);

    const deltaCell = document.createElement('td');
    deltaCell.textContent = formatDeltaPct(delta);
    row.appendChild(deltaCell);

    const healthCell = document.createElement('td');
    if (card.pricedCache?.action === 'price_drift' || withinBand === false) {
      const badge = document.createElement('span');
      badge.className = 'drift-badge';
      badge.textContent = 'Drift';
      healthCell.appendChild(badge);
    } else if (card.priceMonitor?.at) {
      healthCell.textContent = 'OK';
    } else {
      healthCell.textContent = '—';
    }
    row.appendChild(healthCell);

    const statusCell = document.createElement('td');
    if (listingUrl || card.status === 'listed') {
      const badge = document.createElement('span');
      badge.className = 'live-badge';
      badge.textContent = 'LIVE';
      statusCell.appendChild(badge);
      if (listingUrl) {
        statusCell.appendChild(document.createTextNode(' '));
        const link = document.createElement('a');
        link.href = listingUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'live-link';
        link.textContent = 'view';
        statusCell.appendChild(link);
      }
    } else if (card.status === 'drafted') {
      statusCell.textContent = 'draft';
    } else if (card.status === 'needs_review') {
      statusCell.textContent = 'review';
    } else {
      statusCell.textContent = card.status || '—';
    }
    row.appendChild(statusCell);

    tbody.appendChild(row);
  });
}

async function refreshIdentityBanner() {
  const banner = document.getElementById('identity-banner');
  if (!banner) {
    return;
  }
  const res = await fetch('/api/identity-status');
  if (!res.ok) {
    return;
  }
  const status = await res.json();
  if (!status.solo && status.vellumEnabled) {
    banner.hidden = false;
    banner.className = 'collectr-banner fresh';
    banner.innerHTML =
      '<strong>VellumAI dual</strong> — local ID cross-checks PokeGrade. Grades remain AI estimates (not PSA/CGC/BGS).';
    return;
  }
  if (status.solo) {
    banner.hidden = false;
    banner.className = 'collectr-banner stale';
    const why = status.circuit?.open
      ? `PokeGrade unavailable (${status.circuit.reason || 'quota'})`
      : 'IDENTITY_MODE=local-only';
    banner.innerHTML = `<strong>${why} — identifying with VellumAI solo.</strong> Comps from Collectr/TCG/eBay. <button type="button" id="reset-pg-circuit" class="banner-btn">Reset PokeGrade circuit</button>`;
    const btn = document.getElementById('reset-pg-circuit');
    if (btn) {
      btn.addEventListener('click', async () => {
        await fetch('/api/pokegrade-circuit/reset', { method: 'POST' });
        refreshIdentityBanner();
      });
    }
    return;
  }
  banner.hidden = true;
}

async function refreshCollectrBanner() {
  const banner = document.getElementById('collectr-banner');
  if (!banner) {
    return;
  }

  const res = await fetch('/api/collectr-status');
  if (!res.ok) {
    return;
  }
  const status = await res.json();
  banner.hidden = false;

  if (status.mode === 'api-v2') {
    if (!status.configured) {
      banner.className = 'collectr-banner stale';
      banner.innerHTML =
        '<strong>Collectr api-v2 incomplete.</strong> Set <code>COLLECTR_TOKEN</code> and <code>COLLECTR_USER_ID</code> in <code>.env</code> (from app localStorage <code>collectrToken</code>).';
      return;
    }
    if (status.lastError && status.rowCount === 0) {
      banner.className = 'collectr-banner stale';
      banner.innerHTML = `<strong>Collectr sync failed.</strong> ${status.lastError} — re-login on app.getcollectr.com and refresh <code>COLLECTR_TOKEN</code>, or fall back to CSV export.`;
      return;
    }
    const ageHours = status.ageHours == null ? '—' : status.ageHours.toFixed(1);
    if (status.stale) {
      banner.className = 'collectr-banner stale';
      banner.innerHTML = `<strong>Collectr portfolio sync stale</strong> (${status.rowCount} cards, ${ageHours}h old)${status.lastError ? ` — ${status.lastError}` : ''}. Auto-refresh runs in the background.`;
    } else {
      banner.className = 'collectr-banner fresh';
      banner.innerHTML = `<strong>Collectr api-v2 OK</strong> — ${status.rowCount} portfolio cards, last sync ${ageHours}h ago.`;
    }
    return;
  }

  if (!status.exists || status.rowCount === 0) {
    banner.className = 'collectr-banner stale';
    banner.innerHTML =
      '<strong>Collectr export missing.</strong> In Collectr: export portfolio as CSV to <code>Downloads\\export.csv</code> — this app auto-imports it. Reminder: refresh at least every 24 hours.';
    return;
  }

  const ageHours = status.ageHours == null ? null : status.ageHours.toFixed(1);
  const asOf = status.asOfDate ? `as of ${status.asOfDate}` : 'file date';
  if (status.stale) {
    banner.className = 'collectr-banner stale';
    banner.innerHTML = `<strong>Collectr comps are stale</strong> (${ageHours}h old, ${asOf}, ${status.rowCount} cards). Re-export from Collectr to <code>Downloads\\export.csv</code> — auto-import runs in the background. Aim for every 24 hours when listing.`;
  } else {
    banner.className = 'collectr-banner fresh';
    banner.innerHTML = `<strong>Collectr comps OK</strong> — ${status.rowCount} cards, ${ageHours}h old (${asOf}). Next reminder after 24h.`;
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const responseBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(responseBody.error || `Request failed with ${res.status}`);
  }
  return responseBody;
}

function confirmCard(id, price) {
  return postJson(`/api/cards/${id}/confirm`, { price }).then((result) => {
    if (result.published || result.listingUrl || result.status === 'listed') {
      const url = result.listingUrl || result.drafts?.mercari?.listingUrl;
      const link = url
        ? ` — <a href="${url}" target="_blank" rel="noopener noreferrer">open listing</a>`
        : '';
      showLiveToast(`<strong>LIVE</strong> on Mercari @ ${money(price)}${link}`);
    }
    return result;
  });
}

function skipCard(id) {
  return postJson(`/api/cards/${id}/skip`);
}

function createActionButton(className, label, onClick, options = {}) {
  const refreshAfter = options.refresh !== false;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', async () => {
    try {
      button.disabled = true;
      if (label === 'Go' || label === 'Repost') {
        window.alert(
          (label === 'Repost'
            ? 'This creates a NEW live Mercari listing at the new price.\nEnd the old listing manually if it is still up.\n\n'
            : '') +
            'This posts LIVE on Mercari (not a draft).\n\n' +
            'Chrome may open a dedicated Mercari window — log in there once if asked.',
        );
      }
      await onClick();
      if (refreshAfter) {
        poll();
      }
    } catch (err) {
      window.alert(err.message);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function photoRoleLabel(card, photoPath) {
  if (photoPath === card.frontImagePath) {
    return 'Front';
  }
  if (card.backImagePath && photoPath === card.backImagePath) {
    return 'Back';
  }
  if (!card.backImagePath && Array.isArray(card.photos)) {
    const inferred = card.photos.find((p) => p && p !== card.frontImagePath);
    if (inferred && photoPath === inferred) {
      return 'Back';
    }
  }
  return 'Extra';
}

async function setPhotoRoles(cardId, body) {
  const res = await fetch(`/api/cards/${cardId}/photos/roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  // Front changes re-run identity; give the pipeline a moment then refresh.
  if (body.frontImagePath) {
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  await refreshNeedsReview();
  await refreshDraftActivity();
}

async function setFrontFromInbox(cardId, name) {
  const res = await fetch(`/api/cards/${cardId}/photos/front-from-inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, rematchCloseups: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  await refreshNeedsReview();
  await refreshDraftActivity();
  return data;
}

function appendPhotoRoleEditor(main, card) {
  const photos = Array.isArray(card.photos) ? card.photos : [];

  const wrap = document.createElement('div');
  wrap.className = 'nr-photo-editor';

  const note = document.createElement('p');
  note.className = 'nr-card-meta';
  note.textContent =
    photos.length === 0
      ? 'No photos on this card yet — choose a front from the inbox below.'
      : 'Wrong front? Pick from this card’s photos, or choose the real full-card shot from the local inbox.';
  wrap.appendChild(note);

  if (photos.length > 0) {
    const strip = document.createElement('div');
    strip.className = 'nr-photo-strip';
    let selectedIndex = Math.max(
      0,
      photos.findIndex((p) => p === card.frontImagePath),
    );

    const buttons = document.createElement('div');
    buttons.className = 'nr-photo-role-actions';

    function syncSelection() {
      [...strip.querySelectorAll('.nr-photo-chip')].forEach((chip, index) => {
        chip.classList.toggle('nr-photo-chip-selected', index === selectedIndex);
      });
    }

    photos.forEach((photoPath, index) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'nr-photo-chip';
      chip.title = photoRoleLabel(card, photoPath);

      const img = document.createElement('img');
      img.alt = photoRoleLabel(card, photoPath);
      img.src = `/api/cards/${card.id}/photo?index=${index}`;
      chip.appendChild(img);

      const badge = document.createElement('span');
      badge.className = 'nr-photo-badge';
      badge.textContent = photoRoleLabel(card, photoPath);
      chip.appendChild(badge);

      chip.addEventListener('click', () => {
        selectedIndex = index;
        syncSelection();
      });
      strip.appendChild(chip);
    });
    wrap.appendChild(strip);
    syncSelection();

    if (photos.length > 1) {
      const setFront = createActionButton('nr-set-front-btn', 'Set front', async () => {
        const path = photos[selectedIndex];
        const body = { frontImagePath: path };
        if (card.backImagePath === path) {
          body.backImagePath = card.frontImagePath || null;
        }
        await setPhotoRoles(card.id, body);
      });
      const setBack = createActionButton('nr-set-back-btn', 'Set back', async () => {
        const path = photos[selectedIndex];
        if (path === card.frontImagePath) {
          window.alert('Pick a different photo for the back, or set this one as front first.');
          return;
        }
        await setPhotoRoles(card.id, { backImagePath: path });
      });
      buttons.appendChild(setFront);
      buttons.appendChild(setBack);
      wrap.appendChild(buttons);
    }
  }

  appendInboxFrontPicker(wrap, card, { expand: Boolean(card._expandInboxPicker) });
  main.appendChild(wrap);
}

async function fillInboxFrontGrid(section, grid, toggle, card) {
  toggle.textContent = 'Loading inbox…';
  const res = await fetch('/api/inbox/photos');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const list = Array.isArray(data.photos) ? data.photos : [];
  grid.innerHTML = '';
  if (list.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'nr-card-meta';
    empty.textContent = 'Inbox is empty — use Download photos first.';
    grid.appendChild(empty);
  } else {
    list.forEach((item) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'nr-photo-chip nr-inbox-chip';
      chip.title = item.usedByCardId
        ? `${item.name} (on card ${item.usedByCardId.slice(0, 8)}…)`
        : item.name;

      const img = document.createElement('img');
      img.alt = item.name;
      img.loading = 'lazy';
      img.src = `/api/inbox/file?name=${encodeURIComponent(item.name)}`;
      chip.appendChild(img);

      const badge = document.createElement('span');
      badge.className = 'nr-photo-badge';
      badge.textContent = item.name.replace(/\.[^.]+$/, '');
      chip.appendChild(badge);

      chip.addEventListener('click', async () => {
        if (
          !window.confirm(
            `Use ${item.name} as the front for this card?\nCorners near this shot will be rematched and identity will re-scan.`,
          )
        ) {
          return;
        }
        chip.disabled = true;
        try {
          await setFrontFromInbox(card.id, item.name);
        } catch (err) {
          window.alert(err.message || String(err));
          chip.disabled = false;
        }
      });
      grid.appendChild(chip);
    });
  }
  section.dataset.loaded = '1';
  grid.hidden = false;
  toggle.textContent = 'Hide inbox photos';
}

function appendInboxFrontPicker(wrap, card, { expand = false } = {}) {
  const section = document.createElement('div');
  section.className = 'nr-inbox-picker';

  const heading = document.createElement('p');
  heading.className = 'nr-card-meta';
  heading.textContent = 'Choose front from local inbox';
  section.appendChild(heading);

  const hint = document.createElement('p');
  hint.className = 'nr-inbox-picker-hint';
  hint.textContent = 'Select the full-card face from your inbox folder. Matching corner shots are pulled in and identity re-runs.';
  section.appendChild(hint);

  const grid = document.createElement('div');
  grid.className = 'nr-inbox-photo-grid';
  grid.hidden = true;

  // Do not poll() after browse — a full Needs Review rebuild would wipe the open grid.
  const toggle = createActionButton(
    'nr-inbox-picker-toggle',
    'Browse inbox photos',
    async () => {
      if (section.dataset.loaded === '1') {
        grid.hidden = !grid.hidden;
        toggle.textContent = grid.hidden ? 'Browse inbox photos' : 'Hide inbox photos';
        return;
      }
      await fillInboxFrontGrid(section, grid, toggle, card);
    },
    { refresh: false },
  );
  section.appendChild(toggle);
  section.appendChild(grid);
  wrap.appendChild(section);

  if (expand) {
    fillInboxFrontGrid(section, grid, toggle, card).catch((err) => {
      window.alert(err.message || String(err));
      toggle.textContent = 'Browse inbox photos';
    });
  }
}

function collectOpenInboxPickerIds(listEl) {
  const openIds = new Set();
  if (!listEl) {
    return openIds;
  }
  listEl.querySelectorAll('.nr-item[data-card-id]').forEach((el) => {
    const picker = el.querySelector('.nr-inbox-picker');
    const grid = el.querySelector('.nr-inbox-photo-grid');
    if (picker?.dataset.loaded === '1' && grid && !grid.hidden) {
      openIds.add(el.dataset.cardId);
    }
  });
  return openIds;
}

async function refreshNeedsReview() {
  const res = await fetch('/api/cards?status=needs_review');
  if (!res.ok) {
    return;
  }
  const cards = await res.json();

  const list = document.getElementById('needs-review-body');
  const openInboxIds = collectOpenInboxPickerIds(list);
  list.innerHTML = '';
  cards.forEach((card) => {
    if (openInboxIds.has(card.id)) {
      card._expandInboxPicker = true;
    }
    const comps = card.pricedCache?.comps || {};
    const listPrice = suggestedListPrice(card.pricedCache?.suggested);

    const item = document.createElement('article');
    item.className = 'nr-item';
    item.dataset.cardId = card.id;

    const main = document.createElement('div');
    main.className = 'nr-main';

    const name = document.createElement('p');
    name.className = 'nr-card-name';
    name.textContent = cardLabel(card);
    main.appendChild(name);

    const meta = document.createElement('p');
    meta.className = 'nr-card-meta';
    meta.textContent = cardMeta(card);
    main.appendChild(meta);

    appendPhotoRoleEditor(main, card);

    const identities = card.pricedCache?.identities;
    if (identities && (identities.pokegrade || identities.vellum)) {
      const idRow = document.createElement('p');
      idRow.className = 'nr-card-meta';
      const pg = identities.pokegrade;
      const vel = identities.vellum;
      const fmt = (id) =>
        id ? [id.name, id.number, id.set || id.setCode].filter(Boolean).join(' · ') : '—';
      idRow.textContent = `PokeGrade: ${fmt(pg)} | VellumAI: ${fmt(vel)} (${card.pricedCache?.idSource || '—'})`;
      main.appendChild(idRow);
    }

    const grading = card.pricedCache?.grading;
    if (grading && (grading.overall != null || grading.centering != null)) {
      const gradeRow = document.createElement('p');
      gradeRow.className = 'nr-card-meta';
      gradeRow.textContent = `AI grade estimate (not PSA): overall ${grading.overall ?? '—'} · C ${grading.centering ?? '—'} / Co ${grading.corners ?? '—'} / E ${grading.edges ?? '—'} / S ${grading.surface ?? '—'}`;
      main.appendChild(gradeRow);
    }

    const reason = document.createElement('div');
    reason.className = 'nr-reason';
    reason.textContent = `Why review: ${reviewReason(card)}`;
    main.appendChild(reason);

    const draftError = card.drafts?.mercari?.error || card.drafts?.ebay?.error;
    if (draftError) {
      const err = document.createElement('div');
      err.className = 'nr-reason';
      err.textContent = `Last draft error: ${draftError}`;
      main.appendChild(err);
    }

    const compsList = document.createElement('ul');
    compsList.className = 'nr-comps';
    const rows = [
      ['PokeGrade (raw)', comps.pokegrade, 'not returned'],
      ['Collectr', comps.collectr, 'no Collectr match'],
      ['TCGPlayer market', comps.tcgplayer, 'no API keys / invalid keys'],
      ['JustTCG market', comps.justtcg, 'no JUSTTCG_API_KEY in .env'],
      ['PokéWallet market', comps.pokewallet, 'no POKEWALLET_API_KEY in .env'],
      ['RapidAPI TCG market', comps.rapidapi, 'no RAPIDAPI_KEY in .env'],
      ['eBay last~5 sold median', comps.ebay, 'no API keys / awaiting approval'],
    ];
    rows.forEach(([label, value, missing]) => {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = label;
      const right = document.createElement('span');
      if (typeof value === 'number') {
        right.textContent = money(value);
      } else {
        right.className = 'muted';
        right.textContent = missing;
      }
      li.appendChild(left);
      li.appendChild(right);
      compsList.appendChild(li);
    });
    main.appendChild(compsList);

    const suggest = document.createElement('p');
    suggest.className = 'nr-card-meta';
    const monitor = card.priceMonitor;
    const isDrift = card.pricedCache?.action === 'price_drift' || monitor?.withinBand === false;
    if (isDrift && monitor) {
      suggest.textContent = `Posted ${money(monitor.posted)} → market ${
        monitor.market == null ? '—' : money(monitor.market)
      } (${formatDeltaPct(monitor.delta)}). Suggested list: ${
        listPrice === null ? '—' : money(listPrice)
      }. Repost creates a new listing — end the old one manually if still live.`;
    } else {
      suggest.textContent =
        listPrice === null
          ? 'Suggested list: —'
          : `Suggested list: ${money(listPrice)} (median of available comps × marketplace multiplier, rounded)`;
    }
    main.appendChild(suggest);

    const actions = document.createElement('div');
    actions.className = 'nr-actions';
    const priceInput = document.createElement('input');
    priceInput.type = 'number';
    priceInput.className = 'nr-price-input';
    priceInput.value = listPrice === null ? '' : listPrice;
    priceInput.setAttribute('aria-label', 'List price');
    actions.appendChild(priceInput);
    actions.appendChild(
      createActionButton(
        'nr-confirm-btn',
        isDrift ? 'Repost' : 'Go',
        () => confirmCard(card.id, Number(priceInput.value)),
      ),
    );
    actions.appendChild(createActionButton('nr-skip-btn', 'Skip', () => skipCard(card.id)));
    main.appendChild(actions);

    item.appendChild(main);
    list.appendChild(item);
  });
}

function formatRatio(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
    return '—';
  }
  return `${ratio.toFixed(2)}×`;
}

function sniperSource(item) {
  if (item?.source) {
    return item.source;
  }
  const id = String(item?.itemId || '');
  if (id.startsWith('hibid:')) {
    return 'hibid';
  }
  if (id.startsWith('facebook:')) {
    return 'facebook';
  }
  return 'mercari';
}

function sniperRawId(itemId) {
  return String(itemId || '').replace(/^(hibid|facebook|mercari):/, '');
}

function sniperListingUrl(item) {
  if (item?.listingUrl) {
    return item.listingUrl;
  }
  const id = sniperRawId(item?.itemId);
  if (!id) {
    return null;
  }
  const source = sniperSource(item);
  if (source === 'hibid') {
    return `https://hibid.com/lot/${id}`;
  }
  if (source === 'facebook') {
    return `https://www.facebook.com/marketplace/item/${id}`;
  }
  return `https://www.mercari.com/item/${id}/`;
}

function sniperThumbUrl(item) {
  if (item?.imageUrl) {
    return item.imageUrl;
  }
  if (sniperSource(item) === 'mercari') {
    const id = sniperRawId(item?.itemId);
    return id ? `https://u-mercari-images.mercdn.net/photos/${id}_1.jpg` : null;
  }
  return null;
}

function sniperCardLabel(item) {
  const identity = item.identity;
  if (identity?.name) {
    return [identity.name, identity.number, identity.set].filter(Boolean).join(' · ');
  }
  return item.title || item.itemId || 'Listing';
}

function sniperModeLabel(mode) {
  if (mode === 'raw-crack') {
    return 'raw-crack';
  }
  if (mode === 'graded-under') {
    return 'graded';
  }
  return mode || '—';
}

function ratioClass(ratio, lane) {
  if (lane === 'suspect') {
    return 'ratio-suspect';
  }
  if (lane === 'worklist') {
    return 'ratio-worklist';
  }
  if (typeof ratio === 'number' && ratio >= 1.25) {
    return 'ratio-heart';
  }
  return '';
}

function formatRelativeTime(iso) {
  if (!iso) {
    return '';
  }
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return '';
  }
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return new Date(then).toLocaleDateString();
}

function renderSniperTable(tbody, items, emptyText, lane) {
  tbody.innerHTML = '';
  if (!items || items.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'scalper-empty';
    cell.textContent = emptyText;
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  items.forEach((item) => {
    const row = document.createElement('tr');

    const thumbCell = document.createElement('td');
    thumbCell.className = 'scalper-thumb-cell';
    const thumbPair = document.createElement('div');
    thumbPair.className = 'scalper-thumb-pair';
    const thumbUrl = sniperThumbUrl(item);
    if (thumbUrl) {
      const img = document.createElement('img');
      img.className = 'scalper-thumb';
      img.src = thumbUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        img.replaceWith(document.createTextNode(''));
      });
      thumbPair.appendChild(img);
    }
    if (item.officialArtUrl) {
      const art = document.createElement('img');
      art.className = 'scalper-thumb scalper-thumb-official';
      art.src = item.officialArtUrl;
      art.alt = 'Official art';
      art.title = 'Official art (verify ID)';
      art.loading = 'lazy';
      art.referrerPolicy = 'no-referrer';
      art.addEventListener('error', () => {
        art.replaceWith(document.createTextNode(''));
      });
      thumbPair.appendChild(art);
    }
    if (thumbPair.childNodes.length) {
      thumbCell.appendChild(thumbPair);
    }
    row.appendChild(thumbCell);

    const cardCell = document.createElement('td');
    cardCell.className = 'scalper-card-cell';
    const link = document.createElement('a');
    link.className = 'scalper-item-link';
    link.href = sniperListingUrl(item) || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = sniperCardLabel(item);
    cardCell.appendChild(link);
    const meta = document.createElement('div');
    meta.className = 'scalper-item-meta';
    const parts = [sniperSource(item), item.itemId, formatRelativeTime(item.at)].filter(Boolean);
    meta.textContent = parts.join(' · ');
    cardCell.appendChild(meta);
    row.appendChild(cardCell);

    const askCell = document.createElement('td');
    askCell.textContent = typeof item.ask === 'number' ? money(item.ask) : '—';
    row.appendChild(askCell);

    const mktCell = document.createElement('td');
    mktCell.className = 'list-price';
    mktCell.textContent = typeof item.market === 'number' ? money(item.market) : '—';
    row.appendChild(mktCell);

    const ratioCell = document.createElement('td');
    ratioCell.className = `scalper-ratio ${ratioClass(item.ratio, lane)}`;
    ratioCell.textContent = formatRatio(item.ratio);
    row.appendChild(ratioCell);

    const stratCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'strat-badge';
    badge.textContent = sniperModeLabel(item.mode);
    stratCell.appendChild(badge);
    row.appendChild(stratCell);

    tbody.appendChild(row);
  });
}

function renderStrategyChips(container, strategies) {
  container.innerHTML = '';
  (strategies || []).forEach((strategy) => {
    const chip = document.createElement('span');
    chip.className = 'strategy-chip';
    const grade = strategy.grade != null ? ` PSA ${strategy.grade}` : '';
    const market = strategy.marketplace && strategy.marketplace !== 'mercari' ? ` · ${strategy.marketplace}` : '';
    chip.textContent = `${sniperModeLabel(strategy.mode)}${grade}${market}: ${strategy.query || strategy.id}`;
    container.appendChild(chip);
  });
}

function updateThresholdChips(thresholds) {
  const heart = thresholds?.heartRatio ?? 1.25;
  const workMin = thresholds?.worklistMin ?? 1.15;
  const suspect = thresholds?.suspectRatio ?? 5;
  const root = document.getElementById('scalper-thresholds');
  if (!root) {
    return;
  }
  root.innerHTML = '';
  const chips = [
    ['threshold-heart', `≥${heart}× heart`],
    ['threshold-worklist', `${workMin}–${heart}× worklist`],
    ['threshold-suspect', `≥${suspect}× suspect`],
  ];
  chips.forEach(([cls, text]) => {
    const span = document.createElement('span');
    span.className = `threshold-chip ${cls}`;
    span.textContent = text;
    root.appendChild(span);
  });
}

async function refreshSniper() {
  const statusEl = document.getElementById('scalper-status');
  const badgeEl = document.getElementById('scalper-armed-badge');
  const heartedEl = document.getElementById('sniper-hearted');
  const worklistCountEl = document.getElementById('sniper-worklist-count');
  const suspectsEl = document.getElementById('sniper-suspects');
  const seenEl = document.getElementById('sniper-seen');
  const cycleHeartedEl = document.getElementById('sniper-cycle-hearted');
  const intervalEl = document.getElementById('sniper-interval');
  const cycleNoteEl = document.getElementById('scalper-cycle-note');
  const strategiesWrap = document.getElementById('scalper-strategies');
  const strategyChips = document.getElementById('scalper-strategy-chips');
  const recentEl = document.getElementById('sniper-recent-hearts');
  const worklistItemsEl = document.getElementById('sniper-worklist-items');
  const suspectItemsEl = document.getElementById('sniper-suspect-items');
  if (!statusEl || !heartedEl || !recentEl) {
    return;
  }

  try {
    const res = await fetch('/api/sniper');
    if (!res.ok) {
      return;
    }
    const data = await res.json();
    heartedEl.textContent = String(data.heartedCount ?? 0);
    worklistCountEl.textContent = String(data.worklistCount ?? 0);
    suspectsEl.textContent = String(data.suspectCount ?? 0);
    seenEl.textContent = String(data.seenCount ?? 0);

    updateThresholdChips(data.thresholds);

    if (badgeEl) {
      badgeEl.classList.remove('scalper-badge-off', 'scalper-badge-armed', 'scalper-badge-scanning');
      if (!data.enabled) {
        badgeEl.textContent = 'OFF';
        badgeEl.classList.add('scalper-badge-off');
      } else if (data.running) {
        badgeEl.textContent = 'SCANNING';
        badgeEl.classList.add('scalper-badge-scanning');
      } else {
        badgeEl.textContent = 'ARMED';
        badgeEl.classList.add('scalper-badge-armed');
      }
    }

    if (!data.enabled) {
      statusEl.innerHTML =
        'scans Mercari, HiBid, and Facebook Marketplace · PokeGrade photos + title/description vs ask · <strong>off</strong> (set SNIPER_ENABLED=true)';
      intervalEl.textContent = '—';
      cycleHeartedEl.textContent = '—';
      cycleNoteEl.textContent = 'Sniper disabled — sell-side lister still runs normally.';
    } else {
      const mins = Math.max(1, Math.round((data.intervalMs || 600000) / 60000));
      intervalEl.textContent = `${mins}m`;
      statusEl.innerHTML =
        `scans Mercari / HiBid / Facebook every <strong>${mins} min</strong> · PokeGrade photos + title/description vs ask · ≥1.25× · <span class="live-mode">never buys or bids</span>`;

      const last = data.lastCycle;
      if (last?.finishedAt) {
        cycleHeartedEl.textContent = String(last.hearted ?? 0);
        const when = formatRelativeTime(last.finishedAt);
        cycleNoteEl.textContent = last.error
          ? `Last cycle failed ${when}: ${last.error}`
          : `Last cycle ${when}: ♥ ${last.hearted ?? 0} · worklist ${last.worklist ?? 0} · suspect ${last.suspects ?? 0} · deferred ${last.deferred ?? 0} · skipped ${last.skipped ?? 0}`;
      } else {
        cycleHeartedEl.textContent = '—';
        cycleNoteEl.textContent = 'Armed — waiting for first scan cycle…';
      }
    }

    if (strategiesWrap && strategyChips) {
      if (data.enabled && (data.strategies || []).length > 0) {
        strategiesWrap.hidden = false;
        renderStrategyChips(strategyChips, data.strategies);
      } else {
        strategiesWrap.hidden = true;
      }
    }

    renderSniperTable(recentEl, data.recentHearts, 'No hearts yet — clear deals will show here.', 'heart');
    renderSniperTable(worklistItemsEl, data.worklist, 'Worklist empty.', 'worklist');
    renderSniperTable(suspectItemsEl, data.suspects, 'No suspect outliers flagged.', 'suspect');
  } catch {
    // ignore poll errors
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPct(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '—';
  }
  const rounded = value.toFixed(1);
  return `${value > 0 ? '+' : ''}${rounded}%`;
}

function pctClass(value) {
  if (typeof value !== 'number') {
    return '';
  }
  if (value > 0) {
    return 'research-pos';
  }
  if (value < 0) {
    return 'research-neg';
  }
  return '';
}

function researchEmptyRow(colspan, text) {
  return `<tr><td class="scalper-empty" colspan="${colspan}">${text}</td></tr>`;
}

function renderResearchSets(tbody, sets) {
  if (!tbody) {
    return;
  }
  if (!Array.isArray(sets) || sets.length === 0) {
    tbody.innerHTML = researchEmptyRow(5, 'No set rankings yet — run research.');
    return;
  }
  tbody.innerHTML = sets
    .map((set) => {
      const change = set.change7d ?? set.changeSinceLast;
      return `<tr>
        <td>
          <div class="scalper-card-cell">${escapeHtml(set.set || 'Unknown set')}</div>
          <div class="scalper-item-meta">${escapeHtml(set.setCode || '')} · ${set.cardCount ?? 0} cards</div>
        </td>
        <td>${typeof set.totalMarket === 'number' ? money(set.totalMarket) : '—'}</td>
        <td>${typeof set.sealedMarket === 'number' ? money(set.sealedMarket) : '—'}</td>
        <td class="${pctClass(change)}">${formatPct(change)}</td>
        <td>${typeof set.score === 'number' ? set.score.toFixed(1) : '—'}</td>
      </tr>`;
    })
    .join('');
}

function renderResearchCards(tbody, cards) {
  if (!tbody) {
    return;
  }
  if (!Array.isArray(cards) || cards.length === 0) {
    tbody.innerHTML = researchEmptyRow(5, 'No card movers yet — run research (needs JUSTTCG_API_KEY for live 7d/30d).');
    return;
  }
  tbody.innerHTML = cards
    .map((card) => {
      const flags = Array.isArray(card.flags) && card.flags.length ? ` · ${card.flags.join(', ')}` : '';
      return `<tr>
        <td>
          <div class="scalper-card-cell">${escapeHtml(card.name || 'Unknown card')}</div>
          <div class="scalper-item-meta">${escapeHtml([card.number, card.set].filter(Boolean).join(' · '))}${escapeHtml(flags)}</div>
        </td>
        <td>${typeof card.price === 'number' ? money(card.price) : '—'}</td>
        <td class="${pctClass(card.change7d)}">${formatPct(card.change7d)}</td>
        <td class="${pctClass(card.change30d)}">${formatPct(card.change30d)}</td>
        <td>${typeof card.score === 'number' ? card.score.toFixed(1) : '—'}</td>
      </tr>`;
    })
    .join('');
}

async function refreshResearch() {
  const statusEl = document.getElementById('research-status');
  const badgeEl = document.getElementById('research-badge');
  const cardCountEl = document.getElementById('research-card-count');
  const setCountEl = document.getElementById('research-set-count');
  const lastRunEl = document.getElementById('research-last-run');
  const sourcesEl = document.getElementById('research-sources');
  const setsBody = document.getElementById('research-sets-body');
  const cardsBody = document.getElementById('research-cards-body');
  if (!statusEl || !setsBody || !cardsBody) {
    return;
  }

  try {
    const res = await fetch('/api/research');
    if (!res.ok) {
      return;
    }
    const data = await res.json();
    if (cardCountEl) cardCountEl.textContent = String((data.cards || []).length);
    if (setCountEl) setCountEl.textContent = String((data.sets || []).length);
    if (lastRunEl) {
      lastRunEl.textContent = data.lastRun ? formatRelativeTime(data.lastRun) : '—';
    }
    if (sourcesEl) {
      sourcesEl.textContent = (data.sources || []).length ? data.sources.join('+') : '—';
    }
    if (badgeEl) {
      badgeEl.classList.remove('scalper-badge-off', 'scalper-badge-armed', 'scalper-badge-scanning');
      if (data.running) {
        badgeEl.textContent = 'RUNNING';
        badgeEl.classList.add('scalper-badge-scanning');
      } else if (data.lastRun) {
        badgeEl.textContent = 'READY';
        badgeEl.classList.add('scalper-badge-armed');
      } else {
        badgeEl.textContent = 'IDLE';
        badgeEl.classList.add('scalper-badge-off');
      }
    }
    if (data.running) {
      statusEl.textContent = 'Research run in progress…';
    } else if (data.error) {
      statusEl.textContent = `Last run ${data.lastRun ? formatRelativeTime(data.lastRun) : ''}: ${data.error}`;
    } else if (data.lastRun) {
      statusEl.textContent = `Last run ${formatRelativeTime(data.lastRun)} · ${(data.sources || []).join(', ') || 'no sources'}`;
    } else {
      statusEl.textContent = 'No research run yet.';
    }
    renderResearchSets(setsBody, data.sets);
    renderResearchCards(cardsBody, data.cards);
  } catch {
    // ignore poll errors
  }
}

const runResearchBtn = document.getElementById('run-research-btn');
if (runResearchBtn) {
  runResearchBtn.addEventListener('click', async () => {
    runResearchBtn.disabled = true;
    const statusEl = document.getElementById('research-status');
    if (statusEl) statusEl.textContent = 'Running research…';
    try {
      const res = await fetch('/api/research/run', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Research failed (${res.status})`);
      }
      if (statusEl) {
        statusEl.textContent = `Ranked ${data.cards?.length ?? 0} cards · ${data.sets?.length ?? 0} sets`;
      }
      await refreshResearch();
    } catch (err) {
      if (statusEl) statusEl.textContent = `Error: ${err.message}`;
    } finally {
      runResearchBtn.disabled = false;
    }
  });
}

/** @type {{ files: File[], frontIndex: number, urls: string[] }} */
const scannerState = { files: [], frontIndex: 0, urls: [] };

function formatMoney(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }
  return `$${value.toFixed(2)}`;
}

function renderScannerThumbs() {
  const root = document.getElementById('scanner-thumbs');
  const runBtn = document.getElementById('scanner-run-btn');
  if (!root) {
    return;
  }
  scannerState.urls.forEach((url) => URL.revokeObjectURL(url));
  scannerState.urls = scannerState.files.map((file) => URL.createObjectURL(file));
  root.innerHTML = '';
  scannerState.files.forEach((file, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `scanner-thumb-btn${index === scannerState.frontIndex ? ' is-front' : ''}`;
    btn.title = index === scannerState.frontIndex ? 'Front (selected)' : 'Tap to set as front';
    const img = document.createElement('img');
    img.src = scannerState.urls[index];
    img.alt = file.name || `Photo ${index + 1}`;
    btn.appendChild(img);
    btn.addEventListener('click', () => {
      scannerState.frontIndex = index;
      renderScannerThumbs();
    });
    root.appendChild(btn);
  });
  if (runBtn) {
    runBtn.disabled = scannerState.files.length === 0;
  }
}

function renderScannerResult(data) {
  const root = document.getElementById('scanner-result');
  const shell = document.getElementById('pokedex-shell');
  if (!root) {
    return;
  }
  root.hidden = false;
  root.innerHTML = '';
  if (shell) {
    shell.classList.toggle('is-lit', Boolean(data?.ok));
    shell.classList.toggle('is-warn', !data?.ok);
  }

  const identity = data.identity;
  const title = identity?.name
    ? [identity.name, identity.number, identity.set].filter(Boolean).join(' · ')
    : 'No identity';

  const layout = document.createElement('div');
  layout.className = 'scanner-result-layout';

  // ── Photo pair: uploaded shot + official art ─────────────────────────────
  const photoPair = document.createElement('div');
  photoPair.className = 'scanner-photo-pair';

  if (data.scanDir != null && data.frontIndex != null) {
    const uploaded = document.createElement('img');
    uploaded.className = 'scanner-photo scanner-photo-uploaded';
    uploaded.src = `/api/scan-photo?dir=${encodeURIComponent(data.scanDir)}&index=${data.frontIndex}`;
    uploaded.alt = 'Your scan';
    uploaded.title = 'Your scan';
    photoPair.appendChild(uploaded);
  }

  if (data.officialArtUrl) {
    const art = document.createElement('img');
    art.className = 'scanner-photo scanner-photo-official';
    art.src = data.officialArtUrl;
    art.alt = 'Official art';
    art.loading = 'lazy';
    art.referrerPolicy = 'no-referrer';
    photoPair.appendChild(art);
  }

  layout.appendChild(photoPair);

  // ── Meta column ──────────────────────────────────────────────────────────
  const meta = document.createElement('div');
  meta.className = 'scanner-result-meta';

  const titleRow = document.createElement('div');
  titleRow.className = 'scanner-title-row';
  const h = document.createElement('p');
  h.className = 'scanner-result-title';
  h.textContent = title;
  titleRow.appendChild(h);

  if (data.vellumConfidence) {
    const badge = document.createElement('span');
    const level = data.vellumConfidence;
    badge.className = `scan-confidence-badge scan-confidence-${level}`;
    badge.textContent = level.toUpperCase();
    titleRow.appendChild(badge);
  }

  meta.appendChild(titleRow);

  const detail = document.createElement('p');
  detail.className = 'muted';
  const sources = Array.isArray(data.pricingSources) ? data.pricingSources.join(', ') : '';
  detail.textContent = [
    data.ok ? 'Identified' : 'Not identified',
    data.mode ? `mode: ${data.mode}` : null,
    data.action || null,
    data.reason || null,
    sources ? `pricing: ${sources}` : 'pricing: none',
  ]
    .filter(Boolean)
    .join(' · ');
  meta.appendChild(detail);

  if (data.identityConflict && Array.isArray(data.candidates) && data.candidates.length > 0) {
    const conflictWrap = document.createElement('div');
    conflictWrap.className = 'scan-candidates';
    const conflictLabel = document.createElement('p');
    conflictLabel.className = 'scan-candidates-label';
    conflictLabel.textContent = 'Identity conflict — candidates:';
    conflictWrap.appendChild(conflictLabel);
    data.candidates.slice(0, 5).forEach((c) => {
      const row = document.createElement('p');
      row.className = 'scan-candidate-row';
      const name = c?.name || c?.identity?.name || String(c);
      const conf = c?.confidence ? ` [${c.confidence}]` : '';
      row.textContent = `${name}${conf}`;
      conflictWrap.appendChild(row);
    });
    meta.appendChild(conflictWrap);
  }

  if (data.suggested) {
    const sug = document.createElement('p');
    sug.className = 'scanner-suggested';
    sug.textContent = `Suggested · Mercari ${formatMoney(data.suggested.mercari)} · eBay ${formatMoney(data.suggested.ebay)}`;
    meta.appendChild(sug);
  }

  const comps = data.comps || {};
  const pricingSources = new Set(Array.isArray(data.pricingSources) ? data.pricingSources : []);
  const table = document.createElement('table');
  table.className = 'scanner-comps';
  table.innerHTML = '<thead><tr><th>Source</th><th>Value</th></tr></thead>';
  const tbody = document.createElement('tbody');
  const rows = [
    ['pokegrade', comps.pokegrade],
    ['collectr', comps.collectr],
    ['tcgplayer', comps.tcgplayer],
    ['ebay', comps.ebay],
    ['justtcg', comps.justtcg],
    ['rapidapi', comps.rapidapi],
    ['pokewallet', comps.pokewallet],
  ];
  rows.forEach(([name, value]) => {
    const tr = document.createElement('tr');
    if (pricingSources.has(name)) {
      tr.className = 'scanner-comp-active';
    }
    const tdN = document.createElement('td');
    tdN.textContent = name;
    const tdV = document.createElement('td');
    tdV.textContent = formatMoney(typeof value === 'number' ? value : null);
    tr.appendChild(tdN);
    tr.appendChild(tdV);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  meta.appendChild(table);
  layout.appendChild(meta);
  root.appendChild(layout);

  // ── Verification grid ────────────────────────────────────────────────────
  if (data.gridPngB64) {
    const gridWrap = document.createElement('div');
    gridWrap.className = 'scan-verify-grid-wrap';
    const label = document.createElement('p');
    label.className = 'scan-verify-grid-label';
    label.textContent = 'Candidate verification grid';
    gridWrap.appendChild(label);
    const gridImg = document.createElement('img');
    gridImg.className = 'scan-verify-grid';
    gridImg.src = `data:image/png;base64,${data.gridPngB64}`;
    gridImg.alt = 'Verification grid';
    gridWrap.appendChild(gridImg);
    root.appendChild(gridWrap);
  }
}

function bindScannerUi() {
  const fileInput = document.getElementById('scanner-files');
  const pickBtn = document.getElementById('scanner-pick-btn');
  const runBtn = document.getElementById('scanner-run-btn');
  const status = document.getElementById('scanner-status');
  const shell = document.getElementById('pokedex-shell');
  if (!fileInput || !pickBtn || !runBtn) {
    return;
  }

  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    scannerState.files = Array.from(fileInput.files || []);
    scannerState.frontIndex = 0;
    const result = document.getElementById('scanner-result');
    if (result) {
      result.hidden = true;
      result.innerHTML = '';
    }
    if (shell) {
      shell.classList.remove('is-lit', 'is-scanning', 'is-warn');
    }
    if (status) {
      status.textContent = scannerState.files.length
        ? `${scannerState.files.length} photo(s) — tap a thumb to mark front, then Scan`
        : '';
    }
    renderScannerThumbs();
  });

  runBtn.addEventListener('click', async () => {
    if (!scannerState.files.length) {
      return;
    }
    runBtn.disabled = true;
    pickBtn.disabled = true;
    if (shell) {
      shell.classList.add('is-scanning');
      shell.classList.remove('is-lit', 'is-warn');
    }
    if (status) {
      status.textContent = 'Scanning — identify + pricing…';
    }
    try {
      const body = new FormData();
      scannerState.files.forEach((file) => body.append('photos', file, file.name));
      body.append('frontIndex', String(scannerState.frontIndex));
      const res = await fetch('/api/scan', { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Scan failed (${res.status})`);
      }
      renderScannerResult(data);
      const priced = Array.isArray(data.pricingSources) ? data.pricingSources.length : 0;
      if (status) {
        status.textContent = data.ok
          ? `Done — ${priced} pricing source(s)${data.suggested ? ` · suggest $${data.suggested.mercari}` : ''}`
          : `No ID — ${data.reason || 'unknown'}`;
      }
    } catch (err) {
      if (shell) {
        shell.classList.remove('is-lit');
      }
      if (status) {
        status.textContent = `Error: ${err.message}`;
      }
    } finally {
      if (shell) {
        shell.classList.remove('is-scanning');
      }
      runBtn.disabled = scannerState.files.length === 0;
      pickBtn.disabled = false;
    }
  });
}

bindScannerUi();

function poll() {
  refreshStats();
  refreshCollectrBanner();
  refreshIdentityBanner();
  refreshInboxStatus();
  refreshMarketplaceStatus();
  refreshDraftActivity();
  refreshNeedsReview();
  refreshSniper();
  refreshResearch();
}

poll();
setInterval(poll, POLL_INTERVAL_MS);
