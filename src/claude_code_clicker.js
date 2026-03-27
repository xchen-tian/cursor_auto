/**
 * Claude Code (VS Code extension) auto-approval via raw CDP.
 *
 * The Claude Code webview lives inside a vscode-webview:// iframe target
 * that is NOT accessible through the normal Playwright page tree.
 * We use raw WebSocket CDP connections to reach into the webview's
 * nested #active-frame iframe and interact with permission dialogs.
 *
 * CSS Modules hash suffixes change per extension version, so all selectors
 * use partial attribute matching: [class*="baseName_"]
 */

const WebSocket = require('ws');

// ---------------------------------------------------------------------------
// Selectors — base CSS-module names (hash-independent)
// ---------------------------------------------------------------------------
const SEL = {
  permissionContainer: '[class*="permissionRequestContainer_"]',
  permissionHeader:    '[class*="permissionRequestHeader_"]',
  buttonContainer:     '[class*="buttonContainer_"]',
  button:              'button[class*="button_"]',
  shortcutNum:         '[class*="shortcutNum_"]',
  rejectInput:         '[class*="rejectMessageInput_"]',
};

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/**
 * Discover all vscode-webview iframe targets from the CDP HTTP endpoint.
 * Returns [{ id, url, wsUrl, title }]
 */
async function discoverWebviewTargets(host, port) {
  const listUrl = `http://${host}:${port}/json/list`;
  const resp = await fetch(listUrl, { signal: AbortSignal.timeout(5000) });
  const targets = await resp.json();
  return targets
    .filter(t => t.type === 'iframe' && t.url && t.url.includes('vscode-webview'))
    .map(t => ({
      id: t.id,
      url: t.url,
      wsUrl: t.webSocketDebuggerUrl,
      title: t.title || '',
    }));
}

/**
 * Open a raw CDP WebSocket, enable Runtime, evaluate an expression,
 * then close. Returns the evaluated value or null on failure.
 */
function evalOnWebview(wsUrl, expression, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return finish(null);
    }

    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      finish(null);
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable', params: {} }));
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.id === 1) {
        ws.send(JSON.stringify({
          id: 2,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true },
        }));
      }
      if (msg.id === 2) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        const val = msg.result?.result?.value ?? null;
        finish(val);
      }
    });

    ws.on('error', () => { clearTimeout(timer); finish(null); });
  });
}

// ---------------------------------------------------------------------------
// Permission dialog detection & approval
// ---------------------------------------------------------------------------

/**
 * Build the in-page expression that checks for a Claude Code permission
 * dialog inside the webview's nested #active-frame and optionally clicks
 * the "Yes" button.
 *
 * @param {boolean} clickYes - if true, click the Yes button when found
 * @returns {string} JS expression returning JSON string
 */
function buildCheckExpr(clickYes) {
  // Inline the selectors so the expression is self-contained
  const sel = JSON.stringify(SEL);

  return `(function(){
  var SEL = ${sel};
  var inner = document.getElementById('active-frame');
  if (!inner) return JSON.stringify({ found: false, reason: 'no-active-frame' });
  var doc;
  try { doc = inner.contentDocument; } catch(e) { return JSON.stringify({ found: false, reason: 'cross-origin' }); }
  if (!doc) return JSON.stringify({ found: false, reason: 'no-contentDocument' });

  var container = doc.querySelector(SEL.permissionContainer);
  if (!container) return JSON.stringify({ found: false });

  var header = container.querySelector(SEL.permissionHeader);
  var headerText = header ? header.textContent.trim() : '';

  var btnBox = container.querySelector(SEL.buttonContainer);
  if (!btnBox) return JSON.stringify({ found: true, headerText: headerText, reason: 'no-buttons' });

  var buttons = Array.from(btnBox.querySelectorAll('button'));
  var yesBtn = null;
  for (var i = 0; i < buttons.length; i++) {
    var num = buttons[i].querySelector(SEL.shortcutNum);
    if (num && num.textContent.trim() === '1') { yesBtn = buttons[i]; break; }
  }
  if (!yesBtn) return JSON.stringify({ found: true, headerText: headerText, reason: 'no-yes-btn', btnCount: buttons.length });

  var yesBtnText = yesBtn.textContent.trim().replace(/\\s+/g, ' ');
  ${clickYes ? `
  yesBtn.click();
  return JSON.stringify({ found: true, clicked: true, headerText: headerText, btnText: yesBtnText });
  ` : `
  return JSON.stringify({ found: true, clicked: false, headerText: headerText, btnText: yesBtnText });
  `}
})()`;
}

/**
 * Check a single webview target for a Claude Code permission dialog.
 * If clickYes is true and a dialog is found, click the Yes button.
 *
 * @returns {{ found, clicked, headerText, btnText, error? } | null}
 */
async function checkWebview(wsUrl, clickYes = true) {
  const raw = await evalOnWebview(wsUrl, buildCheckExpr(clickYes));
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/**
 * Scan all webview targets for Claude Code permission dialogs.
 * Auto-clicks Yes on any found dialog when autoApprove is true.
 *
 * @returns {{ scanned, approved: [{ targetId, headerText, btnText }], errors }}
 */
async function scanAndApprove(host, port, { autoApprove = true } = {}) {
  let targets;
  try {
    targets = await discoverWebviewTargets(host, port);
  } catch (e) {
    return { scanned: 0, approved: [], errors: [e.message] };
  }

  if (targets.length === 0) {
    return { scanned: 0, approved: [], errors: [] };
  }

  const approved = [];
  const errors = [];

  for (const t of targets) {
    try {
      const result = await checkWebview(t.wsUrl, autoApprove);
      if (!result) continue;
      if (result.found && result.clicked) {
        approved.push({
          targetId: t.id,
          headerText: result.headerText || '',
          btnText: result.btnText || '',
        });
      }
    } catch (e) {
      errors.push(`${t.id}: ${e.message}`);
    }
  }

  return { scanned: targets.length, approved, errors };
}

/**
 * One-shot check (no click) — useful for status polling.
 */
async function peekPermission(host, port) {
  let targets;
  try {
    targets = await discoverWebviewTargets(host, port);
  } catch {
    return { found: false, scanned: 0 };
  }

  for (const t of targets) {
    try {
      const result = await checkWebview(t.wsUrl, false);
      if (result?.found) {
        return { found: true, scanned: targets.length, ...result, targetId: t.id };
      }
    } catch {}
  }

  return { found: false, scanned: targets.length };
}

module.exports = {
  discoverWebviewTargets,
  evalOnWebview,
  checkWebview,
  scanAndApprove,
  peekPermission,
  SEL,
};
