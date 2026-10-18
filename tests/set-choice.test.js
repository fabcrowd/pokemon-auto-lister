import { test } from 'node:test';
import assert from 'node:assert/strict';

import { choiceName, cardDescribedInText, cardNamedByAttacks, cardNamedInText, nameAlmostAgrees, nameAgrees, baseName, onlyPromoChoice, setChoices, versionChoices } from '../tools/extension-wasm/lib/set-choice.js';

const meta = [
  { id: 'ex8-93', name: 'Boost Energy', set: 'Deoxys', setCode: 'ex8', number: '93' },
  { id: 'ex10-98', name: 'Boost Energy', set: 'Unseen Forces', setCode: 'ex10', number: '98' },
  { id: 'pop5-8', name: 'Cyclone Energy', set: 'POP Series 5', setCode: 'pop5', number: '8' },
  { id: 'ex15-87', name: 'Boost Energy', set: 'Dragon Frontiers', setCode: 'ex15', number: '87' },
  { id: 'dp7-95', name: 'Boost Energy', set: 'Stormfront', setCode: 'dp7', number: '95' },
  { id: 'ex13-54', name: 'Vibrava δ', set: 'Holon Phantoms', setCode: 'ex13', number: '54' },
  { id: 'xy5-109', name: 'Vibrava', set: 'Primal Clash', setCode: 'xy5', number: '109' },
  { id: 'ex12-88', name: 'Mew ex', set: 'Legend Maker', setCode: 'ex12', number: '88' },
  { id: 'pop4-4', name: 'Mew', set: 'POP Series 4', setCode: 'pop4', number: '4' },
];

const hit = (index, score) => ({ index, score });

test('close same-name matches from different sets are offered as choices', () => {
  const hits = [hit(0, 0.908), hit(1, 0.903), hit(2, 0.898), hit(3, 0.897), hit(4, 0.84)];
  const choices = setChoices(meta[0], hits, meta);
  assert.deepEqual(choices.map((c) => c.id), ['ex8-93', 'ex10-98', 'ex15-87']);
});

const reprints = [
  { id: 'base1-2', name: 'Blastoise', set: 'Base Set', setCode: 'base1', number: '2' },
  { id: 'base4-2', name: 'Blastoise', set: 'Base Set 2', setCode: 'base4', number: '2' },
  { id: 'lc-2', name: 'Blastoise', set: 'Legendary Collection', setCode: 'lc', number: '2' },
  { id: 'base1-15', name: 'Venusaur', set: 'Base Set', setCode: 'base1', number: '15' },
  { id: 'xy1-30', name: 'Blastoise', set: 'XY', setCode: 'xy1', number: '30' },
];

test('Base Set and Base Set 2 within 0.05 of each other are both offered, the name kept', () => {
  // Measured on labelled HiBid crops: the right printing was within 0.05 of the best same-name hit 96% of the time (0.03: 88%).
  const hits = [hit(0, 0.86), hit(1, 0.82), hit(2, 0.812)];
  const choices = setChoices(reprints[0], hits, reprints);
  assert.deepEqual(choices.map((c) => c.id), ['base1-2', 'base4-2', 'lc-2']);
  assert.ok(choices.every((c) => c.name === 'Blastoise'));
});

test('a printing more than 0.05 behind is not offered', () => {
  const hits = [hit(0, 0.86), hit(4, 0.80)];
  assert.deepEqual(setChoices(reprints[0], hits, reprints).map((c) => c.id), ['base1-2']);
});

test('a near-tied card with a different name does not make the set unsure', () => {
  const hits = [hit(0, 0.86), hit(3, 0.859), hit(1, 0.7)];
  assert.deepEqual(setChoices(reprints[0], hits, reprints).map((c) => c.id), ['base1-2']);
});

test('a match far below the best is not offered', () => {
  const hits = [hit(0, 0.908), hit(4, 0.84)];
  assert.deepEqual(setChoices(meta[0], hits, meta).map((c) => c.id), ['ex8-93']);
});

