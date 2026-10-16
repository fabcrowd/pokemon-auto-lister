import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  candidatesFor,
  correctionRecord,
  escHtml,
  findCards,
  guessOf,
  isUnsure,
  matchesLabel,
  pageUrlForStorage,
  parseSearch,
  renderPickList,
  thumbUrl,
} from '../tools/extension-wasm/lib/card-picker.js';
import { confTier } from '../tools/extension-wasm/lib/card-display.js';
import { eraById } from '../tools/extension-wasm/lib/era.js';

const row = (id, name, setCode, number, series) => ({
  id,
  name,
  set: `Set ${setCode}`,
  setCode,
  number,
  imageUrl: series ? `https://assets.tcgdex.net/en/${series}/${setCode}/${number}/high.webp` : undefined,
});

const META = [
  row('base1-4', 'Charizard', 'base1', '4', 'base'),
  row('base1-5', 'Clefairy', 'base1', '5', 'base'),
  row('base2-6', 'Charmeleon', 'base2', '6', 'base'),
  row('base1-6', 'Charmander', 'base1', '6', 'base'),
  row('xy12-11', 'Charizard', 'xy12', '11', 'xy'),
  row('sv3-125', 'Charizard ex', 'sv3', '125', 'sv'),
  row('ex6-100', 'Charizard δ', 'ex6', '100', 'ex'),
  row('sv3pt5-4', 'Charmander', 'sv3pt5', '4', 'sv'),
  row('basep-1', "Farfetch'd", 'basep', '1', 'base'),
  row('sv1-004', 'Pidgey', 'sv1', '004', 'sv'),
];

test('confTier keeps the popup thresholds', () => {
  assert.equal(confTier(0.8), 'high');
  assert.equal(confTier(0.79), 'medium');
  assert.equal(confTier(0.5), 'medium');
  assert.equal(confTier(0.49), 'low');
  assert.equal(confTier(undefined), 'low');
});

test('isUnsure: abstain, several set choices, or low confidence', () => {
  assert.equal(isUnsure({ abstain: true, confidence: 0.99 }), true);
  assert.equal(isUnsure({ abstain: false, confidence: 0.99, setChoices: [{ id: 'a' }, { id: 'b' }] }), true);
  assert.equal(isUnsure({ abstain: false, confidence: 0.3, identity: { id: 'a' } }), true);
  assert.equal(isUnsure({ abstain: false, confidence: 0.9, identity: { id: 'a' } }), false);
  assert.equal(isUnsure({ abstain: false, confidence: 0.6, identity: { id: 'a' }, setChoices: [{ id: 'a' }] }), false);
});

test('isUnsure: a set the user confirmed, a card back, or nothing at all is not asked about', () => {
  assert.equal(isUnsure({ abstain: true, confidence: 0.1, setConfirmed: true }), false);
  assert.equal(isUnsure({ abstain: true, cardBack: true, confidence: 0 }), false);
  assert.equal(isUnsure(null), false);
  assert.equal(isUnsure(undefined), false);
});

test('candidatesFor: set choices come first, then the guess, then other printings of the name', () => {
  const card = {
    identity: { name: 'Charizard' },
    setChoices: [{ id: 'xy12-11' }, { id: 'base1-4' }],
  };
  const ids = candidatesFor(card, META).map((c) => c.id);
  assert.deepEqual(ids, ['xy12-11', 'base1-4', 'ex6-100']);
});

test('candidatesFor: rows carry catalog fields, not the trimmed set-choice fields', () => {
  const [first] = candidatesFor({ identity: { name: 'Charizard' }, setChoices: [{ id: 'base1-4', name: 'Charizard' }] }, META);
  assert.deepEqual(first, META[0]);
});

test('candidatesFor: a recognized card is listed before its look-alike printings', () => {
  const card = { identity: META[4], confidence: 0.3, abstain: false };
  const ids = candidatesFor(card, META).map((c) => c.id);
  assert.deepEqual(ids, ['xy12-11', 'base1-4', 'ex6-100']);
});

test('candidatesFor: respects the limit and never repeats a card', () => {
  const card = { identity: { name: 'Charizard' }, setChoices: [{ id: 'base1-4' }, { id: 'base1-4' }, { id: 'xy12-11' }] };
  assert.equal(candidatesFor(card, META, 2).length, 2);
  const all = candidatesFor(card, META, 10).map((c) => c.id);
  assert.equal(new Set(all).size, all.length);
  assert.equal(candidatesFor(card, META).length <= 5, true);
});

