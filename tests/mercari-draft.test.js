import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMercariDraft, createMercariSession, SELECTORS } from '../src/mercari/draft.js';
import { fillMercariSellForm } from '../src/mercari/fill.js';

function fakePage({ startsLoggedOut = false, smartPricingVisible = false } = {}) {
  let url = startsLoggedOut ? 'https://www.mercari.com/login/' : 'https://www.mercari.com/mypage/';
  const calls = [];

  const page = {
    calls,
    url: () => url,
    goto: async (target) => {
      calls.push(['goto', target]);
      url = target;
    },
    waitForSelector: async (selector) => {
      calls.push(['waitForSelector', selector]);
    },
    setInputFiles: async (selector, files) => {
      calls.push(['setInputFiles', selector, files]);
    },
    fill: async (selector, value) => {
      calls.push(['fill', selector, value]);
    },
    fillWeight: async (lb, oz) => {
      calls.push(['fillWeight', lb, oz]);
    },
    evaluate: async (fn, arg) => {
      calls.push(['evaluate', typeof fn === 'function' ? fn.name || 'fn' : String(fn), arg]);
      if (typeof fn === 'function' && typeof arg === 'string') {
        calls.push(['clickText', arg]);
        return true;
      }
      if (typeof fn === 'function') {
        try {
          return await fn(arg);
        } catch {
          return true;
        }
      }
      return true;
    },
    click: async (selector) => {
      calls.push(['click', selector]);
      if (selector === SELECTORS.publishButton || /ListButton/i.test(selector)) {
        url = 'https://www.mercari.com/item/mTEST123/';
      }
    },
    waitForFunction: async () => {
      calls.push(['waitForFunction']);
    },
    gotoListing: async () => {
      url = 'https://www.mercari.com/item/mTEST123/';
      calls.push(['gotoListing']);
    },
    uncheck: async (selector) => {
      calls.push(['uncheck', selector]);
    },
    isVisible: async (selector) => {
      if (/SmartPricing|smartPricing/i.test(selector)) {
        return smartPricingVisible;
      }
      return false;
    },
    waitForTimeout: async () => {},
    getByText: (text) => ({
      first: () => ({
        click: async () => {
          calls.push(['clickText', text]);
        },
      }),
    }),
    getByRole: (role, opts = {}) => {
      const name = opts.name;
      return {
        count: async () => {
          if (role === 'checkbox' && name === 'Pokemon') return 1;
          if (role === 'button' && name === CONFIG.categoryResult) return 1;
          if (role === 'button' && name === 'USPS First-Class Envelope') return 1;
          return 0;
        },
        first: () => ({
          check: async () => {
            calls.push(['checkRole', role, name]);
          },
          click: async () => {
            calls.push(['clickRole', role, name]);
          },
        }),
        check: async () => {
          calls.push(['checkRole', role, name]);
        },
        click: async () => {
          calls.push(['clickRole', role, name]);
        },
      };
    },
    locator: (selector, opts = {}) => {
      calls.push(['locator', selector, opts.hasText || null]);
      return {
        count: async () => 0,
        nth: () => ({ fill: async () => {}, click: async () => {} }),
        first: () => ({
          click: async () => {
            calls.push(['clickLocator', selector, opts.hasText || null]);
          },
          fill: async () => {},
          waitFor: async () => {},
        }),
        last: () => ({
          locator: () => ({
            count: async () => 0,
            first: () => ({ waitFor: async () => {}, click: async () => {}, fill: async () => {} }),
            nth: () => ({ click: async () => {}, fill: async () => {} }),
          }),
        }),
      };
    },
  };

  return page;
}

const CARD = {
  title: 'Charizard Base Set 4/102',
  listPrice: 250,
  photos: ['/tmp/front.jpg', '/tmp/back.jpg'],
  pricedCache: {
    identity: { name: 'Charizard', number: '4/102', set: 'Base Set' },
  },
};

const CONFIG = {
  condition: 'Like new',
  conditionTestId: 'ConditionLikeNew',
  brand: 'Pokemon',
  categorySearch: 'Single Cards',
  categoryResult: 'Toys & Collectibles > Trading Cards > Single Cards',
  sellerPaidShipping: 'USPS First-Class Envelope ~3 oz (buyer free)',
  shipping: {
    method: 'mercari_prepaid',
    freeShippingForBuyer: true,
    weightLb: 0,
    weightOz: 3,
    carrierLabel: 'USPS First-Class Envelope',
  },
  smartPricingOff: true,
  mercariAutoPublish: true,
  descriptionTemplate: '{{name}} {{number}} — {{set}}\nShips next day.',
};