test('a delta card and the plain card share a name for choosing', () => {
  const hits = [hit(5, 0.797), hit(6, 0.790)];
  assert.deepEqual(setChoices(meta[5], hits, meta).map((c) => c.id), ['ex13-54', 'xy5-109']);
});

test('an ex card is a different card from the plain one', () => {
  const hits = [hit(8, 0.847), hit(7, 0.838)];
  assert.deepEqual(setChoices(meta[8], hits, meta).map((c) => c.id), ['pop4-4']);
});

test('the accepted card is offered even when its hit is not in the list', () => {
  assert.deepEqual(setChoices(meta[3], [hit(0, 0.9)], meta).map((c) => c.id), ['ex15-87', 'ex8-93']);
});

test('a tied number uses the one catalog name the photo actually shows', () => {
  const gengar = [
    { id: 'gym1-14', name: "Sabrina's Gengar" },
    { id: 'gym2-14', name: "Rocket's Mewtwo" },
  ];
  const shown = "Evolves from Sabrina's Hounter | STAGE2 | Sabrina's Gengar | 80H";
  assert.equal(cardNamedInText(gengar, shown)?.id, 'gym1-14');
  const slowpoke = [
    { id: 'gym1-95', name: "Sabrina's Slowpoke" },
    { id: 'gym2-95', name: "Sabrina's Drowzee" },
  ];
  assert.equal(cardNamedInText(slowpoke, "Basic Pokemon | Sabrina's Slowpoke | 50H")?.id, 'gym1-95');
  const split = [
    { id: 'gym1-20', name: "Brock's Golem" },
    { id: 'gym2-20', name: 'Sabrina' },
  ];
  assert.equal(cardNamedInText(split, "Sabrina's Gengar")?.id, undefined);
  assert.equal(cardNamedInText(split, 'Sabrina  HP')?.id, 'gym2-20');
  const surge = [
    { id: 'gym1-17', name: 'Lt. Surge' },
    { id: 'gym2-17', name: 'Blaine' },
  ];
  assert.equal(cardNamedInText(surge, 'TRAINER | Lt.Surge')?.id, 'gym1-17');
  assert.equal(cardNamedInText(surge, 'Blaine')?.id, 'gym2-17');
  const energy = [
    { id: 'gym1-127', name: 'Fighting Energy' },
    { id: 'gym2-127', name: 'Fighting Energy' },
  ];
  assert.equal(cardNamedInText(energy, 'Fighting Energy'), null);
  const nested = [
    { id: 'short', name: 'Slowpoke' },
    { id: 'gym1-95', name: "Sabrina's Slowpoke" },
  ];
  assert.equal(cardNamedInText(nested, "Sabrina's Slowpoke")?.id, 'gym1-95');
  assert.equal(cardNamedInText(gengar.slice(0, 1), shown), null);
  assert.equal(cardNamedInText(gengar, ''), null);
});