test('candidatesFor: a set choice missing from the catalog is kept as given', () => {
  const choice = { id: 'zz-1', name: 'Charizard', set: 'Mystery', setCode: 'zz', number: '1' };
  const ids = candidatesFor({ identity: { name: 'Charizard' }, setChoices: [choice] }, META).map((c) => c.id);
  assert.equal(ids[0], 'zz-1');
});

test('candidatesFor: no name means no candidates', () => {
  assert.deepEqual(candidatesFor({ abstain: true, identity: null }, META), []);
  assert.deepEqual(candidatesFor(null, META), []);
  assert.deepEqual(candidatesFor({ identity: { name: 'Charizard' } }, null), []);
});

test('candidatesFor: a name nobody printed gives nothing', () => {
  assert.deepEqual(candidatesFor({ identity: { name: 'Missingno' } }, META), []);
});

test('parseSearch reads 4/102, #4, 4 and charizard 4', () => {
  assert.deepEqual(parseSearch('4/102'), { words: [], number: '4', total: '102' });
  assert.deepEqual(parseSearch('#4'), { words: [], number: '4', total: null });
  assert.deepEqual(parseSearch('4'), { words: [], number: '4', total: null });
  assert.deepEqual(parseSearch('charizard 4'), { words: ['charizard'], number: '4', total: null });
  assert.deepEqual(parseSearch('Charizard 4/102'), { words: ['charizard'], number: '4', total: '102' });
  assert.deepEqual(parseSearch('  #TG01 pikachu '), { words: ['pikachu'], number: 'tg01', total: null });
});

test('parseSearch: letter-prefixed collector numbers are numbers, not words', () => {
  assert.deepEqual(parseSearch('TG01'), { words: [], number: 'tg01', total: null });
  assert.deepEqual(parseSearch('gg05'), { words: [], number: 'gg05', total: null });
  assert.deepEqual(parseSearch('SWSH001'), { words: [], number: 'swsh001', total: null });
  assert.deepEqual(parseSearch('pikachu SV001'), { words: ['pikachu'], number: 'sv001', total: null });
  assert.deepEqual(parseSearch('porygon2'), { words: ['porygon2'], number: null, total: null });
});

test('findCards: TG01 finds TG01 and a bare number ignores leading zeros', () => {
  const meta = [row('a', 'Pikachu', 'swsh9tg', 'TG01'), row('b', 'Eevee', 'swsh9tg', 'TG11'), row('c', 'Mew', 'swsh1', '001')];
  assert.deepEqual(findCards(meta, 'tg1').map((c) => c.id), ['a']);
  assert.deepEqual(findCards(meta, 'TG01').map((c) => c.id), ['a']);
  assert.deepEqual(findCards(meta, '1').map((c) => c.id), ['c']);
});

test('parseSearch: plain words, accents, punctuation, and empty input', () => {
  assert.deepEqual(parseSearch('Mr. Mime'), { words: ['mr', 'mime'], number: null, total: null });
  assert.deepEqual(parseSearch('Pokémon'), { words: ['pokemon'], number: null, total: null });
  assert.deepEqual(parseSearch(''), { words: [], number: null, total: null });
  assert.deepEqual(parseSearch(null), { words: [], number: null, total: null });
});

test('findCards: every word must be in the name', () => {
  const ids = findCards(META, 'charizard').map((c) => c.id);
  assert.deepEqual(ids, ['base1-4', 'xy12-11', 'sv3-125', 'ex6-100']);
  assert.deepEqual(findCards(META, 'charizard ex').map((c) => c.id), ['sv3-125']);
});

test('findCards: number only, with and without leading zeros', () => {
  const fours = ['base1-4', 'sv1-004', 'sv3pt5-4'];
  assert.deepEqual(findCards(META, '#4').map((c) => c.id).sort(), fours);
  assert.deepEqual(findCards(META, '4').map((c) => c.id).sort(), fours);
  assert.deepEqual(findCards(META, '#004').map((c) => c.id).sort(), fours);
});

test('findCards: name and number together', () => {
  assert.deepEqual(findCards(META, 'charizard 4').map((c) => c.id), ['base1-4']);
  assert.deepEqual(findCards(META, 'charmander 4').map((c) => c.id), ['sv3pt5-4']);
});

