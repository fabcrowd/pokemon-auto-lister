import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTileSource, upgradeRenditionUrl } from '../tools/extension-wasm/lib/rendition.js';
import { fullSizeCandidates, largerRendition, loadFullSize } from '../tools/extension-wasm/lib/full-size.js';

const HIBID = 'https://cdn.hibid.com/img.axd?id=8449604074&wid=&rwl=false&p=&ext=&w=0&h=0&t=&lp=&c=true&wt=false&sz=MAX&checksum=o4amrkeBqlxLRG7%2febTvWjcI649hOujC';
const HIBID_GALLERY = 'https://cdn.hibid.com/img.axd?id=8449604074&wid=&rwl=false&p=&ext=&w=720&h=720&t=&lp=&c=true&wt=false&checksum=o4amrkeBqlxLRG7%2febTvWjcI649hOujC';
const HIBID_THUMB = HIBID + '&h=200&w=200';
const SGW_FULL = 'https://shopgoodwillimages.azureedge.net/production/177/Items/2026-10-20/38829ff7-2875-463a-9ac9-f32d4811ea7foyle_10201.jpg';
const SGW_THUMB = 'https://shopgoodwillimages.azureedge.net/production/177/Items/2026-10-20/38829ff7-2875-463a-9ac9-f32d4811ea7foyle_1020t1.jpeg';
const POSH = 'https://di2ponv0v5otw.cloudfront.net/posts/2026/09/15/6aa9dcc67049a1813645b296/';
const CL = 'https://images.craigslist.org/00q0q_bXdxJgU0nqr_0s00CI_';

const RULES = [
  ['mercari thumb with width, quality and cache key', 'https://u-mercari-images.mercdn.net/thumb/photos/m21459589236_1.jpg?width=256&quality=75&_=1778459320', 'https://u-mercari-images.mercdn.net/photos/m21459589236_1.jpg'],
  ['mercari photo with width only', 'https://u-mercari-images.mercdn.net/photos/m10306270078_2.jpg?width=768&quality=75', 'https://u-mercari-images.mercdn.net/photos/m10306270078_2.jpg'],
  ['hibid list thumb', HIBID_THUMB, HIBID],
  ['hibid gallery 720', HIBID_GALLERY, HIBID],
  ['shopgoodwill thumb', SGW_THUMB, SGW_FULL],
  ['craigslist 50x50c', CL + '50x50c.jpg', CL + '1200x900.jpg'],
  ['craigslist 300x300', CL + '300x300.jpg', CL + '1200x900.jpg'],
  ['craigslist 600x450', CL + '600x450.jpg', CL + '1200x900.jpg'],
  ['poshmark s jpg', POSH + 's_6aa9dcd3ebb1a56446efa83e.jpg', POSH + 'l_6aa9dcd3ebb1a56446efa83e.jpg'],
  ['poshmark m jpg', POSH + 'm_6aa9dcd3ebb1a56446efa83e.jpg', POSH + 'l_6aa9dcd3ebb1a56446efa83e.jpg'],
  ['poshmark s webp twin stays webp', POSH + 's_wp_6aa9dcd3ebb1a56446efa83e.webp', POSH + 'l_wp_6aa9dcd3ebb1a56446efa83e.webp'],
  ['poshmark m webp twin stays webp', POSH + 'm_wp_6aa9dcd3ebb1a56446efa83e.webp', POSH + 'l_wp_6aa9dcd3ebb1a56446efa83e.webp'],
];

for (const [name, input, expected] of RULES) {
  test(`rendition rule: ${name}`, () => {
    assert.equal(upgradeRenditionUrl(input), expected);
  });
}

const NULLS = [
  ['unknown host', 'https://cdn.example/photos/m1_1.jpg?width=256'],
  ['ebay has no measured rule', 'https://i.ebayimg.com/images/g/AbC/s-l300.jpg'],
  ['http', 'http://images.craigslist.org/00q0q_bXdxJgU0nqr_0s00CI_600x450.jpg'],
  ['malformed', 'not a url'],
  ['empty', ''],
  ['non-string', null],
  ['mercari already bare', 'https://u-mercari-images.mercdn.net/photos/m21459589236_1.jpg'],
  ['mercari member avatar', 'https://u-mercari-images.mercdn.net/members/544569412.jpg?width=64'],
  ['hibid already max', HIBID],
  ['hibid without checksum', 'https://cdn.hibid.com/img.axd?id=1&w=720&h=720'],
  ['hibid other path', 'https://cdn.hibid.com/cdn/images/logos/hibid//mainlogo_v2.png'],
  ['shopgoodwill full already', SGW_FULL],
  ['scarab carousel proxy', 'https://imgfly.scarabresearch.com/w_275/' + SGW_THUMB],
  ['craigslist already 1200x900', CL + '1200x900.jpg'],
  ['craigslist unmeasured size', CL + '800x600.jpg'],
  ['poshmark already l', POSH + 'l_6aa9dcd3ebb1a56446efa83e.jpg'],
  ['poshmark already l webp', POSH + 'l_wp_6aa9dcd3ebb1a56446efa83e.webp'],
  ['poshmark user avatar', 'https://di2ponv0v5otw.cloudfront.net/users/2026/08/17/21/t_6a83ddab2e59c3b918351f7f.jpg'],
  ['private lookalike host', 'https://images.craigslist.org.localhost/00q0q_x_600x450.jpg'],
  ['credentials', 'https://user:pw@images.craigslist.org/00q0q_x_600x450.jpg'],
  ['host suffix trick', 'https://images.craigslist.org.example/00q0q_x_600x450.jpg'],
  ['another host carrying a craigslist path', 'https://cdn.example/00q0q_x_600x450.jpg'],
];