test('a tied number uses the rules text when the name is missing', () => {
  const tied = [
    {
      id: 'gym1-17',
      name: 'Lt. Surge',
      description: 'You can play this card only if you have at least 1 Basic Pokémon card in your hand. Put a Basic Pokémon card from your hand into play as your Active Pokémon.',
    },
    {
      id: 'gym2-17',
      name: 'Blaine',
      description: 'During this turn, instead of attaching your free Energy card, you may instead attach 2 Fire Energy cards to 1 of your Pokémon with Blaine in its name.',
    },
  ];
  const surge = 'You can play this card only if you have at least i Basic Pokemon card in your hand. Put a Basic Pokemon card from your hand into play as your Active Pokemon.';
  const blaine = 'During this turn, instead of attaching your free Energy card, you may instead attach 2 Fire Energy cards.';
  assert.equal(cardDescribedInText(tied, surge)?.id, 'gym1-17');
  assert.equal(cardDescribedInText(tied, blaine)?.id, 'gym2-17');
  assert.equal(cardDescribedInText(tied, 'Flip a coin. If heads, the Defending Pokemon is now Paralyzed.'), null);
  assert.equal(cardDescribedInText(tied.slice(0, 1), surge), null);
  assert.equal(cardDescribedInText(tied, ''), null);
  const stock = [
    { id: 'poison', description: 'The Defending Pokemon is now poisoned and confused badly.' },
    { id: 'draw', description: 'Draw cards until you have six in your hand please.' },
  ];
  assert.equal(cardDescribedInText(stock, 'The Defending Pokemon is now asleep'), null);
  assert.equal(cardDescribedInText(stock, 'The Defending Pokemon is now poisoned and confused badly.')?.id, 'poison');
  const misty = 'Discard 2 of the other cards in your hand in order to play this card. If this turn\'s attack does damage to the Defending Pokemon, and if the attacking Pokemon has Misty in its name, the attack does 20 more damage.';
  const truncated = [
    { id: 'gym1-18', description: misty },
    { id: 'gym2-18', description: 'Choose 1 of your Pokemon in play with Giovanni in its name. For the rest of your turn, you may evolve that Pokemon.' },
    { id: 'base4-18', description: 'Solarbeam' },
  ];
  assert.equal(cardDescribedInText(truncated, misty)?.id, 'gym1-18');
});

test('a promo star leaves the one Black Star choice', () => {
  const choices = [
    { id: 'basep-29', setCode: 'basep', number: '29' },
    { id: 'ecard2-53', setCode: 'ecard2', number: '53' },
    { id: 'neo1-66', setCode: 'neo1', number: '66' },
  ];
  assert.equal(onlyPromoChoice(choices)?.id, 'basep-29');
  assert.equal(onlyPromoChoice(choices.slice(1)), null);
  assert.equal(onlyPromoChoice([choices[0], { id: 'basep-8', setCode: 'basep', number: '8' }]), null);
});

test('a promo name agrees with the title line, including a bracket form', () => {
  assert.equal(nameAgrees('Marill', 'Marill | 50HP | Basic Pokemon'), true);
  assert.equal(nameAgrees('Mew', 'Basic Pokemon | 50HP | Mew'), true);
  assert.equal(nameAgrees('Mew', 'Basic Pokemon | Mewtwo | 70H'), false);
  assert.equal(nameAgrees('Mewtwo', 'Basic Pokemon | Mewtwo | 70H'), true);
  assert.equal(nameAgrees('Unown [J]', '40HP | Unown | [? | BasicPokemon'), true);
  assert.equal(nameAgrees('Machamp', 'Dragonite | 90HP'), false);
  assert.equal(nameAgrees('Marill', ''), false);
  assert.equal(nameAgrees('Doduo', 'Doduo | 40HP'), true);
  assert.equal(nameAgrees('Dodrio', 'Doduo | 40HP'), false);
});

test('one junk letter on the title still names the card', () => {
  assert.equal(nameAlmostAgrees('Chimchar', 'Chimcharw.s | 40A | BASIC'), true);
  assert.equal(nameAgrees('Chimchar', 'Chimcharw.s | 40A | BASIC'), false);
  assert.equal(nameAlmostAgrees('Mew', 'Mewtwo'), false);
  assert.equal(nameAlmostAgrees('Pikachu', 'Pikachu.1a | 60'), true);
});