test('findCards: a printed total puts sets of that size first', () => {
  const meta = [
    row('later-4', 'Later', 'sv3pt5', '4'),
    row('base-4', 'Base', 'base1', '4'),
    ...Array.from({ length: 101 }, (_, i) => row(`pad-${i}`, `Pad ${i}`, 'base1', String(100 + i))),
  ];
  assert.deepEqual(findCards(meta, '4/102').map((c) => c.id), ['base-4', 'later-4']);
  assert.deepEqual(findCards(meta, '4').map((c) => c.id), ['later-4', 'base-4']);
});

test('findCards: accents and apostrophes do not stop a match', () => {
  assert.deepEqual(findCards(META, 'farfetch').map((c) => c.id), ['basep-1']);
  assert.deepEqual(findCards(META, 'charizard δ').map((c) => c.id), ['ex6-100']);
});

test('findCards: in-era cards rank first when an era is given', () => {
  const era = eraById('sv-me');
  const ids = findCards(META, 'charizard', { era }).map((c) => c.id);
  assert.equal(ids[0], 'sv3-125');
  assert.deepEqual(ids.slice(1), ['base1-4', 'xy12-11', 'ex6-100']);
});

test('findCards: exact names beat longer names', () => {
  const ids = findCards(META, 'charizard').map((c) => c.id);
  assert.ok(ids.indexOf('base1-4') < ids.indexOf('sv3-125'));
});

test('findCards: limit and empty queries', () => {
  assert.equal(findCards(META, 'char', { limit: 2 }).length, 2);
  assert.equal(findCards(META, 'char').length, 7);
  assert.deepEqual(findCards(META, ''), []);
  assert.deepEqual(findCards(META, '   '), []);
  assert.deepEqual(findCards(null, 'charizard'), []);
});

test('findCards returns catalog rows untouched', () => {
  assert.equal(findCards(META, 'clefairy')[0], META[1]);
});

test('thumbUrl: catalog image, then pokemontcg.io, then nothing', () => {
  assert.equal(thumbUrl(META[0]), 'https://assets.tcgdex.net/en/base/base1/4/high.webp');
  assert.equal(thumbUrl({ setCode: 'base1', number: '4' }), 'https://images.pokemontcg.io/base1/4.png');
  assert.equal(thumbUrl({ imageUrl: '', setCode: 'xy12', number: '11' }), 'https://images.pokemontcg.io/xy12/11.png');
  assert.equal(thumbUrl({ setCode: 'base1' }), null);
  assert.equal(thumbUrl({}), null);
  assert.equal(thumbUrl(null), null);
});

test('guessOf keeps what the scanner said, not what the user later chose', () => {
  const card = {
    identity: { id: 'base1-4', name: 'Charizard' },
    confidence: 0.42,
    abstain: false,
    setChoices: [{ id: 'base1-4' }, { id: 'xy12-11' }],
  };
  assert.deepEqual(guessOf(card), { id: 'base1-4', confidence: 0.42, abstain: false, choiceIds: ['base1-4', 'xy12-11'], catalogTop: null });
  assert.deepEqual(guessOf({ abstain: true }), { id: null, confidence: null, abstain: true, choiceIds: [], catalogTop: null });
  assert.equal(guessOf({ ...card, catalogTop: 0.81 }).catalogTop, 0.81);
});

test('correctionRecord builds the stored shape', () => {
  const guess = { id: 'a', confidence: 0.4, abstain: false, choiceIds: ['a', 'b'], catalogTop: 0.8 };
  assert.deepEqual(
    correctionRecord({
      ts: 123, pageUrl: 'https://example.com/lot', guess, pickedId: 'b', via: 'candidates',
      crop: 'data:image/jpeg;base64,AAAA', extVersion: '2.0.1',
    }),
    {
      ts: 123, scanId: null, index: null, pageUrl: 'https://example.com/lot', guess, pickedId: 'b', via: 'candidates',
      crop: 'data:image/jpeg;base64,AAAA', extVersion: '2.0.1',
    },
  );
});

test('correctionRecord links a record to the scan crop it answers, so the latest pick replaces the earlier one', () => {
  const first = correctionRecord({ ts: 1, pickedId: 'a', via: 'candidates', scanId: 's1', index: 2 });
  const second = correctionRecord({ ts: 2, pickedId: 'b', via: 'wrong-card', scanId: 's1', index: 2 });
  assert.equal(first.id, 's1:2');
  assert.equal(second.id, 's1:2');
  assert.equal(first.scanId, 's1');
  assert.equal(first.index, 2);
  const loose = correctionRecord({ ts: 1, pickedId: 'a', via: 'search' });
  assert.equal('id' in loose, false);
  assert.equal(loose.scanId, null);
  assert.equal(loose.index, null);
});

