const POLL_INTERVAL_MS = 5000;

const photoInput = document.getElementById('photo-input');
const thumbnailsEl = document.getElementById('photo-thumbnails');
const addButton = document.getElementById('add-card-btn');
const statusEl = document.getElementById('add-card-status');

let selectedFiles = [];
let frontIndex = 0;

function renderThumbnails() {
  thumbnailsEl.innerHTML = '';
  selectedFiles.forEach((file, index) => {
    const wrapper = document.createElement('button');
    wrapper.type = 'button';
    wrapper.className = 'thumbnail' + (index === frontIndex ? ' thumbnail-front' : '');
    wrapper.setAttribute('data-index', String(index));

    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.alt = index === frontIndex ? 'Front photo' : `Photo ${index + 1}`;
    wrapper.appendChild(img);

    wrapper.addEventListener('click', () => {
      frontIndex = index;
      renderThumbnails();
    });

    thumbnailsEl.appendChild(wrapper);
  });
}

photoInput.addEventListener('change', () => {
  selectedFiles = Array.from(photoInput.files || []);
  frontIndex = 0;
  renderThumbnails();
});

addButton.addEventListener('click', async () => {
  if (selectedFiles.length === 0) {
    statusEl.textContent = 'Choose at least one photo first.';
    return;
  }

  const formData = new FormData();
  selectedFiles.forEach((file) => formData.append('photos', file, file.name));
  formData.append('frontIndex', String(frontIndex));
  formData.append('mercari', document.getElementById('marketplace-mercari').checked ? 'true' : 'false');
  formData.append('ebay', document.getElementById('marketplace-ebay').checked ? 'true' : 'false');

  addButton.disabled = true;
  statusEl.textContent = 'Adding…';

  try {
    const res = await fetch('/api/cards', { method: 'POST', body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed with ${res.status}`);
    }
    statusEl.textContent = 'Added to queue.';
    selectedFiles = [];
    frontIndex = 0;
    photoInput.value = '';
    renderThumbnails();
    refreshDraftActivity();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    addButton.disabled = false;
  }
});

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

async function refreshStats() {
  const res = await fetch('/api/stats');
  if (!res.ok) {
    return;
  }
  const stats = await res.json();
  document.getElementById('stat-drafts').textContent = stats.drafts;
  document.getElementById('stat-total-value').textContent = money(stats.totalListValue);
  document.getElementById('stat-queue').textContent = stats.queue;
  document.getElementById('stat-needs-review').textContent = stats.needsReview;
  document.getElementById('stat-errors').textContent = stats.errors;
  document.getElementById('stat-all-time').textContent = stats.allTime;
}

async function refreshDraftActivity() {
  const res = await fetch('/api/cards');
  if (!res.ok) {
    return;
  }
  const cards = await res.json();
  const priced = cards.filter((card) => card.pricedCache);

  const tbody = document.getElementById('draft-activity-body');
  tbody.innerHTML = '';
  priced.forEach((card) => {
    const value = baseValue(card.pricedCache.comps);
    const list = suggestedListPrice(card.pricedCache.suggested);

    const row = document.createElement('tr');

    const titleCell = document.createElement('td');
    titleCell.textContent = card.title || 'Pokemon Card';
    row.appendChild(titleCell);

    const valueCell = document.createElement('td');
    valueCell.textContent = value === null ? '—' : money(value);
    row.appendChild(valueCell);

    const listCell = document.createElement('td');
    listCell.className = 'list-price';
    listCell.textContent = list === null ? '—' : money(list);
    row.appendChild(listCell);

    const photosCell = document.createElement('td');
    photosCell.textContent = (card.photos || []).length;
    row.appendChild(photosCell);

    tbody.appendChild(row);
  });
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const responseBody = await res.json().catch(() => ({}));
    throw new Error(responseBody.error || `Request failed with ${res.status}`);
  }
}

function confirmCard(id, price) {
  return postJson(`/api/cards/${id}/confirm`, { price });
}

function skipCard(id) {
  return postJson(`/api/cards/${id}/skip`);
}

function createActionButton(className, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', async () => {
    try {
      await onClick();
      poll();
    } catch (err) {
      window.alert(err.message);
    }
  });
  return button;
}

async function refreshNeedsReview() {
  const res = await fetch('/api/cards?status=needs_review');
  if (!res.ok) {
    return;
  }
  const cards = await res.json();

  const tbody = document.getElementById('needs-review-body');
  tbody.innerHTML = '';
  cards.forEach((card) => {
    const comps = card.pricedCache?.comps || {};
    const list = suggestedListPrice(card.pricedCache?.suggested);

    const row = document.createElement('tr');

    const titleCell = document.createElement('td');
    titleCell.textContent = card.title || 'Pokemon Card';
    row.appendChild(titleCell);

    [comps.pokegrade, comps.tcgplayer, comps.ebay].forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = typeof value === 'number' ? money(value) : '—';
      row.appendChild(cell);
    });

    const priceCell = document.createElement('td');
    const priceInput = document.createElement('input');
    priceInput.type = 'number';
    priceInput.className = 'nr-price-input';
    priceInput.value = list === null ? '' : list;
    priceCell.appendChild(priceInput);
    row.appendChild(priceCell);

    const actionsCell = document.createElement('td');
    actionsCell.appendChild(
      createActionButton('nr-confirm-btn', 'Confirm', () => confirmCard(card.id, Number(priceInput.value))),
    );
    actionsCell.appendChild(createActionButton('nr-skip-btn', 'Skip', () => skipCard(card.id)));

    row.appendChild(actionsCell);
    tbody.appendChild(row);
  });
}

function poll() {
  refreshStats();
  refreshDraftActivity();
  refreshNeedsReview();
}

poll();
setInterval(poll, POLL_INTERVAL_MS);