test('glued attack text still matches two attack names', () => {
  const text = 'Flare 40 Lunge * Flipa coin.lf tails,thisattackdoesoting';
  const cards = [
    { id: 'dp1-76', attacks: ['Scratch', 'Ember'] },
    { id: 'dp5-56', attacks: ['Flare', 'Lunge'] },
    { id: 'dp5-57', attacks: ['Fury Swipes'] },
  ];
  assert.equal(cardNamedByAttacks(cards, text)?.id, 'dp5-56');
  assert.equal(cardNamedByAttacks(cards, 'Flare 40'), null);
  assert.equal(cardNamedByAttacks([
    { id: 'a', attacks: ['Flare', 'Lunge'] },
    { id: 'b', attacks: ['Flare', 'Ember'] },
  ], text)?.id, 'a');
  assert.equal(cardNamedByAttacks([
    { id: 'a', attacks: ['Flare', 'Lunge'] },
    { id: 'b', attacks: ['Flare', 'Lunge'] },
  ], text), null);
});

test('a misread Volt Tackle still singles out that Pikachu', () => {
  const text = 'Quick Attack | Yolt Tackle';
  const cards = [
    { id: 'dp5-70', attacks: ['Quick Attack', 'Volt Tackle'] },
    { id: 'ex13-78', attacks: ['Thunder Wave', 'Quick Attack'] },
    { id: 'dp7-70', attacks: ['Pika Punch', 'Speed Bolt'] },
  ];
  assert.equal(cardNamedByAttacks(cards, text)?.id, 'dp5-70');
});

test('a Burger King Chimchar is the Majestic Dawn printing', () => {
  const text = 'Flare | Lunge | Flip a coin.lf tails,this attack doesnothing';
  const cards = [
    { id: 'dp1-76', description: 'Flip a coin. If tails, discard a Fire Energy attached to Chimchar.' },
    { id: 'dp5-56', description: 'Flare Lunge Flip a coin. If tails, this attack does nothing.' },
    { id: 'dp5-57', description: 'Flip 3 coins. This attack does 10 damage times the number of heads.' },
  ];
  assert.equal(cardDescribedInText(cards, text)?.id, 'dp5-56');
});

