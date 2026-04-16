#!/usr/bin/env node

'use strict';

/**
 * Capture Claude Code webview content via raw CDP.
 *
 * Claude Code runs in isolated vscode-webview:// iframe targets that are
 * invisible to Playwright. This script discovers them via /json/list,
 * identifies Claude targets by DOM fingerprint, then captures each one
 * producing the same artifact set as capture_static.js:
 *   index.html, screenshot.png, snapshot.mhtml, report.json
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const cheerio = require('cheerio');
const { discoverWebviewTargets } = require('./claude_code_clicker');

// ---------------------------------------------------------------------------
// CdpSession — raw WebSocket CDP client for iframe/webview targets
// Playwright cannot reach type:"iframe" targets; this class provides
// multi-command sessions over a single WebSocket connection.
// ---------------------------------------------------------------------------

class CdpSession {
  constructor(wsUrl, timeoutMs = 15000) {
    this._wsUrl = wsUrl;
    this._timeoutMs = timeoutMs;
    this._ws = null;
    this._nextId = 1;
    this._pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this._wsUrl); } catch (e) { return reject(e); }

      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('CDP connect timeout'));
      }, this._timeoutMs);

      ws.on('open', () => { clearTimeout(timer); this._ws = ws; resolve(); });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.id != null && this._pending.has(msg.id)) {
          const p = this._pending.get(msg.id);
          clearTimeout(p.timer);
          this._pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`CDP [${msg.error.code}]: ${msg.error.message}`));
          else p.resolve(msg.result || {});
        }
      });

      ws.on('close', () => {
        for (const p of this._pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('WebSocket closed'));
        }
        this._pending.clear();
      });
    });
  }

  send(method, params = {}) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket not connected'));
    }
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, this._timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    for (const p of this._pending.values()) clearTimeout(p.timer);
    this._pending.clear();
    try { this._ws?.close(); } catch {}
    this._ws = null;
  }
}

// ---------------------------------------------------------------------------
// Claude webview identification
// ---------------------------------------------------------------------------

const CLAUDE_MARKERS = [
  '[class*="chatMessage_"]',
  '[class*="inputBox_"]',
  '[class*="permissionRequestContainer_"]',
  '[class*="terminalContainer_"]',
  '[class*="statusBar_"]',
  '[class*="toolResult_"]',
  '[class*="messageContent_"]',
  '[class*="conversationContainer_"]',
];

function buildFingerprintExpr() {
  const markersJson = JSON.stringify(CLAUDE_MARKERS);
  return `(function() {
  var inner = document.getElementById('active-frame');
  if (!inner) return JSON.stringify({ isClaude: false, reason: 'no-active-frame' });
  var doc;
  try { doc = inner.contentDocument; } catch(e) {
    return JSON.stringify({ isClaude: false, reason: 'cross-origin' });
  }
  if (!doc) return JSON.stringify({ isClaude: false, reason: 'no-contentDocument' });
  var body = doc.body;
  if (!body || body.innerHTML.length < 50)
    return JSON.stringify({ isClaude: false, reason: 'empty-body' });

  var markers = ${markersJson};
  for (var i = 0; i < markers.length; i++) {
    if (doc.querySelector(markers[i])) {
      return JSON.stringify({ isClaude: true, marker: markers[i] });
    }
  }

  var text = (body.textContent || '').substring(0, 5000);
  if (/claude/i.test(text)) {
    return JSON.stringify({ isClaude: true, marker: 'text-claude' });
  }
  return JSON.stringify({ isClaude: false, reason: 'no-markers' });
})()`;
}

/**
 * Extract the inner document HTML from #active-frame.contentDocument.
 */
function buildExtractExpr() {
  return `(function() {
  var inner = document.getElementById('active-frame');
  if (!inner) return null;
  var doc;
  try { doc = inner.contentDocument; } catch(e) { return null; }
  if (!doc || !doc.documentElement) return null;
  return doc.documentElement.outerHTML;
})()`;
}

// ---------------------------------------------------------------------------
// Target discovery — find all Claude Code webview targets
// ---------------------------------------------------------------------------