for (const [name, input] of NULLS) {
  test(`no rendition rewrite: ${name}`, () => {
    assert.equal(upgradeRenditionUrl(input), null);
  });
}

test('a rewrite never changes the hostname, stays https, and is itself already the largest', () => {
  for (const [, input] of RULES) {
    const out = upgradeRenditionUrl(input);
    assert.equal(new URL(out).hostname, new URL(input).hostname);
    assert.equal(new URL(out).protocol, 'https:');
    assert.equal(upgradeRenditionUrl(out), null);
  }
});

const BASE = 'https://listing.example/item/1';
const CL_SMALL = CL + '600x450.jpg';
const CL_FULL = CL + '1200x900.jpg';

test('fullSizeCandidates tries the site rewrite first for a granted host', () => {
  const urls = fullSizeCandidates({ src: CL_SMALL, naturalWidth: 600, base: BASE, allowedHosts: new Set(['images.craigslist.org']) });
  assert.equal(urls[0], CL_FULL);
});

test('fullSizeCandidates drops the rewrite when the page never loaded images from its host', () => {
  assert.deepEqual(fullSizeCandidates({ src: CL_SMALL, naturalWidth: 600, base: BASE, allowedHosts: new Set(['other.example']) }), []);
});

test('fullSizeCandidates names nothing for an already-largest site photo', () => {
  assert.deepEqual(fullSizeCandidates({ src: CL_FULL, naturalWidth: 1200, base: BASE }), []);
});

test('a failed rewritten fetch yields no photo, so the caller reads the original', async () => {
  const urls = fullSizeCandidates({ src: CL_SMALL, naturalWidth: 600, base: BASE });
  const tried = [];
  const found = await loadFullSize(urls, { width: 600, height: 450 }, async (url) => { tried.push(url); throw new Error('404'); });
  assert.equal(found, null);
  assert.equal(tried[0], CL_FULL);
});

test('a rewritten photo of another shape is rejected and closed, a same-shape larger one accepted', async () => {
  const urls = [CL_FULL];
  const closes = [];
  const square = { width: 900, height: 900, close: () => closes.push('sq') };
  assert.equal(await loadFullSize(urls, { width: 600, height: 450 }, async () => square), null);
  assert.deepEqual(closes, ['sq']);
  const good = { width: 1200, height: 900 };
  assert.equal((await loadFullSize(urls, { width: 600, height: 450 }, async () => good)).url, CL_FULL);
});

test('largerRendition counts a site rewrite as a known larger rendition', () => {
  const src = 'https://u-mercari-images.mercdn.net/thumb/photos/m21459589236_1.jpg?width=256&quality=75&_=1';
  const larger = largerRendition({ src, naturalWidth: 256, naturalHeight: 341, base: BASE });
  assert.equal(larger.url, 'https://u-mercari-images.mercdn.net/photos/m21459589236_1.jpg');
  assert.equal(larger.side, null);
});

test('largerRendition names nothing for an already-largest site photo', () => {
  assert.equal(largerRendition({ src: 'https://u-mercari-images.mercdn.net/photos/m21459589236_1.jpg', naturalWidth: 1500, naturalHeight: 2000, base: BASE }), null);
});

const MERC_THUMB = 'https://u-mercari-images.mercdn.net/thumb/photos/m1_1.jpg?width=256&quality=75';
const MERC_FULL = 'https://u-mercari-images.mercdn.net/photos/m1_1.jpg';
const card = { width: 700, height: 980 };
const fits = (b) => b.width / b.height > 0.62 && b.width / b.height < 0.8;

test('loadTileSource reads the upgraded URL first and returns it', async () => {
  const tried = [];
  const got = await loadTileSource(MERC_THUMB, { load: async (url) => { tried.push(url); return card; }, readable: async () => true, fits });
  assert.equal(got, card);
  assert.deepEqual(tried, [MERC_FULL]);
});

test('loadTileSource falls back silently to the shown URL when the upgraded read fails or throws', async () => {
  for (const failing of [async () => null, async () => { throw new Error('timeout'); }]) {
    const tried = [];
    const got = await loadTileSource(MERC_THUMB, {
      load: async (url) => { tried.push(url); return url === MERC_FULL ? failing() : card; },
      readable: async () => true, fits,
    });
    assert.equal(got, card);
    assert.deepEqual(tried, [MERC_FULL, MERC_THUMB]);
  }
});

test('loadTileSource closes an upgraded picture that is not card-shaped and uses the shown one', async () => {
  const closes = [];
  const wide = { width: 1200, height: 900, close: () => closes.push('wide') };
  const got = await loadTileSource(MERC_THUMB, { load: async (url) => (url === MERC_FULL ? wide : card), readable: async () => true, fits });
  assert.equal(got, card);
  assert.deepEqual(closes, ['wide']);
});

test('loadTileSource never fetches the upgraded URL without access, and reports a failed final read as null', async () => {
  const tried = [];
  const got = await loadTileSource(MERC_THUMB, { load: async (url) => { tried.push(url); return null; }, readable: async () => false, fits });
  assert.equal(got, null);
  assert.deepEqual(tried, [MERC_THUMB]);
});

test('loadTileSource leaves an unknown URL to a single read', async () => {
  const tried = [];
  await loadTileSource('https://cdn.example/a.jpg', { load: async (url) => { tried.push(url); return card; }, readable: async () => true, fits });
  assert.deepEqual(tried, ['https://cdn.example/a.jpg']);
});
