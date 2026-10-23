import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIRM_ROWS, UNKNOWN_HEIGHT_ROW, confirmDecision, fuseResults, markChoose } from '../tools/extension-wasm/lib/fusion.js';

// Per-height confirm rule for model E (data/reports/fusion-study-E/README.md): the numbers are pinned here so a change is deliberate.
const META = [{ name: 'Pikachu', id: 'a' }, { name: 'Raichu', id: 'b' }, { name: 'Pikachu', id: 'c' }];
const hits = (top, rival, rivalIndex = 1) => [{ index: 0, score: top }, { index: rivalIndex, score: rival }];
const confirms = (h, top, rival, opts = {}) => confirmDecision(hits(top, rival), META, { height: h, ...opts }).confirm;

test('the table is the study table', () => {
  assert.deepEqual(CONFIRM_ROWS.map((r) => [r.minHeight, r.minSim, r.minGap]), [[350, 0.72, 0], [300, 0.69, 0], [250, 0.6, 0.01], [200, 0.62, 0.03]]);
});

test('nothing under 200 px confirms, however strong the match', () => {
  for (const h of [1, 150, 199, 199.9]) assert.equal(confirms(h, 0.99, 0.1), false, String(h));
  assert.equal(confirms(200, 0.99, 0.1), true);
});

test('height boundaries pick the next lower fitted row', () => {
  // 249 uses (0.62, 0.03); 250 uses (0.60, 0.01)
  assert.equal(confirms(249, 0.61, 0.5), false);
  assert.equal(confirms(250, 0.61, 0.5), true);
  // 299 uses (0.60, 0.01); 300 uses (0.69, 0)
  assert.equal(confirms(299, 0.65, 0.5), true);
  assert.equal(confirms(300, 0.65, 0.5), false);
  // 349 uses (0.69, 0); 350 uses (0.72, 0)
  assert.equal(confirms(349, 0.70, 0.5), true);
  assert.equal(confirms(350, 0.70, 0.5), false);
  assert.equal(confirms(1200, 0.72, 0.5), true);
});

test('exactly at T confirms, just under does not', () => {
  assert.equal(confirms(200, 0.62, 0.1), true);
  assert.equal(confirms(200, 0.6199, 0.1), false);
  assert.equal(confirms(250, 0.60, 0.1), true);
  assert.equal(confirms(300, 0.69, 0.1), true);
  assert.equal(confirms(350, 0.72, 0.1), true);
  assert.equal(confirms(350, 0.7199, 0.1), false);
});

test('exactly at G confirms, just under does not', () => {
  assert.equal(confirms(200, 0.70, 0.67), true);
  assert.equal(confirms(200, 0.70, 0.6701), false);
  assert.equal(confirms(250, 0.70, 0.69), true);
  assert.equal(confirms(250, 0.70, 0.6901), false);
  assert.equal(confirms(300, 0.75, 0.75), true);
  assert.equal(confirms(300, 0.75, 0.7501), false);
});

test('a rival with the same card name is ignored', () => {
  const same = hits(0.70, 0.70, 2); // another printing of Pikachu
  assert.equal(confirmDecision(same, META, { height: 200 }).confirm, true);
  assert.equal(confirmDecision(hits(0.70, 0.70, 1), META, { height: 200 }).confirm, false);
});

test('a title spelling another name demotes that candidate by 0.05 and can flip the decision', () => {
  const spellsRaichu = (name) => name !== 'Raichu';
  // top contradicted: 0.66 -> 0.61 < T(200)
  assert.equal(confirms(200, 0.66, 0.5), true);
  assert.equal(confirms(200, 0.66, 0.5, { contradicts: (n) => n === 'Pikachu' }), false);
  // rival contradicted: gap 0.01 -> 0.06 clears G(200)
  assert.equal(confirms(200, 0.64, 0.63), false);
  assert.equal(confirms(200, 0.64, 0.63, { contradicts: (n) => n === 'Raichu' }), true);
  assert.equal(spellsRaichu('Pikachu'), true);
  const decision = confirmDecision(hits(0.64, 0.63), META, { height: 200, contradicts: (n) => n === 'Raichu' });
  assert.ok(Math.abs(decision.aTop - 0.64) < 1e-12);
  assert.ok(Math.abs(decision.margin - 0.06) < 1e-12);
});

