import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTemplate,
  buildListingCopy,
  buildListingDescription,
  buildListingTitle,
} from '../src/listing/listingCopy.js';

const CARD = {
  pricedCache: {
    identity: {
      name: 'Charizard',
      number: '4/102',
      set: 'Base Set',
      rarity: 'Holo Rare',
    },
  },
};

test('buildListingTitle uses identity parts and caps at 80 chars', () => {
  const title = buildListingTitle(CARD);
  assert.equal(title, 'Charizard 4/102 Base Set Holo Rare');
  assert.ok(title.length <= 80);
});

test('buildListingTitle prefers explicit card.title', () => {
  assert.equal(buildListingTitle({ ...CARD, title: 'Custom Title' }), 'Custom Title');
});

test('buildListingDescription fills template placeholders', () => {
  const description = buildListingDescription(CARD, {
    descriptionTemplate: '{{name}} {{number}} — {{set}}\nShips next day.',
  });
  assert.match(description, /Charizard 4\/102 — Base Set/);
  assert.match(description, /Ships next day/);
});

test('applyTemplate drops missing placeholders cleanly', () => {
  assert.equal(applyTemplate('Hello {{name}}', {}), 'Hello');
});

test('buildListingCopy returns title and description together', () => {
  const copy = buildListingCopy(CARD, {
    descriptionTemplate: '{{name}} ready to ship.',
  });
  assert.equal(copy.title, 'Charizard 4/102 Base Set Holo Rare');
  assert.equal(copy.description, 'Charizard ready to ship.');
});
