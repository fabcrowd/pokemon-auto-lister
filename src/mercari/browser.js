import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Real installed Chrome (not bundled Chromium) avoids PerimeterX bot detection.
// AutomationControlled must be disabled at both the launch-arg and default-arg level.
const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled'];
const IGNORE_DEFAULT_ARGS = ['--enable-automation'];

export const MYPAGE_URL = 'https://www.mercari.com/mypage/';
export const SELL_URL = 'https://www.mercari.com/sell/';
const LOGIN_URL_PATTERN = /\/login\//;

function isOnLoginPage(page) {
  return LOGIN_URL_PATTERN.test(page.url());
}

export async function launchMercariContext({
  userDataDir = path.join(process.cwd(), 'data', 'mercari-chrome-profile'),
  headless = false,
} = {}) {
  if (typeof userDataDir !== 'string' || userDataDir.length === 0) {
    throw new Error('Mercari Chrome profile userDataDir must be a non-empty string');
  }
  mkdirSync(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless,
    ignoreDefaultArgs: IGNORE_DEFAULT_ARGS,
    args: LAUNCH_ARGS,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

// Mercari redirects /mypage/ -> /login/ client-side (~15s) when logged out.
export async function isLoggedOut(page, { redirectWaitMs = 15000 } = {}) {
  await page.goto(MYPAGE_URL);
  await page.waitForTimeout(redirectWaitMs);
  return isOnLoginPage(page);
}

export async function waitForHumanLogin(page, { timeoutMs = 30 * 60 * 1000, pollIntervalMs = 5000 } = {}) {
  const start = Date.now();
  let ticks = 0;
  while (isOnLoginPage(page)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for human Mercari login (30 minutes)');
    }
    ticks += 1;
    if (ticks === 1 || ticks % 6 === 0) {
      console.log(`Still waiting for Mercari login… (${Math.round((Date.now() - start) / 1000)}s)`);
    }
    await page.waitForTimeout(pollIntervalMs);
  }
}
