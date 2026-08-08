import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const html = readFileSync(path.join('public', 'index.html'), 'utf8');
const js = readFileSync(path.join('public', 'app.js'), 'utf8');
const css = readFileSync(path.join('public', 'styles.css'), 'utf8');

test('header shows the AUTO-LISTER draft activity title', () => {
  assert.match(html, /\/\/\s*AUTO-LISTER\s*—\s*DRAFT ACTIVITY/);
});

test('status copy mentions DRAFT MODE and never publishes', () => {
  assert.match(html, /DRAFT MODE/);
  assert.match(html, /never publishes/);
});

test('add-card panel has file input, thumbnails container, and Add button', () => {
  assert.match(html, /id="photo-input"[^>]*type="file"[^>]*multiple/);
  assert.match(html, /class="photo-thumbnails"/);
  assert.match(html, /id="add-card-btn"/);
});

test('marketplace checkboxes default to both checked', () => {
  assert.match(html, /id="marketplace-mercari"[^>]*checked/);
  assert.match(html, /id="marketplace-ebay"[^>]*checked/);
});

test('draft activity table has title, VALUE, LIST, PHOTOS columns', () => {
  assert.match(html, /class="draft-activity-table"/);
  assert.match(html, />VALUE</);
  assert.match(html, />LIST</);
  assert.match(html, />PHOTOS</);
  assert.match(html, /id="draft-activity-body"/);
});

test('stats strip has drafts, total value, queue, needs review, errors, all-time', () => {
  for (const id of ['stat-drafts', 'stat-total-value', 'stat-queue', 'stat-needs-review', 'stat-errors', 'stat-all-time']) {
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

test('app.js submits the add-card form via fetch POST to /api/cards', () => {
  assert.match(js, /fetch\(\s*['"]\/api\/cards['"]/);
  assert.match(js, /method:\s*['"]POST['"]/);
});

test('styles.css defines the light card look and phone-friendly layout', () => {
  assert.match(css, /max-width/);
  assert.match(css, /\.draft-activity-table/);
});

test('needs review table has title, PG, TCG, EBAY, PRICE columns and an actions column', () => {
  assert.match(html, /class="draft-activity-table needs-review-table"/);
  assert.match(html, />PG</);
  assert.match(html, />TCG</);
  assert.match(html, />EBAY</);
  assert.match(html, />PRICE</);
  assert.match(html, />ACTIONS</);
  assert.match(html, /id="needs-review-body"/);
});

test('app.js confirms and skips needs-review cards via fetch POST', () => {
  assert.match(js, /\/api\/cards\/\$\{[^}]+\}\/confirm/);
  assert.match(js, /\/api\/cards\/\$\{[^}]+\}\/skip/);
  assert.match(js, /method:\s*['"]POST['"]/g);
});
