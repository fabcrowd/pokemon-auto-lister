import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMercariDraft } from '../src/mercari/draft.js';

function fakePage({ startsLoggedOut = false } = {}) {
  let url = startsLoggedOut ? 'https://www.mercari.com/login/' : 'https://www.mercari.com/mypage/';
  const calls = [];
  return {
    calls,
    url: () => url,
    goto: async (target) => {
      calls.push(['goto', target]);
      url = target;
    },
    setInputFiles: async (selector, files) => {
      calls.push(['setInputFiles', selector, files]);
    },
    fill: async (selector, value) => {
      calls.push(['fill', selector, value]);
    },
    selectOption: async (selector, value) => {
      calls.push(['selectOption', selector, value]);
    },
    uncheck: async (selector) => {
      calls.push(['uncheck', selector]);
    },
    click: async (selector) => {
      calls.push(['click', selector]);
    },
    waitForTimeout: async () => {},
  };
}

const CARD = {
  title: 'Charizard Base Set 4/102',
  listPrice: 250,
  photos: ['/tmp/front.jpg', '/tmp/back.jpg'],
};

const CONFIG = {
  condition: 'Like new',
  sellerPaidShipping: 'USPS First-Class Envelope ~3 oz (buyer free)',
  smartPricingOff: true,
};

test('createMercariDraft fills title, price, photos, condition, shipping and turns off smart pricing', async () => {
  const page = fakePage();
  const result = await createMercariDraft(CARD, { page, config: CONFIG });

  const fillCalls = page.calls.filter(([action]) => action === 'fill');
  assert.ok(fillCalls.some(([, , value]) => value === CARD.title));
  assert.ok(fillCalls.some(([, , value]) => value === String(CARD.listPrice)));
  assert.ok(fillCalls.some(([, , value]) => value === CONFIG.sellerPaidShipping));

  const photoCalls = page.calls.filter(([action]) => action === 'setInputFiles');
  assert.equal(photoCalls.length, CARD.photos.length);

  const selectCalls = page.calls.filter(([action]) => action === 'selectOption');
  assert.ok(selectCalls.some(([, , value]) => value === CONFIG.condition));

  assert.ok(page.calls.some(([action, selector]) => action === 'uncheck' && /smart.?pricing/i.test(selector)));
  assert.ok(result.draftUrl);
});

test('createMercariDraft saves as draft and never clicks the publish/list button', async () => {
  const page = fakePage();
  await createMercariDraft(CARD, { page, config: CONFIG });

  const clickCalls = page.calls.filter(([action]) => action === 'click');
  assert.ok(clickCalls.some(([, selector]) => /draft/i.test(selector)));
  assert.ok(!clickCalls.some(([, selector]) => /publish|^list$/i.test(selector)));
});

test('createMercariDraft waits for human login when logged-out redirect is detected', async () => {
  const page = fakePage({ startsLoggedOut: true });
  let loginWaited = false;
  const waitForLogin = async (suppliedPage) => {
    loginWaited = true;
    assert.equal(suppliedPage, page);
    await suppliedPage.goto('https://www.mercari.com/mypage/');
  };

  await createMercariDraft(CARD, {
    page,
    config: CONFIG,
    checkLoggedOut: async () => true,
    waitForLogin,
  });

  assert.equal(loginWaited, true);
});

test('createMercariDraft does not wait for login when already logged in', async () => {
  const page = fakePage();
  let loginWaited = false;

  await createMercariDraft(CARD, {
    page,
    config: CONFIG,
    checkLoggedOut: async () => false,
    waitForLogin: async () => {
      loginWaited = true;
    },
  });

  assert.equal(loginWaited, false);
});
