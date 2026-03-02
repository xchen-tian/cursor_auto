const { chromium } = require('playwright-core');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Connect to a running Electron/Chromium instance exposing a CDP endpoint.
 * Works for VS Code / Cursor when launched with --remote-debugging-port.
 */
async function connectOverCDP({ host = '127.0.0.1', port = 9222 } = {}) {
  const url = `http://${host}:${port}`;
  const browser = await chromium.connectOverCDP(url);
  const contexts = browser.contexts();
  const context = contexts.length ? contexts[0] : await browser.newContext();
  return { browser, context, url };
}

async function findPageWithSelector(context, {
  selector,
  containsText,
  timeoutMs = 10000,
  pollMs = 200
} = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pages = context.pages();
    for (const page of pages) {
      try {
        const hit = await page.evaluate(({ selector, containsText }) => {
          const nodes = Array.from(document.querySelectorAll(selector));
          if (!nodes.length) return false;
          if (!containsText) return true;
          return nodes.some(n => (n.textContent || '').includes(containsText));
        }, { selector, containsText });
        if (hit) return page;
      } catch {
        // ignore targets we can't evaluate
      }
    }
    await sleep(pollMs);
  }
  return null;
}

module.exports = {
  connectOverCDP,
  findPageWithSelector,
  sleep,
};