test('pageUrlForStorage drops the query string, hash and credentials', () => {
  assert.equal(pageUrlForStorage('https://www.ebay.com/itm/123?hash=abc&token=secret#frag'), 'https://www.ebay.com/itm/123');
  assert.equal(pageUrlForStorage('https://user:pw@example.com/a?b=1'), 'https://example.com/a');
  assert.equal(pageUrlForStorage('not a url'), null);
  assert.equal(pageUrlForStorage(''), null);
  assert.equal(pageUrlForStorage(null), null);
  assert.equal(correctionRecord({ ts: 1, pickedId: 'a', via: 'search', pageUrl: 'https://x.test/p?q=1#h' }).pageUrl, 'https://x.test/p');
});

test('matchesLabel says how many results a screen reader should hear', () => {
  assert.equal(matchesLabel(0), 'No matches');
  assert.equal(matchesLabel(1), '1 match');
  assert.equal(matchesLabel(20), '20 matches');
  assert.equal(matchesLabel(null), '');
});

test('correctionRecord fills gaps and rejects unknown paths', () => {
  const record = correctionRecord({ ts: 1, pickedId: 'b', via: 'search' });
  assert.equal(record.pageUrl, null);
  assert.equal(record.crop, null);
  assert.equal(record.extVersion, null);
  assert.deepEqual(record.guess, { id: null, confidence: null, abstain: false, choiceIds: [], catalogTop: null });
  assert.equal(correctionRecord({ ts: 1, pickedId: 'b', via: 'search', guess: { catalogTop: 'x' } }).guess.catalogTop, null);
  assert.throws(() => correctionRecord({ ts: 1, pickedId: 'b', via: 'magic' }), /via/);
  assert.throws(() => correctionRecord({ ts: 1, pickedId: '', via: 'search' }), /pickedId/);
  for (const via of ['candidates', 'search', 'wrong-card']) {
    assert.equal(correctionRecord({ ts: 1, pickedId: 'b', via }).via, via);
  }
});

test('correctionRecord only keeps JPEG data URLs as the crop', () => {
  assert.equal(correctionRecord({ ts: 1, pickedId: 'b', via: 'search', crop: 'https://evil.example/x.png' }).crop, null);
});

const HOSTILE = { id: 'x"><script>1</script>', name: `<img src=x onerror=alert(1)> & "Q" 'S'`, set: '<b>set</b>', setCode: 'a&b', number: '<1>' };

test('escHtml escapes markup characters and survives non-strings', () => {
  assert.equal(escHtml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(escHtml(4), '4');
  assert.equal(escHtml(null), '');
  assert.equal(escHtml(undefined), '');
});

test('renderPickList escapes every interpolated value', () => {
  const html = renderPickList([HOSTILE], 3);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<b>set/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;Q&quot; &#39;S&#39;/);
  assert.match(html, /data-pick="x&quot;&gt;&lt;script&gt;1&lt;\/script&gt;"/);
});

test('renderPickList makes labelled buttons with lazy, described thumbnails', () => {
  const html = renderPickList([META[0]], 2);
  assert.match(html, /<button type="button" class="pick-card"/);
  assert.match(html, /data-idx="2"/);
  assert.match(html, /aria-label="Charizard, Set base1, number 4"/);
  assert.match(html, /<img [^>]*loading="lazy"/);
  assert.match(html, /alt="Charizard, Set base1, number 4"/);
  assert.match(html, /src="https:\/\/assets\.tcgdex\.net\/en\/base\/base1\/4\/high\.webp"/);
});

test('renderPickList without an image still renders a button, and nothing renders for no cards', () => {
  const html = renderPickList([{ id: 'q-1', name: 'Mew' }], 0);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<button type="button" class="pick-card"/);
  assert.equal(renderPickList([], 0), '');
});

test('candidatesFor puts the card the user corrected before first', () => {
  const card = { identity: { id: 'base1-4', name: 'Charizard' }, referencedId: 'xy12-11', setChoices: [{ id: 'base1-4', name: 'Charizard' }] };
  const ids = candidatesFor(card, META).map((c) => c.id);
  assert.equal(ids[0], 'xy12-11');
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('base1-4'));
});

test('candidatesFor ignores a referenced card the catalog does not have', () => {
  const ids = candidatesFor({ identity: { id: 'base1-4', name: 'Charizard' }, referencedId: 'nope' }, META).map((c) => c.id);
  assert.equal(ids[0], 'base1-4');
});
