import { launchMercariContext, isLoggedOut, waitForHumanLogin, SELL_URL } from './browser.js';

// Best-effort selectors for the Mercari sell form. Verify/update against the
// live DOM before relying on this in production — Mercari changes markup
// without notice.
export const SELECTORS = {
  photoInput: 'input[type="file"]',
  title: 'input[name="name"]',
  price: 'input[name="price"]',
  condition: 'select[name="condition"]',
  shippingPayer: 'select[name="shippingPayer"]',
  smartPricingToggle: 'input[name="smartPricing"]',
  saveDraftButton: 'button:has-text("Save as draft")',
  publishButton: 'button:has-text("List")',
};

export async function createMercariDraft(card, {
  page,
  config = {},
  userDataDir,
  launchContext = launchMercariContext,
  checkLoggedOut = isLoggedOut,
  waitForLogin = waitForHumanLogin,
} = {}) {
  let ownedContext = null;
  if (!page) {
    const launched = await launchContext({ userDataDir });
    ownedContext = launched.context;
    page = launched.page;
  }

  try {
    if (await checkLoggedOut(page)) {
      await waitForLogin(page);
    }

    await page.goto(SELL_URL);

    for (const photoPath of card.photos ?? []) {
      await page.setInputFiles(SELECTORS.photoInput, photoPath);
    }

    await page.fill(SELECTORS.title, card.title);
    await page.fill(SELECTORS.price, String(card.listPrice));
    await page.selectOption(SELECTORS.condition, config.condition ?? '');
    await page.fill(SELECTORS.shippingPayer, config.sellerPaidShipping ?? '');

    if (config.smartPricingOff) {
      await page.uncheck(SELECTORS.smartPricingToggle);
    }

    // Never click SELECTORS.publishButton — draft only, human publishes manually.
    await page.click(SELECTORS.saveDraftButton);

    return { draftUrl: page.url() };
  } finally {
    if (ownedContext) {
      await ownedContext.close();
    }
  }
}
