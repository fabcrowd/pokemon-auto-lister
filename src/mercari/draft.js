import { launchMercariContext, isLoggedOut, waitForHumanLogin, SELL_URL, MYPAGE_URL } from './browser.js';
import { SELECTORS, fillMercariSellForm } from './fill.js';
import { buildListingCopy } from '../listing/listingCopy.js';
import { orderedListingPhotos } from '../photos/roles.js';
import { createMercariMutex } from './mutex.js';

export { SELECTORS };

/**
 * Long-lived Mercari Chrome session: one profile, one login, reused for listings.
 * Mercari blocks automated login — you sign in once in the opened window;
 * cookies stay under data/mercari-chrome-profile for the next run.
 * Sell drafts and sniper share this session via withMercariPage (mutex).
 */
export function createMercariSession({
  userDataDir,
  launchContext = launchMercariContext,
  checkLoggedOut = isLoggedOut,
  waitForLogin = waitForHumanLogin,
  mutex = createMercariMutex(),
} = {}) {
  let context = null;
  let page = null;
  let loginReady = false;
  let launchPromise = null;

  async function ensureBrowser() {
    if (page) {
      return page;
    }
    if (!launchPromise) {
      launchPromise = (async () => {
        console.log('Opening Mercari Chrome profile (log in here if asked — this is not your everyday Chrome window)');
        console.log(`Profile path: ${userDataDir}`);
        const launched = await launchContext({ userDataDir });
        context = launched.context;
        page = launched.page;
        return page;
      })();
    }
    return launchPromise;
  }

  async function ensureLoggedIn() {
    const activePage = await ensureBrowser();
    if (loginReady) {
      return activePage;
    }

    console.log('Checking Mercari login status…');
    if (await checkLoggedOut(activePage)) {
      console.log('');
      console.log('>>> LOG INTO MERCARI IN THE CHROME WINDOW THAT JUST OPENED <<<');
      console.log('>>> Use your normal Mercari email/password or Google login <<<');
      console.log('>>> Leave that window open — we wait up to 30 minutes <<<');
      console.log('');
      await waitForLogin(activePage);
    }

    loginReady = true;
    console.log('Mercari session ready — listings will reuse this logged-in Chrome profile');
    return activePage;
  }

  /**
   * Run work on the shared Mercari page under an exclusive lock.
   * @template T
   * @param {(page: import('playwright').Page) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function withMercariPage(fn) {
    return mutex.withLock(async () => {
      const activePage = await ensureLoggedIn();
      return fn(activePage);
    });
  }

  async function createDraft(card, { config = {} } = {}) {
    return withMercariPage((activePage) =>
      createMercariDraft(card, {
        page: activePage,
        config,
        assumeLoggedIn: true,
      }),
    );
  }

  async function close() {
    loginReady = false;
    launchPromise = null;
    page = null;
    if (context) {
      await context.close();
      context = null;
    }
  }

  function getStatus() {
    return {
      loggedIn: loginReady,
      browserOpen: Boolean(page),
      profileDir: userDataDir || null,
    };
  }

  /**
   * Open Chrome and wait for human login (or no-op if already ready).
   * Safe to call repeatedly from the dashboard Connect button.
   */
  async function connect() {
    await ensureLoggedIn();
    return getStatus();
  }

  return { ensureLoggedIn, connect, getStatus, withMercariPage, createDraft, close, SELL_URL, MYPAGE_URL };
}

export async function createMercariDraft(card, {
  page,
  config = {},
  userDataDir,
  assumeLoggedIn = false,
  launchContext = launchMercariContext,
  checkLoggedOut = isLoggedOut,
  waitForLogin = waitForHumanLogin,
  fillForm = fillMercariSellForm,
} = {}) {
  let ownedContext = null;
  if (!page) {
    const launched = await launchContext({ userDataDir });
    ownedContext = launched.context;
    page = launched.page;
  }

  try {
    if (!assumeLoggedIn && (await checkLoggedOut(page))) {
      console.log('>>> LOG INTO MERCARI IN THE CHROME WINDOW <<<');
      await waitForLogin(page);
    }

    await page.goto(SELL_URL);
    if (typeof page.waitForSelector === 'function') {
      try {
        await page.waitForSelector(SELECTORS.title, { timeout: 30000 });
      } catch (err) {
        throw new Error(`Mercari sell form did not load: ${err.message}`);
      }
    }

    const photos = orderedListingPhotos(card);
    const { title, description } = buildListingCopy(card, config);
    const listPrice = card.listPrice ?? card.pricedCache?.suggested?.mercari;

    const autoPublish = config.mercariAutoPublish !== false;
    console.log(
      `Mercari ${autoPublish ? 'LIST' : 'draft'}: filling form for "${title}" @ $${listPrice}`,
    );
    const filled = await fillForm(page, {
      title,
      description,
      listPrice,
      photos,
      config,
    });

    const listingUrl = filled?.listingUrl || (autoPublish ? page.url() : undefined);
    const draftUrl = filled?.draftUrl || (!autoPublish ? page.url() : undefined);

    return {
      listingUrl,
      draftUrl: draftUrl || listingUrl,
      title,
      description,
      listPrice,
      published: Boolean(autoPublish && listingUrl),
    };
  } finally {
    if (ownedContext) {
      await ownedContext.close();
    }
  }
}