test('no title evidence is neutral', () => {
  const none = confirmDecision(hits(0.66, 0.62), META, { height: 200 });
  const silent = confirmDecision(hits(0.66, 0.62), META, { height: 200, contradicts: () => false });
  assert.deepEqual(none, silent);
});

test('an unknown height uses the 200-249 px row (thumbnails are about 200 px)', () => {
  assert.equal(UNKNOWN_HEIGHT_ROW, CONFIRM_ROWS.find((r) => r.minHeight === 200));
  for (const opts of [{ height: 0 }, {}, { height: undefined }, { height: NaN }, { height: -5 }]) {
    const at = (top, rival) => confirmDecision(hits(top, rival), META, opts).confirm;
    assert.equal(at(0.65, 0.64), false, 'cos 0.65 vs rival 0.64: lead 0.01 < G 0.03');
    assert.equal(at(0.65, 0.60), true, 'cos 0.65 vs rival 0.60: lead 0.05 clears G');
    assert.equal(at(0.62, 0.50), true, 'exactly at T');
    assert.equal(at(0.61, 0.10), false, 'under T never confirms');
    assert.equal(at(0.71, 0.70), false, 'the native row would have confirmed this');
  }
});

test('two different-name candidates within 0.03 at an unknown height are a CHOOSE (grid tile regression)', () => {
  const tile = fuseResults(hits(0.80, 0.78), null, META, [], {});
  assert.equal(tile.choose, true);
  assert.equal(tile.reason, 'choose');
  assert.equal(tile.abstain, false);
  const clear = fuseResults(hits(0.80, 0.70), null, META, [], {});
  assert.equal(clear.reason, 'confirmed');
});

test('no rival of another name means the gap condition holds', () => {
  assert.equal(confirmDecision([{ index: 0, score: 0.63 }], META, { height: 200 }).confirm, true);
});

test('fuseResults: a confirmed read keeps the tier rule, an unconfirmed one is a CHOOSE', () => {
  const sure = fuseResults(hits(0.9, 0.7), null, META, [], { height: 400 });
  assert.equal(sure.reason, 'confirmed');
  assert.equal(sure.confidence, 0.9);
  assert.equal(sure.abstain, false);
  const noLead = fuseResults(hits(0.9, 0.89), null, META, [], { height: 400 });
  assert.equal(noLead.confidence, 0.79);
  const mid = fuseResults(hits(0.65, 0.5), null, META, [], { height: 250 });
  assert.equal(mid.reason, 'confirmed');
  assert.equal(mid.confidence, 0.65);
  const small = fuseResults(hits(0.9, 0.5), null, META, [], { height: 199 });
  assert.equal(small.choose, true);
  assert.equal(small.reason, 'choose');
  assert.equal(small.abstain, false);
  assert.equal(small.identity.name, 'Pikachu');
  assert.equal(small.confidence, 0.49);
  const hopeless = fuseResults(hits(0.5, 0.4), null, META, [], { height: 400 });
  assert.equal(hopeless.abstain, true);
});

test('markChoose makes the guess unsure and flags small sources only for a known height under 200', () => {
  const choose = { identity: { name: 'Pikachu' }, confidence: 0.49, abstain: false, choose: true };
  const small = markChoose(choose, 150);
  assert.equal(small.unsure, true);
  assert.equal(small.smallSource, true);
  assert.equal('choose' in small, false);
  const big = markChoose(choose, 320);
  assert.equal(big.unsure, true);
  assert.equal(big.smallSource, undefined);
  assert.equal(markChoose(choose, 0).smallSource, undefined);
  const confirmed = { identity: { name: 'Pikachu' }, confidence: 0.7, abstain: false };
  assert.equal(markChoose(confirmed, 100), confirmed);
  assert.equal(markChoose(null, 100), null);
});