test('fillMercariSellForm fills photos, title, description, category, brand, condition, shipping, price, then Lists', async () => {
  const page = fakePage();
  const result = await fillMercariSellForm(page, {
    title: CARD.title,
    description: 'Charizard 4/102 — Base Set\nShips next day.',
    listPrice: CARD.listPrice,
    photos: CARD.photos,
    config: CONFIG,
  });

  assert.equal(page.calls.filter(([a]) => a === 'setInputFiles').length, 2);
  assert.ok(page.calls.some(([a, s, v]) => a === 'fill' && s === SELECTORS.title && v === CARD.title));
  assert.ok(page.calls.some(([a, s, v]) => a === 'fill' && s === SELECTORS.description && String(v).includes('Charizard')));
  assert.ok(page.calls.some(([a, s]) => a === 'click' && s === SELECTORS.categoryButton));
  assert.ok(page.calls.some(([a, t]) => a === 'clickText' && t === CONFIG.categoryResult) ||
    page.calls.some(([a, , name]) => a === 'clickRole' && name === CONFIG.categoryResult));
  assert.ok(page.calls.some(([a, , name]) => a === 'checkRole' && name === 'Pokemon'));
  assert.ok(page.calls.some(([a, s]) => a === 'click' && s === '[data-testid="ConditionLikeNew"]'));
  assert.ok(page.calls.some(([a, s]) => a === 'click' && s === SELECTORS.mercariShipping));
  assert.ok(
    page.calls.some(([a]) => a === 'waitForFunction') ||
      page.calls.some(([a]) => a === 'fillWeight') ||
      page.calls.some(([a, t]) => a === 'clickText' && t === 'USPS First-Class Envelope') ||
      page.calls.some(([a, , name]) => a === 'clickRole' && name === 'USPS First-Class Envelope'),
  );
  assert.ok(page.calls.some(([a, s, v]) => a === 'fill' && s === SELECTORS.price && v === '250'));
  assert.ok(page.calls.some(([a, s]) => a === 'click' && s === SELECTORS.publishButton));
  assert.ok(!page.calls.some(([a, s]) => a === 'click' && s === SELECTORS.saveDraftButton));
  assert.match(result.listingUrl, /\/item\//);
});

test('fillMercariSellForm saves draft when mercariAutoPublish is false', async () => {
  const page = fakePage();
  await fillMercariSellForm(page, {
    title: 'x',
    description: 'enough words for mercari description field here',
    listPrice: 5,
    photos: ['/tmp/a.jpg'],
    config: { ...CONFIG, mercariAutoPublish: false },
  });
  assert.ok(page.calls.some(([a, s]) => a === 'click' && s === SELECTORS.saveDraftButton));
  assert.ok(!page.calls.some(([a, s]) => a === 'click' && s === SELECTORS.publishButton));
});

test('createMercariDraft builds copy and delegates to fillForm', async () => {
  const page = fakePage();
  let received = null;
  const result = await createMercariDraft(CARD, {
    page,
    config: CONFIG,
    fillForm: async (_page, payload) => {
      received = payload;
    },
  });

  assert.equal(received.title, CARD.title);
  assert.match(received.description, /Charizard/);
  assert.equal(received.listPrice, 250);
  assert.deepEqual(received.photos, CARD.photos);
  assert.ok(result.draftUrl);
});

test('createMercariDraft Lists and never clicks Save draft when auto-publish is on', async () => {
  const page = fakePage();
  const result = await createMercariDraft(CARD, { page, config: CONFIG });

  const clicks = page.calls.filter(([a]) => a === 'click' || a === 'clickText');
  assert.ok(page.calls.some(([a, s]) => a === 'click' && s === SELECTORS.publishButton));
  assert.ok(!page.calls.some(([a, s]) => a === 'click' && s === SELECTORS.saveDraftButton));
  assert.equal(result.published, true);
  assert.match(result.listingUrl, /\/item\//);
  void clicks;
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
    fillForm: async () => {},
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
    fillForm: async () => {},
  });

  assert.equal(loginWaited, false);
});

test('createMercariSession logs in once then reuses the same page for listings', async () => {
  const page = fakePage({ startsLoggedOut: true });
  let loginChecks = 0;
  let loginWaits = 0;
  let closes = 0;
  let lists = 0;

  const session = createMercariSession({
    userDataDir: 'data/test-mercari-profile',
    launchContext: async () => ({
      context: {
        close: async () => {
          closes += 1;
        },
      },
      page,
    }),
    checkLoggedOut: async () => {
      loginChecks += 1;
      return loginChecks === 1;
    },
    waitForLogin: async (suppliedPage) => {
      loginWaits += 1;
      await suppliedPage.goto('https://www.mercari.com/mypage/');
    },
  });

  page.waitForSelector = async () => {};

  await session.createDraft(
    { ...CARD },
    {
      config: {
        ...CONFIG,
      },
    },
  );

  await session.createDraft(CARD, { config: CONFIG });

  assert.equal(loginWaits, 1);
  assert.equal(loginChecks, 1);
  assert.equal(closes, 0);
  lists = page.calls.filter(([a, s]) => a === 'click' && s === SELECTORS.publishButton).length;
  assert.ok(lists >= 2);
});

test('fillMercariSellForm turns off smart pricing when toggle is visible', async () => {
  const page = fakePage({ smartPricingVisible: true });
  await fillMercariSellForm(page, {
    title: 'x',
    description: 'enough words for mercari description field here',
    listPrice: 5,
    photos: ['/tmp/a.jpg'],
    config: CONFIG,
  });
  assert.ok(page.calls.some(([a, s]) => a === 'uncheck' && /smartPricing|SmartPricing/i.test(s)));
});
