import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STRIP_LIMIT,
  finishChips,
  formatPrinting,
  renderChipGroup,
  renderTileStrip,
  setTiles,
  splitMore,
  versionTiles,
} from '../tools/extension-wasm/lib/option-strip.js';

const row = (id, set, number, extra = {}) => ({ id, name: 'Eevee', set, setCode: id.split('-')[0], number, imageUrl: `https://img.test/${id}.png`, ...extra });
const choices = [row('sv01-5', 'Scarlet & Violet', '005'), row('sv02-5', 'Paldea Evolved', '005'), row('pre-74', 'Prismatic Evolutions', '74')];

test('setTiles: one tile per catalog row with art, set and number; nothing for a single choice', () => {
  assert.deepEqual(setTiles({ setChoices: [choices[0]] }), []);
  const tiles = setTiles({ setChoices: choices, identity: choices[1], setConfirmed: false });
  assert.equal(tiles.length, 3);
  assert.deepEqual(tiles[2], {
    id: 'pre-74', name: 'Eevee', set: 'Prismatic Evolutions', number: '74', art: 'https://img.test/pre-74.png',
    sub: '#74', label: 'Prismatic Evolutions number 74', checked: false, suggested: false,
  });
});

test('setTiles: the confirmed printing is checked; a page guess is checked and suggested; an open one has nothing checked', () => {
  const confirmed = setTiles({ setChoices: choices, identity: choices[1], setConfirmed: true });
  assert.deepEqual(confirmed.map((t) => t.checked), [false, true, false]);
  assert.deepEqual(confirmed.map((t) => t.suggested), [false, false, false]);
  const guessed = setTiles({ setChoices: choices, identity: choices[1], setConfirmed: false, bestGuess: { source: 'hint' } });
  assert.deepEqual(guessed.map((t) => t.checked), [false, true, false]);
  assert.equal(guessed[1].suggested, true);
  assert.equal(guessed[1].label, 'Suggested: Paldea Evolved number 005');
  const open = setTiles({ setChoices: choices, identity: choices[1], setConfirmed: false });
  assert.deepEqual(open.map((t) => t.checked), [false, false, false]);
});

test('setTiles: art comes from the same thumb logic as candidate cards; a row with nothing to show has no art', () => {
  const tiles = setTiles({ setChoices: [{ id: 'a-1', name: 'X', set: 'S', setCode: 'sv02', number: '9' }, { id: 'b-1', name: 'X', set: 'T' }] });
  assert.equal(tiles[0].art, 'https://images.pokemontcg.io/sv02/9.png');
  assert.equal(tiles[1].art, null);
});

test('versionTiles: the shown card first and checked, then each other version with its name', () => {
  const card = {
    identity: { id: 'p-1', name: 'Pikachu ex', set: 'Surging Sparks', setCode: 'sv08', number: '57', imageUrl: 'https://img.test/p1.png' },
    versionChoices: [
      { id: 'p-2', name: 'Pikachu V', set: 'Vivid Voltage', setCode: 'swsh4', number: '43', imageUrl: 'https://img.test/p2.png', price_grid: { variants: { normal: { conditions: { NM: 2 } } } } },
      { id: 'p-3', name: 'Pikachu VSTAR', setChoices: [{ id: 'a' }, { id: 'b' }] },
    ],
  };
  const tiles = versionTiles(card, ['NM']);
  assert.deepEqual(tiles.map((t) => [t.id, t.name, t.checked]), [['p-1', 'Pikachu ex', true], ['p-2', 'Pikachu V', false], ['p-3', 'Pikachu VSTAR', false]]);
  assert.equal(tiles[1].art, 'https://img.test/p2.png');
  assert.equal(tiles[1].label, 'Pikachu V, Vivid Voltage #43, $2.00');
  assert.equal(tiles[0].keep, true);
  assert.deepEqual(versionTiles({ identity: { name: 'Mew' } }, ['NM']), []);
});

test('finishChips: label and price for the condition, chosen and suggested marked, no price means label only', () => {
  const grid = { variants: {
    normal: { conditions: { NM: 2, LP: 1.5 } },
    holofoil: { conditions: { NM: 10 } },
    reverseHolofoil: { conditions: {} },
  } };
  const chips = finishChips(grid, { chosen: 'holofoil', suggested: '', conditions: ['NM'] });
  assert.deepEqual(chips.map((c) => [c.key, c.label, c.priceText, c.checked]), [
    ['normal', 'Normal', '$2.00', false], ['holofoil', 'Holofoil', '$10.00', true], ['reverseHolofoil', 'Reverse Holo', '', false],
  ]);
  assert.equal(chips[2].aria, 'Reverse Holo');
  assert.equal(chips[1].aria, 'Holofoil, $10.00 NM');
  const lp = finishChips(grid, { chosen: '', suggested: 'normal', conditions: ['LP'] });
  assert.equal(lp[0].priceText, '$1.50');
  assert.equal(lp[0].suggested, true);
  assert.equal(lp[0].checked, false);
  assert.equal(lp[1].priceText, '');
});

test('finishChips: falls to the next enabled condition when the first has no price; none for one printing', () => {
  const grid = { variants: { normal: { conditions: { LP: 1.5 } }, holofoil: { conditions: { NM: 9 } } } };
  const chips = finishChips(grid, { chosen: '', suggested: '', conditions: ['NM', 'LP'] });
  assert.deepEqual(chips.map((c) => c.priceText), ['$1.50', '$9.00']);
  assert.deepEqual(finishChips({ variants: { normal: { conditions: { NM: 1 } } } }, { conditions: ['NM'] }), []);
});

