const { chromium } = require('playwright-core');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Connect to a running Electron/Chromium instance exposing a CDP endpoint.
 * Works for VS Code / Cursor when launched with --remote-debugging-port.
 */
async function connectOverCDP({ host = '127.0.0.1', port = 9292 } = {}) {
  const url = `http://${host}:${port}`;
  const browser = await chromium.connectOverCDP(url);
  const start = Date.now();
  let contexts = browser.contexts();
  while (!contexts.length && Date.now() - start < 5000) {
    await sleep(200);
    contexts = browser.contexts();
  }
  if (!contexts.length) {
    throw new Error(`No browser contexts found via CDP: ${url}`);
  }
  const context = contexts[0];
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

/**
 * Extract project name from a Cursor window title.
 * Old format: "[filename - ] projectName - profile - Cursor [- suffix]"
 * New format (2.6+): "Chat session started — projectName"
 */
function extractProjectName(title) {
  if (!title) return 'unknown';

  // Format: "filename - projectName [SSH: host] - Profile - Cursor"
  // or:     "filename - projectName [SSH: host] - Cursor"
  const parts = title.split(' - ').map(s => s.trim());
  const cursorIdx = parts.lastIndexOf('Cursor');
  if (cursorIdx >= 2) {
    const raw = parts[cursorIdx - 1].replace(/\s*\[SSH:.*?\]/, '').trim();
    if (raw && raw !== 'Cursor') return raw;
    return parts[cursorIdx - 2];
  }
  if (parts.length >= 3 && parts[parts.length - 1] === 'Cursor') {
    const raw = parts[parts.length - 2].replace(/\s*\[SSH:.*?\]/, '').trim();
    if (raw && raw !== 'Cursor') return raw;
    return parts[parts.length - 3] || parts[0];
  }

  // New format: "... — projectName" (em dash separator)
  const emDashParts = title.split(/\s*\u2014\s*/);
  if (emDashParts.length >= 2) {
    return emDashParts[emDashParts.length - 1].trim();
  }

  return title;
}

/**
 * Find a specific Playwright page by its CDP targetId.
 * Opens a temporary CDP session on each page to call Target.getTargetInfo.
 */
async function findPageByTargetId(context, targetId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const page of context.pages()) {
      let session;
      try {
        session = await context.newCDPSession(page);
        const { targetInfo } = await session.send('Target.getTargetInfo');
        if (targetInfo.targetId === targetId) return page;
      } catch {
        // page may be closing or inaccessible
      } finally {
        try { await session?.detach(); } catch {}
      }
    }
    await sleep(500);
  }
  return null;
}

/**
 * Return all Playwright pages that contain .monaco-workbench (i.e. Cursor windows).
 * Each entry: { page, title, targetId, project }
 */
async function findAllWorkbenchPages(context, { timeoutMs = 10000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const results = [];
    for (const page of context.pages()) {
      let session;
      try {
        const hasWB = await page.evaluate(() => !!document.querySelector('.monaco-workbench'));
        if (!hasWB) continue;
        const title = await page.title();
        session = await context.newCDPSession(page);
        const { targetInfo } = await session.send('Target.getTargetInfo');
        results.push({
          page,
          title,
          targetId: targetInfo.targetId,
          project: extractProjectName(title),
        });
      } catch {
        // skip inaccessible pages
      } finally {
        try { await session?.detach(); } catch {}
      }
    }
    if (results.length > 0) {
      results.sort((a, b) => a.project.localeCompare(b.project));
      return results;
    }
    await sleep(500);
  }
  return [];
}

module.exports = {
  connectOverCDP,
  findPageWithSelector,
  findPageByTargetId,
  findAllWorkbenchPages,
  extractProjectName,
  sleep,
};