async function discoverClaudeTargets(host, port) {
  const targets = await discoverWebviewTargets(host, port);
  if (!targets.length) return [];

  const results = [];
  for (const t of targets) {
    let session;
    try {
      session = new CdpSession(t.wsUrl, 8000);
      await session.connect();
      await session.send('Runtime.enable');
      const { result } = await session.send('Runtime.evaluate', {
        expression: buildFingerprintExpr(),
        returnByValue: true,
      });
      const raw = result?.value;
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (parsed.isClaude) {
          // Also extract chat title
          let chatTitle = '';
          try {
            const { result: titleResult } = await session.send('Runtime.evaluate', {
              expression: `(function() {
                var inner = document.getElementById('active-frame');
                if (!inner) return '';
                try {
                  var doc = inner.contentDocument;
                  var el = doc.querySelector('[class*="titleTextInner_"]');
                  return el ? el.textContent.trim() : '';
                } catch(e) { return ''; }
              })()`,
              returnByValue: true,
            });
            chatTitle = titleResult?.value || '';
          } catch {}

          results.push({ ...t, fingerprint: parsed, chatTitle });
          const label = chatTitle ? `"${chatTitle.substring(0, 40)}"` : parsed.marker;
          console.log(`  [+] Claude target: ${t.id.substring(0, 12)} — ${label}`);
        }
      }
    } catch { /* skip unreachable targets */ }
    finally { session?.close(); }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Resource map — collect all resources from the frame tree
// ---------------------------------------------------------------------------

function buildResMap(frameTree) {
  const resMap = new Map();
  const walk = (ft) => {
    const fid = ft.frame.id;
    for (const r of ft.resources || []) {
      if (r?.url) resMap.set(r.url, { frameId: fid, type: r.type, mimeType: r.mimeType });
    }
    for (const c of ft.childFrames || []) walk(c);
  };
  walk(frameTree);
  return resMap;
}

/**
 * Look up a URL in the resource map, trying encoded/decoded variants.
 */
function getResource(resMap, url) {
  if (!resMap) return null;
  if (resMap.has(url)) return { meta: resMap.get(url), matchedUrl: url };
  try {
    const decoded = decodeURIComponent(url);
    if (decoded !== url && resMap.has(decoded)) return { meta: resMap.get(decoded), matchedUrl: decoded };
  } catch {}
  try {
    const encoded = encodeURI(url);
    if (encoded !== url && resMap.has(encoded)) return { meta: resMap.get(encoded), matchedUrl: encoded };
  } catch {}
  return null;
}

/**
 * Resolve a vscode-resource:// or file+.vscode-resource URL to a local path.
 * e.g. https://file%2B.vscode-resource.vscode-cdn.net/Users/x/.cursor/ext/index.css
 *    → /Users/x/.cursor/ext/index.css
 */
function resolveVscodeResourcePath(url) {
  try {
    const decoded = decodeURIComponent(url);
    const m = decoded.match(/^https?:\/\/file\+\.vscode-resource\.vscode-cdn\.net\/(.*)/);
    if (m) return '/' + m[1];
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// JS-based full-page screenshot via SVG foreignObject → Canvas
// This runs entirely inside the webview via Runtime.evaluate, bypassing
// Electron's "top-level targets only" restriction on Page.captureScreenshot.
// Captures the FULL scrollable content of #active-frame, not just viewport.
// ---------------------------------------------------------------------------

/**
 * Take a full-content screenshot of the Claude webview from the main
 * Workbench page.
 *
 * Strategy:
 *  1. Get inner scroll dimensions from the webview CDP session
 *  2. On the Workbench page, find the <webview> element
 *  3. Temporarily expand the webview + all ancestor scroll containers
 *     to the full content height (removing overflow:hidden, fixed heights)
 *  4. Use CDP Page.captureScreenshot with clip + captureBeyondViewport
 *     to capture the entire expanded area
 *  5. Restore original layout
 *
 * @param {string} host
 * @param {number} port
 * @param {string} targetUrl - the vscode-webview:// URL to match
 * @param {CdpSession} webviewSession - open CDP session on the webview
 * @returns {{ buf: Buffer, width: number, height: number, method: string }|null}
 */
async function captureFromWorkbench(host, port, targetUrl, webviewSession) {
  // Step 1: Get layout info from the inner document.
  // Claude Code has: header (title bar, ~41px) + messagesContainer (scrollable)
  // messagesContainer uses virtual scrolling — only visible DOM rendered.
  let layout = null;
  try {
    const { result } = await webviewSession.send('Runtime.evaluate', {
      expression: `(function() {
        var inner = document.getElementById('active-frame');
        if (!inner) return JSON.stringify(null);
        var doc;
        try { doc = inner.contentDocument; } catch(e) { return JSON.stringify(null); }
        if (!doc || !doc.body) return JSON.stringify(null);
        var mc = doc.querySelector('[class*="messagesContainer_"]');
        if (!mc) return JSON.stringify({
          hasMessages: false,
          bodyW: doc.body.scrollWidth, bodyH: doc.body.scrollHeight,
        });
        var mcRect = mc.getBoundingClientRect();
        return JSON.stringify({
          hasMessages: true,
          bodyW: doc.body.scrollWidth,
          mcY: mcRect.y,
          mcW: mcRect.width,
          mcClientH: mc.clientHeight,
          mcScrollH: mc.scrollHeight,
          mcScrollTop: mc.scrollTop,
          headerH: mcRect.y,
          viewportH: window.innerHeight,
        });
      })()`,
      returnByValue: true,
    });
    layout = JSON.parse(result?.value || 'null');
  } catch {}

  if (!layout) return null;

  const needsStitch = layout.hasMessages && layout.mcScrollH > layout.mcClientH + 50;
  if (layout.hasMessages) {
    console.log(`  Layout: header=${layout.headerH}px, messages=${layout.mcClientH}px (scroll=${layout.mcScrollH}px)${needsStitch ? ' → scroll-stitch' : ''}`);
  }

  // Step 2: Connect to Workbench, find webview, do scroll-and-stitch
  const { connectOverCDP, findAllWorkbenchPages, sleep } = require('./cdp');
  const { browser, context } = await connectOverCDP({ host, port });

  try {
    // Wait for all pages to be discovered — connectOverCDP may not
    // immediately see all windows. We need the specific window that
    // contains our Claude webview.
    await sleep(500);
    const allPages = await findAllWorkbenchPages(context, { timeoutMs: 15000 });
    if (!allPages.length) return null;
    console.log(`  Found ${allPages.length} Workbench window(s): ${allPages.map(p => p.project).join(', ')}`);

    for (const wp of allPages) {
      const dpr = await wp.page.evaluate(() => window.devicePixelRatio || 1);

      // Locate the webview container by matching session id from target URL
      const locateResult = await wp.page.evaluate((targetUrl) => {
        var idMatch = targetUrl.match(/[?&]id=([^&]+)/);
        var sessionId = idMatch ? idMatch[1] : '';
        var containers = document.querySelectorAll('.webview.ready');
        var debug = { sessionId: sessionId, containerCount: containers.length, parentIds: [] };
        for (var c of containers) {
          var pid = c.parentElement?.id || '';
          debug.parentIds.push(pid);
          if (pid === sessionId) {
            var r = c.getBoundingClientRect();
            return { found: true, x: r.x, y: r.y, width: r.width, height: r.height, sessionId: sessionId };
          }
        }
        // Fallback: if only one .webview.ready with substantial size, use it
        if (containers.length === 1) {
          var c = containers[0];
          var r = c.getBoundingClientRect();
          if (r.width > 100 && r.height > 100) {
            return { found: true, x: r.x, y: r.y, width: r.width, height: r.height, sessionId: sessionId, method: 'single-fallback' };
          }
        }
        return { found: false, debug: debug };
      }, targetUrl);

      if (!locateResult?.found && locateResult?.debug) {
        console.log(`  [debug] Window "${wp.project}": ${locateResult.debug.containerCount} containers, parentIds=[${locateResult.debug.parentIds.join(', ')}], wanted=${locateResult.debug.sessionId}`);
      }

      if (!locateResult?.found) continue;

      const wvX = Math.max(0, Math.round(locateResult.x));
      const wvY = Math.max(0, Math.round(locateResult.y));
      const wvW = Math.round(locateResult.width);
      const wvH = Math.round(locateResult.height);

      if (!needsStitch) {
        const buf = await wp.page.screenshot({ clip: { x: wvX, y: wvY, width: wvW, height: wvH } });
        return { buf, width: wvW * dpr, height: wvH * dpr, method: 'viewport-clip' };
      }

      // Precise clip regions:
      // header  = wvY to wvY+headerH (static, captured once)
      // messages = wvY+headerH to wvY+headerH+mcClientH (scrolls, multiple tiles)
      const headerH = layout.headerH;
      const mcH = layout.mcClientH;
      const mcX = wvX;
      const mcY = wvY + headerH;

      // Save original scroll position
      const origScrollTop = layout.mcScrollTop;

      // Step A: Capture header once (the area above messagesContainer)
      let headerBuf = null;
      if (headerH > 0) {
        headerBuf = await wp.page.screenshot({
          clip: { x: wvX, y: wvY, width: wvW, height: headerH },
        });
      }

      // Step B: Scroll messagesContainer to top, capture tiles
      await webviewSession.send('Runtime.evaluate', {
        expression: `(function() {
          var inner = document.getElementById('active-frame');
          if (!inner) return;
          try { inner.contentDocument.querySelector('[class*="messagesContainer_"]').scrollTop = 0; } catch(e) {}
        })()`,
        returnByValue: true,
      });
      await sleep(300);

      const tiles = [];
      const stepH = mcH;
      const totalSteps = Math.ceil(layout.mcScrollH / stepH);
      console.log(`  Stitching ${totalSteps} tiles (${stepH}px each, DPR=${dpr})...`);

      for (let i = 0; i < totalSteps; i++) {
        const scrollTo = i * stepH;
        await webviewSession.send('Runtime.evaluate', {
          expression: `(function() {
            var inner = document.getElementById('active-frame');
            if (!inner) return;
            try { inner.contentDocument.querySelector('[class*="messagesContainer_"]').scrollTop = ${scrollTo}; } catch(e) {}
          })()`,
          returnByValue: true,
        });
        await sleep(150);

        // Clip ONLY the messagesContainer area (not header/footer)
        const tileBuf = await wp.page.screenshot({
          clip: { x: mcX, y: mcY, width: wvW, height: mcH },
        });
        tiles.push(tileBuf);
      }

      // Restore scroll position
      await webviewSession.send('Runtime.evaluate', {
        expression: `(function() {
          var inner = document.getElementById('active-frame');
          if (!inner) return;
          try { inner.contentDocument.querySelector('[class*="messagesContainer_"]').scrollTop = ${origScrollTop}; } catch(e) {}
        })()`,
        returnByValue: true,
      }).catch(() => {});

      // Step C: Stitch on canvas in the Workbench page
      // Images from Playwright are DPR-scaled, so pixel dimensions = CSS * DPR
      const pxW = wvW * dpr;
      const pxHeaderH = headerH * dpr;
      const pxStepH = stepH * dpr;
      const lastScrollH = layout.mcScrollH - (totalSteps - 1) * stepH;
      const pxLastH = lastScrollH * dpr;
      let totalPxH = pxHeaderH + layout.mcScrollH * dpr;

      // Chrome canvas max height is ~32767px. Truncate if needed.
      const MAX_CANVAS_H = 32000;
      let truncated = false;
      let useTiles = tiles.length;
      if (totalPxH > MAX_CANVAS_H) {
        truncated = true;
        const availH = MAX_CANVAS_H - pxHeaderH;
        useTiles = Math.floor(availH / pxStepH);
        if (useTiles < 1) useTiles = 1;
        totalPxH = pxHeaderH + useTiles * pxStepH;
        console.log(`  Canvas limit: truncating to ${useTiles}/${tiles.length} tiles (${totalPxH}px)`);
      }

      const usedTiles = tiles.slice(0, useTiles);
      const allB64 = [
        ...(headerBuf ? [headerBuf.toString('base64')] : []),
        ...usedTiles.map(t => t.toString('base64')),
      ];
      const headerCount = headerBuf ? 1 : 0;
      const isLastTruncated = truncated;
      const effectiveLastH = truncated ? pxStepH : pxLastH;

      const stitchResult = await wp.page.evaluate(async ({ allB64, headerCount, pxW, pxHeaderH, pxStepH, pxLastH, totalPxH, numTiles }) => {
        async function loadImg(b64) {
          return new Promise((resolve, reject) => {
            var img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = 'data:image/png;base64,' + b64;
          });
        }

        var imgs = [];
        for (var i = 0; i < allB64.length; i++) {
          imgs.push(await loadImg(allB64[i]));
        }

        var canvas = document.createElement('canvas');
        canvas.width = pxW;
        canvas.height = totalPxH;
        var ctx = canvas.getContext('2d');

        var y = 0;

        // Draw header
        if (headerCount > 0) {
          ctx.drawImage(imgs[0], 0, 0);
          y = pxHeaderH;
        }

        // Draw message tiles
        for (var i = headerCount; i < imgs.length; i++) {
          var tileIdx = i - headerCount;
          var isLast = (tileIdx === numTiles - 1);
          var img = imgs[i];

          if (isLast && pxLastH < pxStepH) {
            // Last tile: only draw the bottom non-overlapping portion
            var srcY = img.height - pxLastH;
            ctx.drawImage(img, 0, srcY, img.width, pxLastH, 0, y, pxW, pxLastH);
            y += pxLastH;
          } else {
            ctx.drawImage(img, 0, 0, img.width, img.height, 0, y, pxW, pxStepH);
            y += pxStepH;
          }
        }

        var dataUrl = canvas.toDataURL('image/png');
        return { b64: dataUrl.split(',')[1] || '', w: canvas.width, h: y };
      }, { allB64, headerCount, pxW, pxHeaderH, pxStepH, pxLastH: effectiveLastH, totalPxH, numTiles: usedTiles.length });

      if (stitchResult?.b64) {
        const buf = Buffer.from(stitchResult.b64, 'base64');
        const desc = truncated
          ? `scroll-stitch (${usedTiles.length}/${tiles.length} tiles, ${dpr}x, truncated)`
          : `scroll-stitch (${tiles.length} tiles, ${dpr}x)`;
        return { buf, width: stitchResult.w, height: stitchResult.h, method: desc };
      }
    }
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Capture one Claude webview target → output directory
// ---------------------------------------------------------------------------

async function captureOneTarget(target, outDir, opts) {
  fs.mkdirSync(outDir, { recursive: true });

  const report = {
    timestamp: new Date().toISOString(),
    targetId: target.id,
    targetUrl: target.url,
    fingerprint: target.fingerprint,
    outputs: {},
    inlinedCss: [],
    embeddedImages: [],
    missingResources: [],
    errors: [],
    notes: [],
  };

  const session = new CdpSession(target.wsUrl, opts.timeout || 30000);
  try {
    await session.connect();
    await session.send('Runtime.enable');
    await session.send('Page.enable');
  } catch (e) {
    report.errors.push({ artifact: 'connect', error: String(e?.message || e) });
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    session.close();
    return report;
  }

  // --- Screenshot ---
  // Strategy 1: CDP Page.captureScreenshot (works on top-level targets)
  // Strategy 2: Inject JS to render full scrollable content via
  //             SVG <foreignObject> → Canvas → PNG base64
  //             This bypasses the Electron iframe target restriction and
  //             captures ALL scrollable content, not just the viewport.
  let screenshotDone = false;
  try {
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
    if (data) {
      fs.writeFileSync(path.join(outDir, 'screenshot.png'), Buffer.from(data, 'base64'));
      report.outputs.screenshot = 'screenshot.png';
      report.notes.push('Screenshot via CDP Page.captureScreenshot.');
      screenshotDone = true;
    }
  } catch { /* iframe target — fall through to JS-based capture */ }

  if (!screenshotDone) {
    try {
      console.log('  Attempting full-content screenshot from Workbench page...');
      const result = await captureFromWorkbench(opts.host, opts.port, target.url, session);
      if (result?.buf) {
        fs.writeFileSync(path.join(outDir, 'screenshot.png'), result.buf);
        report.outputs.screenshot = 'screenshot.png';
        report.notes.push(`Screenshot ${result.width}x${result.height} via ${result.method}.`);
        console.log(`  Screenshot: ${result.width}x${result.height} (${result.method})`);
        screenshotDone = true;
      } else {
        throw new Error('Could not locate Claude webview element in any Workbench page');
      }
    } catch (e) {
      const msg = String(e?.message || e);
      fs.writeFileSync(path.join(outDir, 'screenshot_error.txt'), msg, 'utf8');
      report.errors.push({ artifact: 'screenshot', error: msg });
    }
  }

  // --- MHTML archive ---
  try {
    const { data } = await session.send('Page.captureSnapshot', { format: 'mhtml' });
    if (data) {
      fs.writeFileSync(path.join(outDir, 'snapshot.mhtml'), data, 'utf8');
      report.outputs.mhtml = 'snapshot.mhtml';
    }
  } catch (e) {
    const msg = String(e?.message || e);
    fs.writeFileSync(path.join(outDir, 'snapshot_error.txt'), msg, 'utf8');
    report.errors.push({ artifact: 'mhtml', error: msg });
  }

  // --- HTML extraction from #active-frame inner document ---
  try {
    const { result } = await session.send('Runtime.evaluate', {
      expression: buildExtractExpr(),
      returnByValue: true,
    });
    const rawHtml = result?.value;
    if (!rawHtml) {
      report.errors.push({ artifact: 'html', error: 'empty extraction result' });
    } else {
      const $ = cheerio.load(rawHtml, { decodeEntities: false });

      $('meta[http-equiv="Content-Security-Policy"]').remove();

      const scriptCount = $('script').length;
      $('script').remove();
      if (scriptCount) report.notes.push(`Removed ${scriptCount} <script> tags.`);

      // --- Resource inlining (best-effort) ---
      let resMap = null;
      if (opts.inlineCss || opts.embedImages) {
        try {
          const { frameTree } = await session.send('Page.getResourceTree');
          resMap = buildResMap(frameTree);
        } catch (e) {
          report.notes.push('Resource tree unavailable: ' + String(e?.message || e));
        }
      }

      if (opts.inlineCss) {
        for (const el of $('link[rel="stylesheet"]').toArray()) {
          const href = $(el).attr('href');
          if (!href) continue;
          let inlined = false;

          // Strategy 1: CDP resource tree (with URL variant matching)
          const res = getResource(resMap, href);
          if (res) {
            try {
              const { content, base64Encoded } = await session.send('Page.getResourceContent', {
                frameId: res.meta.frameId, url: res.matchedUrl,
              });
              const css = base64Encoded ? Buffer.from(content, 'base64').toString('utf8') : content;
              $(el).replaceWith(`<style data-inlined-from="${escapeHtml(href)}">\n${css}\n</style>`);
              report.inlinedCss.push(href);
              inlined = true;
            } catch { /* fall through to filesystem */ }
          }

          // Strategy 2: filesystem fallback for vscode-resource URLs
          if (!inlined) {
            const localPath = resolveVscodeResourcePath(href);
            if (localPath && fs.existsSync(localPath)) {
              const css = fs.readFileSync(localPath, 'utf8');
              $(el).replaceWith(`<style data-inlined-from="${escapeHtml(href)}">\n${css}\n</style>`);
              report.inlinedCss.push(href + ' (fs)');
              inlined = true;
            }
          }

          if (!inlined) report.missingResources.push(href);
        }
      }

      if (opts.embedImages) {
        for (const el of $('img[src]').toArray()) {
          const src = $(el).attr('src');
          if (!src || src.startsWith('data:')) continue;
          let embedded = false;

          const res = getResource(resMap, src);
          if (res) {
            try {
              const { content, base64Encoded } = await session.send('Page.getResourceContent', {
                frameId: res.meta.frameId, url: res.matchedUrl,
              });
              const buf = base64Encoded ? Buffer.from(content, 'base64') : Buffer.from(content, 'latin1');
              const mt = res.meta.mimeType || 'application/octet-stream';
              $(el).attr('src', `data:${mt};base64,${buf.toString('base64')}`);
              report.embeddedImages.push(src);
              embedded = true;
            } catch { /* fall through */ }
          }

          if (!embedded) {
            const localPath = resolveVscodeResourcePath(src);
            if (localPath && fs.existsSync(localPath)) {
              const mime = require('mime-types');
              const buf = fs.readFileSync(localPath);
              const mt = mime.lookup(localPath) || 'application/octet-stream';
              $(el).attr('src', `data:${mt};base64,${buf.toString('base64')}`);
              report.embeddedImages.push(src + ' (fs)');
              embedded = true;
            }
          }

          if (!embedded) report.missingResources.push(src);
        }
      }

      // Add static snapshot banner
      $('body').prepend(
        `<div style="position:sticky;top:0;z-index:999999;background:#d4edda;color:#155724;border-bottom:1px solid #c3e6cb;padding:8px 12px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;font-size:12px;line-height:1.4;">` +
        `<b>Claude Code snapshot</b> captured at <code>${report.timestamp}</code>. ` +
        `Target: <code>${escapeHtml(target.id.substring(0, 12))}</code>` +
        `</div>`
      );

      fs.writeFileSync(path.join(outDir, 'index.html'), $.html({ decodeEntities: false }), 'utf8');
      report.outputs.html = 'index.html';
    }
  } catch (e) {
    report.errors.push({ artifact: 'html', error: String(e?.message || e) });
  }

  session.close();
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  return report;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sanitizeDirName(title, maxLen = 60) {
  if (!title) return '';
  let s = title
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '')  // illegal on Windows/macOS/Linux
    .replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, '')  // zero-width / bidi chars
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLen)
    .replace(/[. ]+$/, '');  // trailing dots/spaces are illegal on Windows
  // Reserved names on Windows
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(s)) s = '_' + s;
  return s || '';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('host', { type: 'string', default: '127.0.0.1' })
    .option('port', { type: 'number', default: 9292 })
    .option('out', { type: 'string', default: path.join('dist', 'capture', 'claude') })
    .option('embed-images', { type: 'boolean', default: true })
    .option('inline-css', { type: 'boolean', default: true })
    .option('timeout', { type: 'number', default: 30000 })
    .help()
    .argv;

  console.log('Discovering Claude Code webview targets...');
  const targets = await discoverClaudeTargets(argv.host, argv.port);

  if (targets.length === 0) {
    console.error('ERROR: No Claude Code webview targets found.');
    console.error('Make sure Claude Code extension is active in Cursor.');
    process.exit(1);
  }

  console.log(`Found ${targets.length} Claude Code webview(s).`);

  const stamp = nowStamp();
  const opts = {
    host: argv.host,
    port: argv.port,
    timeout: argv.timeout,
    inlineCss: argv['inline-css'],
    embedImages: argv['embed-images'],
  };

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const titleDir = sanitizeDirName(t.chatTitle);
    let dirName;
    if (targets.length === 1) {
      dirName = titleDir ? `${stamp}_${titleDir}` : stamp;
    } else {
      const sub = titleDir || `target_${i}`;
      dirName = path.join(stamp, sub);
    }
    const outDir = path.resolve(argv.out, dirName);
    console.log(`\nCapturing target ${i + 1}/${targets.length}: ${t.id.substring(0, 12)}...`);
    console.log(`  Output: ${outDir}`);

    const report = await captureOneTarget(t, outDir, opts);

    const artifacts = Object.keys(report.outputs);
    const errors = report.errors.length;
    console.log(`  Artifacts: ${artifacts.join(', ') || 'none'}`);
    if (errors) console.log(`  Errors: ${errors} (see report.json)`);
  }

  console.log('\nCapture complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