test('formatPrinting prettifies grid keys', () => {
  assert.equal(formatPrinting('reverseHolofoil'), 'Reverse Holo');
  assert.equal(formatPrinting('1stEditionHolofoil'), '1st Ed Holofoil');
  assert.equal(formatPrinting('unlimitedHolofoil'), 'Unlimited Holo');
});

test('splitMore: up to 8 shown as they are; more than 8 shows the first 8 and keeps the rest behind More', () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  assert.equal(STRIP_LIMIT, 8);
  assert.deepEqual(splitMore(items.slice(0, 8)), { shown: items.slice(0, 8), more: [] });
  assert.deepEqual(splitMore(items), { shown: items.slice(0, 8), more: items.slice(8) });
});

const tile = (n, extra = {}) => ({ id: `id-${n}`, name: 'Eevee', set: `Set ${n}`, number: String(n), art: `https://img.test/${n}.png`, sub: `#${n}`, label: `Set ${n} number ${n}`, checked: false, suggested: false, ...extra });

test('renderTileStrip: a labelled radiogroup of radio buttons with art, set and number; one tab stop', () => {
  const html = renderTileStrip({ kind: 'set', idx: 3, label: 'Choose the printing', tiles: [tile(1), tile(2, { checked: true })] });
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /aria-label="Choose the printing"/);
  assert.equal((html.match(/role="radio"/g) || []).length, 2);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /aria-label="Set 2 number 2"/);
  assert.match(html, /<img src="https:\/\/img\.test\/1\.png"/);
  assert.match(html, /Set 1/);
  assert.match(html, /data-strip-pick="id-1" data-strip-kind="set" data-idx="3"/);
  assert.equal((html.match(/tabindex="0"/g) || []).length, 1);
  assert.match(html, /data-strip-pick="id-2"[^>]*tabindex="0"/);
});

test('renderTileStrip: with nothing checked the first tile is the tab stop', () => {
  const html = renderTileStrip({ kind: 'set', idx: 0, label: 'x', tiles: [tile(1), tile(2)] });
  assert.equal((html.match(/tabindex="0"/g) || []).length, 1);
  assert.match(html, /data-strip-pick="id-1"[^>]*tabindex="0"/);
});

test('renderTileStrip: more than 8 tiles shows 8 and a More tile; expanded shows all with Fewer', () => {
  const tiles = Array.from({ length: 11 }, (_, i) => tile(i + 1));
  const closed = renderTileStrip({ kind: 'set', idx: 0, label: 'x', tiles });
  assert.equal((closed.match(/role="radio"/g) || []).length, 8);
  assert.match(closed, /data-strip-more="set"[^>]*aria-expanded="false"[^>]*>[^<]*More[^<]*3/);
  const open = renderTileStrip({ kind: 'set', idx: 0, label: 'x', tiles, expanded: true });
  assert.equal((open.match(/role="radio"/g) || []).length, 11);
  assert.match(open, /aria-expanded="true"[^>]*>[^<]*Fewer/);
  assert.equal(renderTileStrip({ kind: 'set', idx: 0, label: 'x', tiles: tiles.slice(0, 8) }).includes('data-strip-more'), false);
});

test('renderTileStrip: a tile without art is a text tile (name and set); art tiles carry a hidden text fallback; escaped', () => {
  const html = renderTileStrip({ kind: 'set', idx: 0, label: 'x', tiles: [tile(1, { art: null, name: '<b>X</b>' })] });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /strip-fallback/);
  assert.match(html, /&lt;b&gt;X&lt;\/b&gt;/);
  const withArt = renderTileStrip({ kind: 'set', idx: 0, label: 'x', tiles: [tile(1)] });
  assert.match(withArt, /<img/);
  assert.match(withArt, /class="strip-fallback"/);
});

test('renderTileStrip: a suggested tile says Suggested; a locked strip is aria-disabled', () => {
  const html = renderTileStrip({ kind: 'set', idx: 0, label: 'x', tiles: [tile(1, { suggested: true, checked: true, label: 'Suggested: Set 1 number 1' })], locked: true });
  assert.match(html, /strip-suggested/);
  assert.match(html, />Suggested</);
  assert.match(html, /aria-disabled="true"/);
});

test('renderChipGroup: big radio chips with label and price; label only without a price; suggested ringed with a ? confirm', () => {
  const chips = finishChips({ variants: { normal: { conditions: { NM: 2 } }, holofoil: { conditions: { NM: 10 } }, reverseHolofoil: { conditions: {} } } }, { chosen: 'normal', suggested: '', conditions: ['NM'] });
  const html = renderChipGroup({ idx: 1, label: 'Choose the finish', chips, note: 'Variant seen on the card' });
  assert.match(html, /role="radiogroup"[^>]*aria-label="Choose the finish\. Variant seen on the card"/);
  assert.equal((html.match(/role="radio"/g) || []).length, 3);
  assert.match(html, /data-strip-pick="holofoil" data-strip-kind="finish" data-idx="1"/);
  assert.match(html, /<span class="chip-label">Holofoil<\/span><span class="chip-price">\$10\.00<\/span>/);
  assert.doesNotMatch(html.split('data-strip-pick="reverseHolofoil"')[1].split('</button>')[0], /chip-price/);
  const sug = finishChips({ variants: { normal: { conditions: { NM: 2 } }, holofoil: { conditions: { NM: 10 } } } }, { chosen: '', suggested: 'holofoil', conditions: ['NM'] });
  const withMark = renderChipGroup({ idx: 1, label: 'Choose the finish', chips: sug, confirmMark: '<button data-variant-confirm>?</button>' });
  assert.match(withMark, /chip-suggested/);
  assert.match(withMark, /data-variant-confirm/);
});