test('no more than four choices', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}-1`, name: 'Pikachu', set: `Set ${i}`, setCode: `s${i}`, number: '1',
  }));
  const hits = many.map((_, i) => hit(i, 0.9 - i * 0.001));
  assert.equal(setChoices(many[0], hits, many).length, 4);
});

test('baseName strips mechanic suffixes and prefixes that share art', () => {
  const cases = {
    'Pikachu ex': 'Pikachu', 'Mew EX': 'Mew', 'Charizard-GX': 'Charizard', 'Pikachu V': 'Pikachu', 'Pikachu VMAX': 'Pikachu',
    'Drapion VSTAR': 'Drapion', 'Pikachu V-UNION': 'Pikachu', 'Rayquaza BREAK': 'Rayquaza', 'Garchomp LV.X': 'Garchomp',
    'Mewtwo Prime': 'Mewtwo', 'Entei LEGEND': 'Entei', 'Vibrava δ': 'Vibrava', 'Raichu δ Delta Species': 'Raichu',
    'Dark Jolteon': 'Jolteon', 'Light Dragonite': 'Dragonite', 'Shining Gyarados': 'Gyarados', 'Radiant Greninja': 'Greninja',
    'Jolteon': 'Jolteon', 'Charizard ★': 'Charizard', 'Pikachu & Zekrom GX': 'Pikachu & Zekrom',
  };
  for (const [name, base] of Object.entries(cases)) assert.equal(baseName(name), base, name);
});

test('baseName keeps different-art forms and names that only contain a suffix as letters', () => {
  // Regional forms and owner cards are new artwork, so they are not look-alikes of the plain card.
  for (const name of ['Alolan Raichu', 'Galarian Zigzagoon', 'Hisuian Zorua', 'Paldean Wooper', "Team Rocket's Zapdos", "Lt. Surge's Raichu",
    'Vaporeon', 'Venusaur', 'Darkrai', 'Lightning Energy', 'Exeggutor', 'Primeape', 'V', 'Dark', 'Shining']) {
    assert.equal(baseName(name), name, name);
  }
  assert.equal(baseName(''), '');
  assert.equal(baseName(null), '');
});

const lookalikes = [
  { id: 'a-1', name: 'Pikachu V', set: 'Vivid Voltage', setCode: 'swsh4', number: '43' },
  { id: 'a-2', name: 'Pikachu ex', set: 'Surging Sparks', setCode: 'sv8', number: '57' },
  { id: 'a-3', name: 'Pikachu', set: 'Base Set', setCode: 'base1', number: '58' },
  { id: 'a-4', name: 'Raichu', set: 'Base Set', setCode: 'base1', number: '14' },
  { id: 'a-5', name: 'Pikachu V', set: 'Celebrations', setCode: 'cel25', number: '5' },
  { id: 'a-6', name: 'Alolan Raichu', set: 'Sun & Moon', setCode: 'sm1', number: '1' },
  { id: 'a-7', name: 'Raichu', set: 'Jungle', setCode: 'base2', number: '14' },
  { id: 'a-8', name: 'Pikachu VMAX', set: 'Vivid Voltage', setCode: 'swsh4', number: '44' },
  { id: 'a-9', name: 'Pikachu VSTAR', set: 'Crown Zenith', setCode: 'swsh12pt5', number: '1' },
];

test('set choices stay within one card name: a same-art ex or V is not folded into them', () => {
  const hits = [hit(0, 0.86), hit(1, 0.85), hit(4, 0.84)];
  assert.deepEqual(setChoices(lookalikes[0], hits, lookalikes).map((c) => c.id), ['a-1', 'a-5']);
});

test('a same-base card with another name within 0.03 of the best is offered as another version', () => {
  const hits = [hit(0, 0.86), hit(3, 0.855), hit(1, 0.84), hit(2, 0.831)];
  assert.deepEqual(versionChoices(lookalikes[0], hits, lookalikes).map((c) => c.id), ['a-2', 'a-3']);
});

test('a version 0.04 behind is not offered', () => {
  assert.deepEqual(versionChoices(lookalikes[0], [hit(0, 0.86), hit(1, 0.82)], lookalikes), []);
});

test('versions leave out the card itself, other printings of its name, regional forms and other Pokémon', () => {
  const hits = [hit(3, 0.86), hit(6, 0.859), hit(5, 0.858), hit(0, 0.857)];
  assert.deepEqual(versionChoices(lookalikes[3], hits, lookalikes), []);
});

test('each version name is offered once and at most three versions', () => {
  const hits = [hit(0, 0.86), hit(1, 0.859), hit(4, 0.858), hit(7, 0.857), hit(8, 0.856), hit(2, 0.855)];
  const ids = versionChoices(lookalikes[0], hits, lookalikes).map((c) => c.id);
  assert.deepEqual(ids, ['a-2', 'a-8', 'a-9']);
});

test('a star card is not the plain card of the same name', () => {
  const stars = [
    { id: 'ex14-99', name: 'Alakazam ☆', set: 'Crystal Guardians', setCode: 'ex14', number: '99' },
    { id: 'base1-1', name: 'Alakazam', set: 'Base Set', setCode: 'base1', number: '1' },
    { id: 'pop5-17', name: 'Espeon ★', set: 'POP Series 5', setCode: 'pop5', number: '17' },
    { id: 'ex1-1', name: 'Espeon', set: 'Hidden', setCode: 'ex1', number: '1' },
  ];
  assert.notEqual(choiceName(stars[0].name), choiceName(stars[1].name));
  assert.notEqual(choiceName(stars[2].name), choiceName(stars[3].name));
  assert.deepEqual(setChoices(stars[1], [hit(0, 0.9), hit(1, 0.89)], stars).map((c) => c.id), ['base1-1']);
  assert.equal(choiceName('Vibrava δ'), 'vibrava');
  assert.deepEqual(versionChoices(stars[1], [hit(1, 0.9), hit(0, 0.89)], stars).map((c) => c.id), ['ex14-99']);
});
