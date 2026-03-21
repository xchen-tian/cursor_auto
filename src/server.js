#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const express = require('express');
const { spawn } = require('child_process');
const mime = require('mime-types');
const { connectOverCDP, findPageByTargetId, findAllWorkbenchPages, extractProjectName, sleep } = require('./cdp');
const { renderLive, buildResMap, extractPageStyles, makeAttrRewriter } = require('./live_render');
const cheerio = require('cheerio');
const indicator = require('./indicator');
const { makeWatcherKey, findRunningClickSupervisors } = require('./click_watch_lock');
const compression = require('compression');
const { scanMaterializedSidebar, revealSidebarPath } = require('./sidebar_materialize');

// Node >= 18 provides global fetch.

function tailLines(s, maxLines = 200) {
  const lines = String(s || '').split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

function parseTrailingJson(s) {
  const text = String(s || '').trim();
  for (let idx = text.lastIndexOf('{'); idx >= 0; idx = text.lastIndexOf('{', idx - 1)) {
    try {
      return JSON.parse(text.slice(idx));
    } catch {}
  }
  return null;
}

const PUBLIC_STATIC_ASSET_PATHS = new Set([
  '/manifest.json',
  '/sw.js',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
]);

function normalizeResolvedPath(p) {
  const resolved = path.resolve(String(p || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithinRoot(rootPath, targetPath) {
  const root = normalizeResolvedPath(rootPath);
  const target = normalizeResolvedPath(targetPath);
  if (target === root) return true;
  const rel = path.relative(root, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function latestCaptureDir(baseDir) {
  const abs = path.resolve(baseDir);
  if (!fs.existsSync(abs)) return null;
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
    .reverse();
  return entries.length ? path.join(abs, entries[0]) : null;
}

function runNode(scriptPath, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, ...(opts.env || {}) },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => out += d.toString());
    child.stderr.on('data', (d) => err += d.toString());
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, out, err });
    });
  });
}

function spawnNodeLong(scriptPath, args, opts = {}) {
  return spawn(process.execPath, [scriptPath, ...args], {
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function probeCDP(host, port) {
  const url = `http://${host}:${port}/json/version`;
  try {
    const r = await fetch(url, { method: 'GET' });
    if (!r.ok) return { ok: false, status: r.status, url };
    const j = await r.json().catch(() => null);
    return { ok: true, url, data: j };
  } catch (e) {
    return { ok: false, url, error: String(e?.message || e) };
  }
}

async function main() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(compression());

  const token = process.env.CURSOR_AUTO_TOKEN || '';
  const requireAuth = !!token;

  app.use((req, res, next) => {
    if (!requireAuth) return next();
    if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_STATIC_ASSET_PATHS.has(req.path)) {
      return next();
    }
    const t = req.get('x-token') || req.query.token || '';
    if (t !== token) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
  });

  const publicDir = path.join(__dirname, '..', 'public');
  app.use('/', express.static(publicDir, { etag: true, lastModified: true }));

  const captureBase = path.join(__dirname, '..', 'dist', 'capture');
  app.use('/captures', express.static(captureBase, { etag: true, lastModified: true }));

  // Long-running watcher processes keyed by host:port.
  /** @type {Map<string, { child: import('child_process').ChildProcess, startedAt: number, params: any, out: string, err: string }>} */
  const watchers = new Map();

  function getWatcher(host, port) {
    return watchers.get(makeWatcherKey(host, port)) || null;
  }

  function stopWatcher(host, port) {
    const key = makeWatcherKey(host, port);
    const watcher = watchers.get(key);
    if (!watcher?.child) return { ok: true, stopped: false };
    try { watcher.child.kill('SIGTERM'); } catch {}
    watchers.delete(key);
    return { ok: true, stopped: true };
  }

  function stopAllWatchers() {
    for (const watcher of watchers.values()) {
      try { watcher.child.kill('SIGTERM'); } catch {}
    }
    watchers.clear();
  }

  app.post('/api/click', async (req, res) => {
    const { host='127.0.0.1', port=9292, selector='.composer-run-button', contains='Fetch', requireReady=true } = req.body || {};

    const probe = await probeCDP(host, port);
    if (!probe.ok) {
      return res.status(400).json({
        ok: false,
        error: 'cdp_unreachable',
        detail: probe,
        hint: 'Start Cursor/VS Code with --remote-debugging-port=9292, then retry.'
      });
    }

    const script = path.join(__dirname, 'auto_click.js');
    const args = [
      '--host', String(host),
      '--port', String(port),
      '--selector', selector,
      '--once',
      '--force',
      '--verbose'
    ];
    if (contains) args.push('--contains', contains);
    if (!requireReady) args.push('--require-ready=false');

    const r = await runNode(script, args);
    res.json({ ok: r.code === 0, code: r.code, stdout: r.out, stderr: r.err });
  });

  // Start long-running auto-click loop via supervisor (manages all windows)
  app.post('/api/click/start', async (req, res) => {
    const { host='127.0.0.1', port=9292, selector='.composer-run-button', contains='Fetch', requireReady=true, interval=300, mode='watch' } = req.body || {};
    const key = makeWatcherKey(host, port);
    const watcher = getWatcher(host, port);
    if (watcher?.child) {
      return res.status(409).json({ ok: false, error: 'watcher_already_running', startedAt: watcher.startedAt, params: watcher.params });
    }

    const existing = findRunningClickSupervisors({ host, port });
    if (existing.length > 0) {
      return res.status(409).json({ ok: false, error: 'watcher_already_running', source: 'external', existing });
    }

    const probe = await probeCDP(host, port);
    if (!probe.ok) {
      return res.status(400).json({
        ok: false,
        error: 'cdp_unreachable',
        detail: probe,
        hint: 'Start Cursor/VS Code with --remote-debugging-port=9292, then retry.'
      });
    }

    // Check if any workbench page already has an active indicator
    try {
      await ensureBrowserConnected(host, port);
      const allPages = await findAllWorkbenchPages(liveState.context, { timeoutMs: 5000 });
      for (const wp of allPages) {
        const ind = await indicator.peek(wp.page);
        if (ind.exists && ind.hbAgeMs < 15000) {
          return res.status(409).json({ ok: false, error: 'indicator_already_active', indicator: ind, window: wp.project });
        }
      }
    } catch {}

    const script = path.join(__dirname, 'click_supervisor.js');
    const args = [
      '--host', String(host),
      '--port', String(port),
      '--selector', selector,
      '--interval', String(interval),
      '--verbose'
    ];
    if (mode === 'scan') args.push('--scan-tabs');
    if (contains) args.push('--contains', contains);
    if (!requireReady) args.push('--require-ready=false');

    const child = spawnNodeLong(script, args);
    const record = {
      child,
      startedAt: Date.now(),
      params: { host, port, selector, contains, requireReady, interval, mode },
      out: '',
      err: '',
    };
    watchers.set(key, record);
    child.stdout.on('data', (d) => {
      const current = watchers.get(key);
      if (current?.child === child) current.out += d.toString();
    });
    child.stderr.on('data', (d) => {
      const current = watchers.get(key);
      if (current?.child === child) current.err += d.toString();
    });
    child.on('exit', () => {
      const current = watchers.get(key);
      if (current?.child === child) watchers.delete(key);
    });
    res.json({ ok: true, startedAt: record.startedAt, params: record.params });
  });

  app.post('/api/click/stop', async (req, res) => {
    const { host='127.0.0.1', port=9292 } = req.body || {};
    const processResult = stopWatcher(host, port);

    // Remove indicator DOM from all workbench pages
    let removedCount = 0;
    try {
      await ensureBrowserConnected(host, port);
      const allPages = await findAllWorkbenchPages(liveState.context, { timeoutMs: 5000 });
      for (const wp of allPages) {
        try {
          const r = await indicator.remove(wp.page);
          if (r?.removed) removedCount++;
        } catch {}
      }
    } catch {}

    res.json({ ...processResult, indicatorRemoved: removedCount > 0, removedCount });
  });

  app.get('/api/click/status', async (req, res) => {
    const host = String(req.query.host || '127.0.0.1');
    const port = Number(req.query.port || 9292);
    const reqTargetId = req.query.targetId || '';
    const watcher = getWatcher(host, port);

    const windows = [];
    let anyAlive = false;
    try {
      await ensureBrowserConnected(host, port);
      const allPages = await findAllWorkbenchPages(liveState.context, { timeoutMs: 5000 });
      for (const wp of allPages) {
        const ind = await indicator.peek(wp.page).catch(() => ({ exists: false }));
        const alive = ind.exists && ind.hbAgeMs < 15000;
        if (alive) anyAlive = true;
        windows.push({ targetId: wp.targetId, project: wp.project, title: wp.title, indicator: ind });
      }
    } catch {}

    // For backward compat: pick the requested window or first one
    let ind = { exists: false };
    if (reqTargetId) {
      const w = windows.find(w => w.targetId === reqTargetId);
      if (w) ind = w.indicator;
    } else if (windows.length > 0) {
      ind = windows[0].indicator;
    }
    const indicatorAlive = ind.exists && ind.hbAgeMs < 15000;
    const externalWatchers = watcher?.child ? [] : findRunningClickSupervisors({ host, port });
    const hasExternalWatcher = externalWatchers.length > 0;

    res.json({
      ok: true,
      active: !!watcher?.child || hasExternalWatcher || anyAlive,
      source: watcher?.child ? 'server' : (hasExternalWatcher || anyAlive) ? 'external' : null,
      running: !!watcher?.child,
      startedAt: watcher?.startedAt || null,
      params: watcher?.params || null,
      indicator: ind,
      windows,
      stdoutTail: tailLines(watcher?.out, 200),
      stderrTail: tailLines(watcher?.err, 200),
      externalWatchers,
    });
  });

  // GET /api/click/indicator — read-only indicator state (does NOT refresh heartbeat)
  app.get('/api/click/indicator', async (req, res) => {
    const host = String(req.query.host || '127.0.0.1');
    const port = Number(req.query.port || 9292);
    const targetId = req.query.targetId || '';

    try {
      const state = await getLiveCDP(host, port, targetId ? { targetId, timeout: 5000 } : { timeout: 5000 });
      const ind = await indicator.peek(state.page);
      res.json({ ok: true, ...ind });
    } catch (e) {
      res.json({ ok: true, exists: false, cdpError: String(e?.message || e) });
    }
  });

  // POST /api/click/mode — switch watch/scan mode on ALL running indicators
  app.post('/api/click/mode', async (req, res) => {
    const { host='127.0.0.1', port=9292, mode } = req.body || {};
    if (mode !== 'watch' && mode !== 'scan') {
      return res.status(400).json({ ok: false, error: 'mode must be "watch" or "scan"' });
    }
    try {
      await ensureBrowserConnected(host, port);
      const allPages = await findAllWorkbenchPages(liveState.context, { timeoutMs: 5000 });
      let count = 0;
      for (const wp of allPages) {
        try { await indicator.setMode(wp.page, mode); count++; } catch {}
      }
      res.json({ ok: true, mode, windowCount: count });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // POST /api/click/pause — pause or resume ALL running indicators
  app.post('/api/click/pause', async (req, res) => {
    const { host='127.0.0.1', port=9292, paused } = req.body || {};
    if (typeof paused !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'paused must be a boolean' });
    }
    try {
      await ensureBrowserConnected(host, port);
      const allPages = await findAllWorkbenchPages(liveState.context, { timeoutMs: 5000 });
      let count = 0;
      for (const wp of allPages) {
        try { await indicator.setPaused(wp.page, paused); count++; } catch {}
      }
      res.json({ ok: true, paused, windowCount: count });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // GET /api/windows — list all Cursor workbench windows
  app.get('/api/windows', async (req, res) => {
    const host = String(req.query.host || '127.0.0.1');
    const port = Number(req.query.port || 9292);

    try {
      await ensureBrowserConnected(host, port);
      const allPages = await findAllWorkbenchPages(liveState.context, { timeoutMs: 8000 });
      const windows = [];
      for (const wp of allPages) {
        let ind = { exists: false };
        try { ind = await indicator.peek(wp.page); } catch {}
        windows.push({
          targetId: wp.targetId,
          project: wp.project,
          title: wp.title,
          indicator: ind,
        });
      }
      res.json({ ok: true, count: windows.length, windows });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.post('/api/capture', async (req, res) => {
    const { host='127.0.0.1', port=9292, selector='.monaco-workbench', contains='' } = req.body || {};

    const probe = await probeCDP(host, port);
    if (!probe.ok) {
      return res.status(400).json({
        ok: false,
        error: 'cdp_unreachable',
        detail: probe,
        hint: 'Start Cursor/VS Code with --remote-debugging-port=9292, then retry.'
      });
    }

    const script = path.join(__dirname, 'capture_static.js');
    const args = [
      '--host', String(host),
      '--port', String(port),
      '--selector', selector,
      '--out', captureBase,
    ];
    if (contains) args.push('--contains', contains);

    const r = await runNode(script, args);
    const latest = latestCaptureDir(captureBase);
    const rel = latest ? path.relative(path.join(__dirname, '..'), latest) : null;
    res.json({ ok: r.code === 0, code: r.code, stdout: r.out, stderr: r.err, latestCapture: rel });
  });

  app.get('/api/status', async (req, res) => {
    const host = String(req.query.host || '127.0.0.1');
    const port = Number(req.query.port || 9292);
    const watcher = getWatcher(host, port);
    const probe = await probeCDP(host, port);
    const latest = latestCaptureDir(captureBase);
    const rel = latest ? path.relative(captureBase, latest).replace(/\\/g, '/') : null;
    res.json({
      ok: true,
      cdp: probe,
      watcherRunning: !!watcher?.child,
      latestCapture: rel,
      latestUrl: rel ? `/captures/${rel}/index.html` : null,
    });
  });

  app.get('/api/latest', (req, res) => {
    const latest = latestCaptureDir(captureBase);
    if (!latest) return res.json({ ok: true, latest: null });
    const rel = path.relative(captureBase, latest).replace(/\\/g, '/');
    res.json({ ok: true, latest: rel, url: `/captures/${rel}/index.html` });
  });

  // appRoot cache for vscode-file proxy
  const appRootCache = new Map(); // "host:port" → appRoot string

  async function resolveAppRoot(host, port) {
    // Manual override wins
    if (process.env.CURSOR_APP_ROOT) return process.env.CURSOR_APP_ROOT;

    const key = `${host}:${port}`;
    if (appRootCache.has(key)) return appRootCache.get(key);
    const r = await runNode(path.join(__dirname, 'get_resource_path.js'),
                            ['--host', String(host), '--port', String(port)]);
    if (r.code !== 0) throw new Error('get_resource_path failed: ' + r.err);
    const parsed = JSON.parse(r.out.trim());
    if (!parsed.ok || !parsed.appRoot) throw new Error(JSON.stringify(parsed));
    appRootCache.set(key, parsed.appRoot);
    return parsed.appRoot;
  }

  // ---------------------------------------------------------------------------
  // Persistent CDP connection for live rendering (avoids child-process spawn)
  // ---------------------------------------------------------------------------
  const liveState = {
    browser: null,
    context: null,
    connecting: null,
    key: '',
    cssCache: new Map(),
    pages: new Map(), // targetId -> { page, client, resMap, resMapAt, title, project }
  };
  const RES_MAP_TTL = 60 * 1000;
  const CSS_TTL = 5 * 60 * 1000;

  function resetLiveCDP() {
    try { liveState.browser?.close(); } catch {}
    liveState.browser = null;
    liveState.context = null;
    liveState.pages.clear();
    liveState.connecting = null;
    liveState.key = '';
  }

  async function ensureBrowserConnected(host, port) {
    const wantedKey = makeWatcherKey(host, port);
    if (liveState.connecting) {
      await liveState.connecting;
      if (liveState.context && liveState.key === wantedKey) return;
    }
    if (liveState.context) {
      if (liveState.key !== wantedKey) {
        resetLiveCDP();
      } else {
        try {
          liveState.context.pages();
          return;
        } catch {
          resetLiveCDP();
        }
      }
    }
    liveState.connecting = (async () => {
      try {
        const { browser, context } = await connectOverCDP({ host, port });
        liveState.browser = browser;
        liveState.context = context;
        liveState.key = wantedKey;
      } finally {
        liveState.connecting = null;
      }
    })();
    await liveState.connecting;
  }

  /**
   * Get a live CDP page+client for a specific window.
   * @param {string} host
   * @param {number} port
   * @param {object} opts - { targetId, windowIndex, selector, timeout }
   *   targetId takes priority; windowIndex (default 0) as fallback.
   * @returns {{ page, client, resMap, resMapAt, cssCache }}
   */
  async function getLiveCDP(host, port, selectorOrOpts, timeoutOrUndef) {
    let targetId, windowIndex, selector, timeout;
    if (typeof selectorOrOpts === 'object' && selectorOrOpts !== null && !Array.isArray(selectorOrOpts)) {
      ({ targetId, windowIndex = 0, selector = '.monaco-workbench', timeout = 15000 } = selectorOrOpts);
    } else {
      selector = selectorOrOpts || '.monaco-workbench';
      timeout = timeoutOrUndef || 15000;
      windowIndex = 0;
    }

    await ensureBrowserConnected(host, port);

    let page;
    let pageTargetId = targetId;

    if (targetId) {
      const cached = liveState.pages.get(targetId);
      if (cached) {
        try {
          await cached.page.title();
          return { page: cached.page, client: cached.client, resMap: cached.resMap, resMapAt: cached.resMapAt, cssCache: liveState.cssCache };
        } catch {
          liveState.pages.delete(targetId);
        }
      }
      page = await findPageByTargetId(liveState.context, targetId, timeout);
      if (!page) throw new Error(`Page not found for targetId: ${targetId}`);
    } else {
      const all = await findAllWorkbenchPages(liveState.context, { timeoutMs: timeout });
      if (all.length === 0) throw new Error('No workbench page found');
      if (windowIndex >= all.length) throw new Error(`windowIndex ${windowIndex} out of range (found ${all.length})`);
      const entry = all[windowIndex];
      page = entry.page;
      pageTargetId = entry.targetId;

      const cached = liveState.pages.get(pageTargetId);
      if (cached) {
        try {
          await cached.page.title();
          return { page: cached.page, client: cached.client, resMap: cached.resMap, resMapAt: cached.resMapAt, cssCache: liveState.cssCache };
        } catch {
          liveState.pages.delete(pageTargetId);
        }
      }
    }

    const client = await liveState.context.newCDPSession(page);
    await client.send('Page.enable');
    const title = await page.title().catch(() => '');
    const ps = { page, client, resMap: null, resMapAt: 0, title, project: extractProjectName(title) };
    liveState.pages.set(pageTargetId, ps);

    return { page: ps.page, client: ps.client, resMap: ps.resMap, resMapAt: ps.resMapAt, cssCache: liveState.cssCache };
  }

  async function ensureResMap(state, targetId) {
    const now = Date.now();
    if (targetId) {
      const ps = liveState.pages.get(targetId);
      if (ps && ps.resMap && (now - ps.resMapAt) < RES_MAP_TTL) return ps.resMap;
      const tree = await state.client.send('Page.getResourceTree');
      const resMap = buildResMap(tree);
      if (ps) { ps.resMap = resMap; ps.resMapAt = now; }
      return resMap;
    }
    if (state.resMap && (now - state.resMapAt) < RES_MAP_TTL) return state.resMap;
    const tree = await state.client.send('Page.getResourceTree');
    state.resMap = buildResMap(tree);
    state.resMapAt = now;
    return state.resMap;
  }

  // GET /api/live — render live snapshot in-process (persistent CDP, cached CSS)
  app.get('/api/live', async (req, res) => {
    const host = String(req.query.host || '127.0.0.1');
    const port = Number(req.query.port || 9292);
    const timeout = Number(req.query.timeout || 15000);
    const targetId = req.query.targetId || '';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    let state;
    try {
      state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout });
    } catch (e) {
      resetLiveCDP();
      return res.status(400).send('<html><body>CDP connect failed: ' + String(e?.message || e) + '</body></html>');
    }

    try {
      const t0 = Date.now();
      const resMap = await ensureResMap(state, targetId || undefined);
      const t1 = Date.now();
      const { html } = await renderLive(state.page, state.client, {
        proxyBase: '/api/vscode-file',
        token: requireAuth ? token : '',
        cssCache: liveState.cssCache,
        cssTtl: CSS_TTL,
        resMap,
      });
      const t2 = Date.now();
      res.send(html);
      console.log('[live] resMap=%dms render=%dms total=%dms size=%dKB',
        t1 - t0, t2 - t1, Date.now() - t0, (html.length / 1024) | 0);
    } catch (e) {
      resetLiveCDP();
      if (!res.headersSent) {
        res.status(500).send('<html><body>Live render error: ' + String(e?.message || e) + '</body></html>');
      }
    }
  });

  // POST /api/remote-click — trigger CDP click on remote Cursor
  app.post('/api/remote-click', async (req, res) => {
    const { host='127.0.0.1', port=9292, selector, containsText='', requireReady=false, targetId='' } = req.body || {};
    console.log('[remote-click] selector=%s targetId=%s', selector?.substring(0, 120), targetId?.substring(0, 8));

    if (!selector || !selector.trim()) {
      return res.status(400).json({ ok: false, error: 'selector is required' });
    }

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });
      const result = await state.page.evaluate((sel) => {
        const node = document.querySelector(sel);
        if (!node) return { ok: false, reason: 'not_found' };
        node.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = node.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          node.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, button: 0, buttons: type.includes('down') ? 1 : 0,
          }));
        }
        return { ok: true, tag: node.tagName, x: Math.round(x), y: Math.round(y) };
      }, selector);
      console.log('[remote-click] result:', JSON.stringify(result));
      res.json(result);
    } catch (e) {
      console.log('[remote-click] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // POST /api/remote-scroll — forward wheel events via CDP + direct scrollTop
  app.post('/api/remote-scroll', async (req, res) => {
    const { host='127.0.0.1', port=9292, x=0, y=0, deltaX=0, deltaY=0, targetId='' } = req.body || {};

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });

      // Strategy 1: CDP mouseWheel for general page elements (editor, sidebar, etc.)
      await state.client.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Number(x),
        y: Number(y),
        deltaX: Number(deltaX),
        deltaY: Number(deltaY),
      });

      // Strategy 2: Direct scrollTop manipulation for composer conversation area.
      // Monaco's custom scrollable elements intercept native wheel events,
      // so CDP mouseWheel may not reliably scroll the conversation.
      if (deltaY !== 0) {
        await state.page.evaluate(({ dy }) => {
          const scrollables = document.querySelectorAll(
            '.composer-messages-container .monaco-scrollable-element > div'
          );
          for (const el of scrollables) {
            if (el.scrollHeight > el.clientHeight) {
              el.scrollTop += dy;
            }
          }
        }, { dy: Number(deltaY) });
      }

      res.json({ ok: true });
    } catch (e) {
      console.log('[remote-scroll] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------------------------------------------------------------------------
  // Composer text insertion API (CDP Input.insertText + dispatchKeyEvent)
  // ---------------------------------------------------------------------------
  const COMPOSER_INPUT_SEL = '.aislash-editor-input';

  async function dispatchKey(client, key, code, vk, modifiers = 0) {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: vk,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: vk,
    });
  }

  // POST /api/composer/insert — insert text into Cursor composer input
  app.post('/api/composer/insert', async (req, res) => {
    const {
      host = '127.0.0.1', port = 9292,
      text = '', append = true, send = false, targetId = '',
    } = req.body || {};
    console.log('[composer/insert] len=%d append=%s send=%s', text.length, append, send);

    if (!text && !send) {
      return res.status(400).json({ ok: false, error: 'text is required (or set send=true to just press Enter)' });
    }

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });

      const focused = await state.page.evaluate(({ sel, selectAll }) => {
        const editor = document.querySelector(sel);
        if (!editor) return false;
        editor.focus();
        if (selectAll) {
          const s = window.getSelection();
          const r = document.createRange();
          r.selectNodeContents(editor);
          s.removeAllRanges();
          s.addRange(r);
        }
        return true;
      }, { sel: COMPOSER_INPUT_SEL, selectAll: !append });

      if (!focused) {
        return res.status(404).json({ ok: false, error: 'composer input not found (.aislash-editor-input)' });
      }

      const normalized = text.replace(/\r\n/g, '\n');
      const lines = normalized.split('\n');

      if (text) {
        for (let i = 0; i < lines.length; i++) {
          if (i > 0) {
            // Shift+Enter = new line (Enter alone sends the message)
            await dispatchKey(state.client, 'Enter', 'Enter', 13, 8);
          }
          if (lines[i]) {
            await state.client.send('Input.insertText', { text: lines[i] });
          }
        }
      }

      if (send) {
        await dispatchKey(state.client, 'Enter', 'Enter', 13);
      }

      res.json({ ok: true, length: text.length, lines: lines.length, sent: send });
    } catch (e) {
      console.log('[composer/insert] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // POST /api/composer/send — press Enter to send current composer content
  app.post('/api/composer/send', async (req, res) => {
    const { host = '127.0.0.1', port = 9292, targetId = '' } = req.body || {};
    console.log('[composer/send]');

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });

      await state.page.evaluate((sel) => {
        const editor = document.querySelector(sel);
        if (editor) editor.focus();
      }, COMPOSER_INPUT_SEL);

      await dispatchKey(state.client, 'Enter', 'Enter', 13);

      res.json({ ok: true });
    } catch (e) {
      console.log('[composer/send] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // POST /api/composer/new-chat — click the "New Chat" button in Cursor
  const NEW_CHAT_SEL = 'a.codicon-add-two[role="button"]';

  app.post('/api/composer/new-chat', async (req, res) => {
    const { host = '127.0.0.1', port = 9292, targetId = '' } = req.body || {};
    console.log('[composer/new-chat] targetId=%s', (targetId || '').substring(0, 8));

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });

      const result = await state.page.evaluate((sel) => {
        const btns = Array.from(document.querySelectorAll(sel));
        const btn = btns.find(b => (b.getAttribute('aria-label') || '').includes('New Chat'));
        if (!btn) return { ok: false, reason: 'not_found', candidates: btns.length };

        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return {
          ok: true,
          ariaLabel: (btn.getAttribute('aria-label') || '').substring(0, 80),
        };
      }, NEW_CHAT_SEL);

      console.log('[composer/new-chat] result:', JSON.stringify(result));
      res.json(result);
    } catch (e) {
      console.log('[composer/new-chat] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------------------------------------------------------------------------
  // Chat View API — tab list + conversation content extraction
  // ---------------------------------------------------------------------------

  const chatStylesCache = { styles: null, hash: null, at: 0 };
  const CHAT_STYLES_TTL = 5 * 60 * 1000;

  app.get('/api/chat-tabs', async (req, res) => {
    const host = String(req.query.host || '127.0.0.1');
    const port = Number(req.query.port || 9292);
    const targetId = req.query.targetId || '';

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });
      const result = await state.page.evaluate(() => {
        const isAgent = document.body.classList.contains('agent-unification-enabled');

        if (isAgent) {
          const rows = document.querySelectorAll('.agent-sidebar-cell');
          const tabs = Array.from(rows).slice(0, 10)
            .map((r, i) => ({
              index: i,
              title: (r.querySelector('.agent-sidebar-cell-text')?.textContent || '').trim(),
              selected: r.dataset.selected === 'true',
            }))
            .filter(t => t.title.length > 0 && t.title !== 'More');
          return { mode: 'agent', tabs };
        }

        const filter = (t) => {
          if (t.closest('.tabs-container')) return false;
          if (t.closest('.panel .composite-bar')) return false;
          if (t.closest('.composite.bar')) return false;
          if (t.closest('.activitybar')) return false;
          return true;
        };
        const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
          .filter(filter)
          .map((t, i) => ({
            index: i,
            title: (t.getAttribute('aria-label') || t.textContent || '').trim().substring(0, 60),
            selected: t.getAttribute('aria-selected') === 'true',
          }));
        return { mode: 'editor', tabs };
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      console.log('[chat-tabs] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // POST /api/chat-tab/close — close a chat tab by index
  app.post('/api/chat-tab/close', async (req, res) => {
    const { host = '127.0.0.1', port = 9292, tabIndex, targetId = '' } = req.body || {};
    if (tabIndex == null || tabIndex < 0) {
      return res.status(400).json({ ok: false, error: 'tabIndex is required (>= 0)' });
    }
    console.log('[chat-tab/close] tabIndex=%d targetId=%s', tabIndex, (targetId || '').substring(0, 8));

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });
      const result = await state.page.evaluate(({ idx }) => {
        const filter = (t) => {
          if (t.closest('.tabs-container')) return false;
          if (t.closest('.panel .composite-bar')) return false;
          if (t.closest('.composite.bar')) return false;
          if (t.closest('.activitybar')) return false;
          return true;
        };
        const tabs = Array.from(document.querySelectorAll('[role="tab"]')).filter(filter);
        if (idx >= tabs.length) return { ok: false, reason: 'out_of_range', total: tabs.length };
        const tab = tabs[idx];
        const label = (tab.getAttribute('aria-label') || tab.textContent || '').trim().substring(0, 60);
        const closeBtn = tab.querySelector('.codicon-close.remove-button');
        if (!closeBtn) return { ok: false, reason: 'no_close_button', label };
        closeBtn.click();
        return { ok: true, closedTab: label, remaining: tabs.length - 1 };
      }, { idx: Number(tabIndex) });
      res.json(result);
    } catch (e) {
      console.log('[chat-tab/close] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get('/api/chat-content', async (req, res) => {
    const host = String(req.query.host || '127.0.0.1');
    const port = Number(req.query.port || 9292);
    const tab = Number(req.query.tab ?? -1);
    const needStyles = req.query.needStyles === '1';
    const clientHash = String(req.query.stylesHash || '');
    const targetId = req.query.targetId || '';

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });

      if (tab >= 0) {
        const switched = await state.page.evaluate(({ idx }) => {
          const isAgent = document.body.classList.contains('agent-unification-enabled');
          if (isAgent) {
            const rows = Array.from(document.querySelectorAll('.agent-sidebar-cell'))
              .slice(0, 10)
              .filter(r => {
                const t = (r.querySelector('.agent-sidebar-cell-text')?.textContent || '').trim();
                return t.length > 0 && t !== 'More';
              });
            if (idx >= rows.length) return { ok: false, reason: 'out_of_range' };
            if (rows[idx].dataset.selected === 'true') return { ok: true, alreadySelected: true };
            rows[idx].scrollIntoView({ block: 'center' });
            rows[idx].click();
            return { ok: true, alreadySelected: false };
          }
          const filter = (t) => {
            if (t.closest('.tabs-container')) return false;
            if (t.closest('.panel .composite-bar')) return false;
            if (t.closest('.composite.bar')) return false;
            if (t.closest('.activitybar')) return false;
            return true;
          };
          const tabs = Array.from(document.querySelectorAll('[role="tab"]')).filter(filter);
          if (idx >= tabs.length) return { ok: false, reason: 'out_of_range' };
          if (tabs[idx].getAttribute('aria-selected') === 'true') return { ok: true, alreadySelected: true };
          tabs[idx].click();
          return { ok: true, alreadySelected: false };
        }, { idx: tab });

        if (!switched.ok) {
          return res.status(400).json({ ok: false, error: switched.reason || 'switch failed' });
        }
        if (!switched.alreadySelected) {
          await sleep(500);
        }
      }

      const resMap = await ensureResMap(state, targetId || undefined);
      const proxyBase = '/api/vscode-file';

      let styles = null;
      let stylesHash = null;
      const now = Date.now();
      if (needStyles || !clientHash || (chatStylesCache.hash && clientHash !== chatStylesCache.hash)) {
        if (chatStylesCache.styles && (now - chatStylesCache.at) < CHAT_STYLES_TTL && !needStyles) {
          styles = chatStylesCache.styles;
          stylesHash = chatStylesCache.hash;
        } else {
          const extracted = await extractPageStyles(state.page, state.client, {
            proxyBase, cssCache: liveState.cssCache, cssTtl: CSS_TTL, resMap,
          });
          styles = extracted.styles;
          stylesHash = extracted.stylesHash;
          chatStylesCache.styles = styles;
          chatStylesCache.hash = stylesHash;
          chatStylesCache.at = now;
        }
      } else {
        stylesHash = chatStylesCache.hash || clientHash;
      }

      // Extract theme classes, CSS vars, and composer status from Cursor DOM
      const { themeInfo, composerStatus } = await state.page.evaluate(() => {
        const bar = document.querySelector('.composer-bar[data-composer-status]');
        const stopBtn = document.querySelector('.send-with-mode .anysphere-icon-button[data-stop-button="true"]');
        return {
          themeInfo: {
            htmlClass: document.documentElement.className || '',
            bodyClass: document.body?.className || '',
            htmlStyle: document.documentElement.getAttribute('style') || '',
            bodyStyle: document.body?.getAttribute('style') || '',
            wbStyle: document.querySelector('.monaco-workbench')?.getAttribute('style') || '',
          },
          composerStatus: {
            status: bar?.dataset?.composerStatus ?? null,
            hasStopButton: !!stopBtn,
          },
        };
      });

      const pageUrl = state.page.url();
      const dom = await state.page.content();
      const $ = cheerio.load(dom, { decodeEntities: false });

      const container = $('.composer-messages-container');
      if (!container.length) {
        return res.json({ ok: true, html: '', styles, stylesHash, empty: true });
      }

      const rewriteAttrUrl = makeAttrRewriter(pageUrl, proxyBase);
      container.find('[src], [href]').each((_, el) => {
        for (const attr of ['src', 'href']) {
          const raw = $(el).attr(attr);
          if (!raw) continue;
          const r = rewriteAttrUrl(raw);
          if (r) $(el).attr(attr, r);
        }
      });
      container.find('script').remove();
      container.find('[onclick],[onload],[onerror],[onmouseover]').each((_, el) => {
        $(el).removeAttr('onclick').removeAttr('onload').removeAttr('onerror').removeAttr('onmouseover');
      });

      // Only strip overflow:hidden + height from Monaco scroll containers,
      // NOT from content elements like code blocks, tool calls, etc.
      container.find('.monaco-scrollable-element').each((_, el) => {
        let style = $(el).attr('style') || '';
        style = style
          .replace(/overflow\s*:\s*hidden\s*;?/g, '')
          .replace(/height\s*:\s*\d+(\.\d+)?px\s*;?/g, '');
        $(el).attr('style', style.trim() || null);
        // Also fix the direct child div (the actual scroll viewport)
        $(el).children('div').each((_, child) => {
          let cs = $(child).attr('style') || '';
          cs = cs
            .replace(/overflow\s*:\s*hidden\s*;?/g, '')
            .replace(/height\s*:\s*\d+(\.\d+)?px\s*;?/g, '');
          $(child).attr('style', cs.trim() || null);
        });
      });
      // Remove Monaco custom scrollbar UI (not content)
      container.find('.monaco-scrollable-element > .scrollbar').remove();

      const html = container.html() || '';
      const result = { ok: true, html, stylesHash, themeInfo, composerStatus };
      if (styles !== null) result.styles = styles;
      console.log('[chat-content] tab=%d html=%dKB styles=%s', tab,
        (html.length / 1024) | 0, styles ? ((styles.length / 1024) | 0) + 'KB' : 'cached');
      res.json(result);
    } catch (e) {
      console.log('[chat-content] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------------------------------------------------------------------------
  // File View API — file tree + editor content extraction
  // ---------------------------------------------------------------------------

  const sidebarSnapshotCache = new Map();
  const SIDEBAR_SNAPSHOT_TTL = 3000;

  function getSidebarSnapshotKey(host, port, targetId) {
    return `${makeWatcherKey(host, port)}:sidebar:${targetId || 'first'}`;
  }

  function clearSidebarSnapshotCache(host, port, targetId) {
    const prefix = `${makeWatcherKey(host, port)}:sidebar:`;
    if (targetId) {
      sidebarSnapshotCache.delete(getSidebarSnapshotKey(host, port, targetId));
      return;
    }
    for (const key of sidebarSnapshotCache.keys()) {
      if (key.startsWith(prefix)) sidebarSnapshotCache.delete(key);
    }
  }

  function buildSidebarResponsePayload(data, { needStyles, clientHash }) {
    const result = {
      ok: true,
      html: data.html,
      materialized: !!data.materialized,
      snapshotId: data.snapshotId || '',
      itemCount: data.itemCount || 0,
      scanMeta: data.scanMeta || null,
      stylesHash: data.stylesHash || '',
      themeInfo: data.themeInfo || null,
    };
    if (data.styles != null && (needStyles || !clientHash || clientHash !== data.stylesHash)) {
      result.styles = data.styles;
    }
    return result;
  }

  async function getSidebarViewAssets(state, targetId, { needStyles, clientHash }) {
    const resMap = await ensureResMap(state, targetId || undefined);
    const proxyBase = '/api/vscode-file';

    let styles = null;
    let stylesHash = null;
    const now = Date.now();
    if (needStyles || !clientHash || (chatStylesCache.hash && clientHash !== chatStylesCache.hash)) {
      if (chatStylesCache.styles && (now - chatStylesCache.at) < CHAT_STYLES_TTL && !needStyles) {
        styles = chatStylesCache.styles;
        stylesHash = chatStylesCache.hash;
      } else {
        const extracted = await extractPageStyles(state.page, state.client, {
          proxyBase, cssCache: liveState.cssCache, cssTtl: CSS_TTL, resMap,
        });
        styles = extracted.styles;
        stylesHash = extracted.stylesHash;
        chatStylesCache.styles = styles;
        chatStylesCache.hash = stylesHash;
        chatStylesCache.at = now;
      }
    } else {
      stylesHash = chatStylesCache.hash || clientHash;
    }

    const themeInfo = await state.page.evaluate(() => ({
      htmlClass: document.documentElement.className || '',
      bodyClass: document.body?.className || '',
      htmlStyle: document.documentElement.getAttribute('style') || '',
      bodyStyle: document.body?.getAttribute('style') || '',
      wbStyle: document.querySelector('.monaco-workbench')?.getAttribute('style') || '',
    }));

    return { styles, stylesHash, themeInfo, proxyBase };
  }

  function buildMaterializedSidebarHtml(items) {
    const rows = [];
    for (const item of items) {
      const $ = cheerio.load(item.html || '', { decodeEntities: false });
      const row = $('.monaco-list-row').first();
      if (!row.length) continue;
      row.removeAttr('id').removeAttr('data-index').removeAttr('data-last-element').removeAttr('data-parity');
      row.attr('data-materialized-path', item.fullPath || '');
      row.attr('data-materialized-kind', item.isDirectory ? 'directory' : 'file');
      row.attr('data-materialized-virtual-top', String(item.virtualTop || 0));
      row.attr('data-materialized-level', String(item.level || 0));
      if (item.expanded == null) row.removeAttr('data-materialized-expanded');
      else row.attr('data-materialized-expanded', String(item.expanded));
      row.attr('style', `height: ${Math.round(item.height || 22)}px; line-height: ${Math.round(item.lineHeight || item.height || 22)}px;`);
      rows.push($.html(row));
    }
    return `<div class="cursor-auto-materialized-tree">${rows.join('')}</div>`;
  }

  async function getMaterializedSidebarSnapshot({ host, port, targetId, needStyles, clientHash, force }) {
    const key = getSidebarSnapshotKey(host, port, targetId);
    const cached = sidebarSnapshotCache.get(key);
    if (!force && cached?.data && (Date.now() - cached.data.createdAt) < SIDEBAR_SNAPSHOT_TTL) {
      return buildSidebarResponsePayload(cached.data, { needStyles, clientHash });
    }
    if (!force && cached?.promise) {
      const data = await cached.promise;
      return buildSidebarResponsePayload(data, { needStyles, clientHash });
    }

    const promise = (async () => {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });
      const assets = await getSidebarViewAssets(state, targetId, { needStyles, clientHash });
      const scan = await scanMaterializedSidebar(state.page);
      if (!scan.ok) {
        const error = new Error(scan.error || 'sidebar materialize failed');
        error.scanMeta = scan.meta;
        throw error;
      }
      const data = {
        createdAt: Date.now(),
        materialized: true,
        html: buildMaterializedSidebarHtml(scan.items),
        itemCount: scan.items.length,
        snapshotId: scan.snapshotId,
        scanMeta: scan.meta,
        styles: assets.styles,
        stylesHash: assets.stylesHash,
        themeInfo: assets.themeInfo,
      };
      sidebarSnapshotCache.set(key, { data });
      return data;
    })();

    sidebarSnapshotCache.set(key, { promise });
    try {
      const data = await promise;
      return buildSidebarResponsePayload(data, { needStyles, clientHash });
    } finally {
      const current = sidebarSnapshotCache.get(key);
      if (current?.promise === promise && !current.data) {
        sidebarSnapshotCache.delete(key);
      }
    }
  }

  // GET /api/sidebar-materialized — scan virtualized Explorer and return a full static tree snapshot
  app.get('/api/sidebar-materialized', async (req, res) => {
    const host = String(req.query.host || '127.0.0.1');
    const port = Number(req.query.port || 9292);
    const targetId = req.query.targetId || '';
    const needStyles = req.query.needStyles === '1';
    const clientHash = String(req.query.stylesHash || '');
    const force = req.query.force === '1';

    try {
      const result = await getMaterializedSidebarSnapshot({
        host,
        port,
        targetId,
        needStyles,
        clientHash,
        force,
      });
      console.log('[sidebar-materialized] items=%d styles=%s restored=%s',
        result.itemCount || 0,
        result.styles ? ((result.styles.length / 1024) | 0) + 'KB' : 'cached',
        result.scanMeta?.restored);
      res.json(result);
    } catch (e) {
      console.log('[sidebar-materialized] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e), scanMeta: e?.scanMeta || null });
    }
  });

  // GET /api/sidebar-content — extract sidebar DOM as styled HTML (icons, colors, git status)
  app.get('/api/sidebar-content', async (req, res) => {
    const host = String(req.query.host || '127.0.0.1');
    const port = Number(req.query.port || 9292);
    const targetId = req.query.targetId || '';
    const needStyles = req.query.needStyles === '1';
    const clientHash = String(req.query.stylesHash || '');

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });
      const resMap = await ensureResMap(state, targetId || undefined);
      const { styles, stylesHash, themeInfo, proxyBase } = await getSidebarViewAssets(state, targetId, {
        needStyles,
        clientHash,
      });

      const pageUrl = state.page.url();
      const dom = await state.page.content();
      const $ = cheerio.load(dom, { decodeEntities: false });

      const sidebar = $('#workbench\\.parts\\.sidebar');
      let html = '';
      if (sidebar.length) {
        const rewriteAttrUrl = makeAttrRewriter(pageUrl, proxyBase);
        sidebar.find('[src], [href]').each((_, el) => {
          for (const attr of ['src', 'href']) {
            const raw = $(el).attr(attr);
            if (!raw) continue;
            const r = rewriteAttrUrl(raw);
            if (r) $(el).attr(attr, r);
          }
        });
        sidebar.find('script').remove();
        sidebar.find('.monaco-scrollable-element > .scrollbar').remove();
        sidebar.find('.monaco-scrollable-element').each((_, el) => {
          let style = $(el).attr('style') || '';
          style = style.replace(/overflow\s*:\s*hidden\s*;?/g, '');
          $(el).attr('style', style.trim() || null);
          $(el).children('div').each((_, child) => {
            let cs = $(child).attr('style') || '';
            cs = cs.replace(/overflow\s*:\s*hidden\s*;?/g, '');
            $(child).attr('style', cs.trim() || null);
          });
        });
        html = sidebar.html() || '';
      }

      const result = { ok: true, html, stylesHash, themeInfo };
      if (styles !== null) result.styles = styles;
      console.log('[sidebar-content] html=%dKB styles=%s', (html.length / 1024) | 0,
        styles ? ((styles.length / 1024) | 0) + 'KB' : 'cached');
      res.json(result);
    } catch (e) {
      console.log('[sidebar-content] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // GET /api/file-tree — list workspace files via filesystem (not virtual list)
  const workspaceRootCache = new Map(); // projectName -> fsPath
  let wsStorageScanned = false;

  function scanWorkspaceStorage() {
    const wsDir = path.join(process.env.APPDATA || '', 'Cursor', 'User', 'workspaceStorage');
    if (!fs.existsSync(wsDir)) return;
    try {
      for (const d of fs.readdirSync(wsDir)) {
        const wsFile = path.join(wsDir, d, 'workspace.json');
        if (!fs.existsSync(wsFile)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
          const folderUri = data.folder || '';
          if (!folderUri.startsWith('file:///')) continue;
          const decoded = decodeURIComponent(folderUri.replace('file:///', '')).replace(/\//g, path.sep);
          const normalized = /^[a-zA-Z]:/.test(decoded) ? decoded[0].toUpperCase() + decoded.slice(1) : decoded;
          if (!fs.existsSync(normalized)) continue;
          const projectName = path.basename(normalized);
          workspaceRootCache.set(projectName.toLowerCase(), normalized);
        } catch {}
      }
    } catch {}
    wsStorageScanned = true;
  }

  async function resolveWorkspaceRoot(state, targetId) {
    if (!wsStorageScanned) scanWorkspaceStorage();

    const project = await state.page.evaluate(() => {
      return document.querySelector('.sidebar .title')?.textContent?.trim() || '';
    });
    if (!project) return null;

    const cached = workspaceRootCache.get(project.toLowerCase());
    if (cached) return cached;

    // Fallback: try data-resource-uri
    const root = await state.page.evaluate((proj) => {
      const el = document.querySelector('[data-resource-uri]');
      if (!el) return null;
      const uri = el.getAttribute('data-resource-uri') || '';
      if (!uri.startsWith('file:///')) return null;
      try {
        const decoded = decodeURIComponent(uri.replace('file:///', '')).replace(/\//g, '\\');
        const idx = decoded.toLowerCase().indexOf(proj.toLowerCase());
        if (idx >= 0) return decoded.substring(0, idx + proj.length);
        return null;
      } catch { return null; }
    }, project);

    if (root) workspaceRootCache.set(project.toLowerCase(), root);
    return root;
  }

  async function openFullPathInEditor(state, wsRoot, fullPath) {
    const resolvedFullPath = path.resolve(fullPath);
    if (!isWithinRoot(wsRoot, resolvedFullPath)) {
      return { ok: false, status: 403, error: 'forbidden' };
    }
    if (!fs.existsSync(resolvedFullPath) || !fs.statSync(resolvedFullPath).isFile()) {
      return { ok: false, status: 404, error: 'file not found' };
    }

    const fileUri = 'file:///' + resolvedFullPath.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (_, d) => d.toLowerCase() + '%3A');
    await state.page.evaluate((uri) => {
      try {
        const event = new CustomEvent('vscode-open-file', { detail: { uri } });
        window.dispatchEvent(event);
      } catch {}
    }, fileUri).catch(() => {});

    await state.client.send('Runtime.evaluate', {
      expression: `(async () => {
        const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
        if (vscode) {
          vscode.postMessage({ command: 'vscode.open', args: [${JSON.stringify(fileUri)}] });
          return 'sent';
        }
        return 'no-api';
      })()`,
      awaitPromise: true,
    }).catch(() => {});

    const quickOpenText = path.relative(wsRoot, resolvedFullPath).replace(/\\/g, '/') || path.basename(resolvedFullPath);
    await state.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'p', code: 'KeyP', modifiers: 2, windowsVirtualKeyCode: 80 });
    await state.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', modifiers: 2, windowsVirtualKeyCode: 80 });
    await sleep(500);
    await state.client.send('Input.insertText', { text: quickOpenText });
    await sleep(500);
    await state.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await state.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });

    return {
      ok: true,
      file: quickOpenText,
      fullPath: resolvedFullPath,
    };
  }

  app.get('/api/file-tree', async (req, res) => {
    const host = String(req.query.host || '127.0.0.1');
    const port = Number(req.query.port || 9292);
    const targetId = req.query.targetId || '';
    const maxDepth = Number(req.query.maxDepth || 5);
    const subPath = req.query.path || '';

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });
      const wsRoot = await resolveWorkspaceRoot(state, targetId);
      if (!wsRoot) return res.json({ ok: false, error: 'workspace root not found' });

      const basePath = subPath ? path.resolve(wsRoot, subPath) : path.resolve(wsRoot);
      if (!isWithinRoot(wsRoot, basePath)) return res.status(403).json({ ok: false, error: 'forbidden' });
      if (!fs.existsSync(basePath)) return res.json({ ok: false, error: 'path not found' });

      const rows = [];
      const SKIP = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', '.cache', '.cursor']);

      function walk(dir, level, relPrefix) {
        if (level > maxDepth) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        for (const e of entries) {
          if (e.name.startsWith('.') && level === 1 && SKIP.has(e.name)) continue;
          if (SKIP.has(e.name)) continue;
          const rel = relPrefix ? relPrefix + '/' + e.name : e.name;
          const isDir = e.isDirectory();
          rows.push({ label: e.name, path: rel, level, isDir });
        }
      }

      walk(basePath, 1, '');
      res.json({ ok: true, rows, count: rows.length, wsRoot, basePath });
    } catch (e) {
      console.log('[file-tree] error:', e.message);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // POST /api/file-tree/click — click a file tree row by index (open file or toggle dir)
  app.post('/api/file-tree/click', async (req, res) => {
    const { host = '127.0.0.1', port = 9292, targetId = '', index, doubleClick = false } = req.body || {};
    if (index == null || index < 0) {
      return res.status(400).json({ ok: false, error: 'index is required (>= 0)' });
    }

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });
      const rowInfo = await state.page.evaluate((idx) => {
        const explorer = document.querySelector('.explorer-folders-view');
        if (!explorer) return { ok: false, reason: 'explorer not visible' };
        const rows = explorer.querySelectorAll('.monaco-list-row');
        if (idx >= rows.length) return { ok: false, reason: 'out_of_range', total: rows.length };
        const row = rows[idx];
        row.scrollIntoView({ block: 'center' });
        const rect = row.getBoundingClientRect();
        return {
          ok: true,
          label: (row.getAttribute('aria-label') || '').trim(),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      }, Number(index));
      if (!rowInfo.ok) return res.json(rowInfo);
      await state.page.mouse.click(rowInfo.x, rowInfo.y, {
        button: 'left',
        clickCount: doubleClick ? 2 : 1,
        delay: doubleClick ? 50 : 0,
      });
      clearSidebarSnapshotCache(host, port, targetId);
      res.json({ ok: true, label: rowInfo.label, doubleClick: !!doubleClick });
    } catch (e) {
      console.log('[file-tree/click] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // POST /api/file-open — open a file in Cursor's editor by workspace-relative path
  app.post('/api/file-open', async (req, res) => {
    const { host = '127.0.0.1', port = 9292, targetId = '', path: filePath } = req.body || {};
    if (!filePath) return res.status(400).json({ ok: false, error: 'path is required' });

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });
      const wsRoot = await resolveWorkspaceRoot(state, targetId);
      if (!wsRoot) return res.json({ ok: false, error: 'workspace root not found' });

      const fullPath = path.resolve(wsRoot, filePath);
      const result = await openFullPathInEditor(state, wsRoot, fullPath);
      if (!result.ok) return res.status(result.status || 400).json(result);
      res.json(result);
    } catch (e) {
      console.log('[file-open] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // POST /api/sidebar-item/activate — activate a materialized tree item by path
  app.post('/api/sidebar-item/activate', async (req, res) => {
    const {
      host = '127.0.0.1',
      port = 9292,
      targetId = '',
      fullPath = '',
      kind = '',
      virtualTop = 0,
      doubleClick = false,
    } = req.body || {};

    if (!fullPath) {
      return res.status(400).json({ ok: false, error: 'fullPath is required' });
    }

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });
      const wsRoot = await resolveWorkspaceRoot(state, targetId);
      if (!wsRoot) return res.json({ ok: false, error: 'workspace root not found' });

      if (kind === 'file' || doubleClick) {
        const result = await openFullPathInEditor(state, wsRoot, fullPath);
        if (!result.ok) return res.status(result.status || 400).json(result);
        clearSidebarSnapshotCache(host, port, targetId);
        return res.json({ ...result, activated: true });
      }

      const cacheEntry = sidebarSnapshotCache.get(getSidebarSnapshotKey(host, port, targetId));
      const reveal = await revealSidebarPath(state.page, fullPath, cacheEntry?.data?.scanMeta || {}, { virtualTop });
      if (!reveal.ok || !reveal.point) {
        return res.status(404).json({ ok: false, error: 'sidebar item not found' });
      }

      await state.page.mouse.click(reveal.point.x, reveal.point.y, {
        button: 'left',
        clickCount: 1,
      });
      clearSidebarSnapshotCache(host, port, targetId);
      res.json({ ok: true, activated: true, fullPath, kind: kind || 'directory' });
    } catch (e) {
      console.log('[sidebar-item/activate] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // GET /api/editor-tabs — list open editor tabs per group
  app.get('/api/editor-tabs', async (req, res) => {
    const host = String(req.query.host || '127.0.0.1');
    const port = Number(req.query.port || 9292);
    const targetId = req.query.targetId || '';

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });
      const result = await state.page.evaluate(() => {
        const editorPart = document.querySelector('.part.editor');
        if (!editorPart) return { ok: true, groups: [] };
        const groups = editorPart.querySelectorAll('.editor-group-container');
        return {
          ok: true,
          groups: Array.from(groups).map((g, gi) => {
            const tabs = g.querySelectorAll('.tabs-container [role="tab"]');
            return {
              index: gi,
              tabs: Array.from(tabs).map((t, ti) => ({
                index: ti,
                label: (t.getAttribute('aria-label') || t.textContent || '').trim().substring(0, 80),
                selected: t.getAttribute('aria-selected') === 'true',
              })),
            };
          }),
        };
      });
      res.json(result);
    } catch (e) {
      console.log('[editor-tabs] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // POST /api/editor-tab/click — click an editor tab to switch to it
  app.post('/api/editor-tab/click', async (req, res) => {
    const { host = '127.0.0.1', port = 9292, targetId = '', group = 0, tabIndex } = req.body || {};
    if (tabIndex == null || tabIndex < 0) {
      return res.status(400).json({ ok: false, error: 'tabIndex is required' });
    }

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });
      const coords = await state.page.evaluate(({ gi, ti }) => {
        const editorPart = document.querySelector('.part.editor');
        if (!editorPart) return { ok: false, reason: 'no editor' };
        const groups = editorPart.querySelectorAll('.editor-group-container');
        if (gi >= groups.length) return { ok: false, reason: 'group out of range' };
        const tabs = groups[gi].querySelectorAll('.tabs-container [role="tab"]');
        if (ti >= tabs.length) return { ok: false, reason: 'tab out of range' };
        const tab = tabs[ti];
        tab.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = tab.getBoundingClientRect();
        return {
          ok: true,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          label: (tab.getAttribute('aria-label') || '').trim().substring(0, 80),
        };
      }, { gi: Number(group), ti: Number(tabIndex) });
      if (!coords.ok) return res.json(coords);
      await state.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
      await state.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
      res.json({ ok: true, label: coords.label });
    } catch (e) {
      console.log('[editor-tab/click] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // POST /api/editor-tab/close — close an editor tab by clicking its close button
  app.post('/api/editor-tab/close', async (req, res) => {
    const { host = '127.0.0.1', port = 9292, targetId = '', group = 0, tabIndex } = req.body || {};
    if (tabIndex == null || tabIndex < 0) {
      return res.status(400).json({ ok: false, error: 'tabIndex is required' });
    }
    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });
      const result = await state.page.evaluate(({ gi, ti }) => {
        const editorPart = document.querySelector('.part.editor');
        if (!editorPart) return { ok: false, reason: 'no editor' };
        const groups = editorPart.querySelectorAll('.editor-group-container');
        if (gi >= groups.length) return { ok: false, reason: 'group out of range' };
        const tabs = groups[gi].querySelectorAll('.tabs-container [role="tab"]');
        if (ti >= tabs.length) return { ok: false, reason: 'tab out of range' };
        const closeBtn = tabs[ti].querySelector('.codicon-close, [aria-label="Close"]');
        if (!closeBtn) {
          tabs[ti].dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
          return { ok: true, method: 'middle-click', label: (tabs[ti].getAttribute('aria-label') || '').trim() };
        }
        closeBtn.click();
        return { ok: true, label: (tabs[ti].getAttribute('aria-label') || '').trim() };
      }, { gi: Number(group), ti: Number(tabIndex) });
      res.json(result);
    } catch (e) {
      console.log('[editor-tab/close] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // GET /api/editor-content — read file text from filesystem (Monaco DOM is virtual, can't extract)
  app.get('/api/editor-content', async (req, res) => {
    const host = String(req.query.host || '127.0.0.1');
    const port = Number(req.query.port || 9292);
    const targetId = req.query.targetId || '';
    const groupIdx = Number(req.query.group ?? 0);

    try {
      const state = await getLiveCDP(host, port, { targetId: targetId || undefined, timeout: 10000 });
      const wsRoot = await resolveWorkspaceRoot(state, targetId);

      // Get active tab info from Cursor DOM
      const info = await state.page.evaluate((gi) => {
        const editorPart = document.querySelector('.part.editor');
        if (!editorPart) return { activeTab: '', filePath: '' };
        const groups = editorPart.querySelectorAll('.editor-group-container');
        const group = groups[gi] || groups[0];
        if (!group) return { activeTab: '', filePath: '' };

        const activeTabEl = group.querySelector('.tabs-container [role="tab"][aria-selected="true"]');
        const activeTab = (activeTabEl?.getAttribute('aria-label') || '').trim()
          .replace(/, Editor Group \d+$/, '').replace(/, preview$/, '');

        // Try to get file URI from the tab or editor
        const resourceEl = group.querySelector('[data-resource-uri]');
        let filePath = '';
        if (resourceEl) {
          const uri = resourceEl.getAttribute('data-resource-uri') || '';
          if (uri.startsWith('file:///')) {
            filePath = decodeURIComponent(uri.replace('file:///', '')).replace(/\//g, '\\');
          }
        }
        return { activeTab, filePath, groupCount: groups.length };
      }, groupIdx);

      let text = '';
      let totalLines = 0;
      let language = '';
      let filePath = info.filePath || '';

      // Try reading from filesystem — search workspace for the file
      if (!filePath && wsRoot && info.activeTab) {
        const fileName = info.activeTab;
        // Quick check common locations first
        const homeDir = process.env.USERPROFILE || process.env.HOME || '';
        const quickPaths = [
          path.join(wsRoot, fileName),
          path.join(wsRoot, 'src', fileName),
          path.join(wsRoot, 'public', fileName),
          path.join(wsRoot, 'lib', fileName),
          path.join(wsRoot, '.cursor', 'plans', fileName),
          path.join(homeDir, '.cursor', 'plans', fileName),
          path.join(homeDir, '.cursor', 'projects', fileName),
        ];
        for (const p of quickPaths) {
          if (fs.existsSync(p)) { filePath = p; break; }
        }
        // Fallback: recursive search (max 3 levels)
        if (!filePath) {
          const findFile = (dir, name, depth) => {
            if (depth <= 0) return null;
            try {
              for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name === name && !e.isDirectory()) return path.join(dir, name);
                if (e.isDirectory() && !['node_modules', '.git'].includes(e.name)) {
                  const r = findFile(path.join(dir, e.name), name, depth - 1);
                  if (r) return r;
                }
              }
            } catch {}
            return null;
          };
          filePath = findFile(wsRoot, fileName, 5) || '';
        }
      }

      const ext = path.extname(info.activeTab || filePath || '').toLowerCase();
      const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico']);
      let isImage = IMAGE_EXTS.has(ext);
      let imageUrl = '';

      if (filePath && fs.existsSync(filePath)) {
        if (isImage) {
          const fileData = fs.readFileSync(filePath);
          const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
            '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon' };
          const mimeType = mimeMap[ext] || 'application/octet-stream';
          imageUrl = 'data:' + mimeType + ';base64,' + fileData.toString('base64');
        } else {
          try {
            const stat = fs.statSync(filePath);
            if (stat.size < 2 * 1024 * 1024) {
              text = fs.readFileSync(filePath, 'utf8');
              totalLines = text.split('\n').length;
            } else {
              text = '(File too large: ' + (stat.size / 1024 / 1024).toFixed(1) + 'MB)';
            }
          } catch (e) {
            text = '(Cannot read file: ' + e.message + ')';
          }
        }
      }
      const langMap = { '.js': 'javascript', '.ts': 'typescript', '.py': 'python', '.html': 'html',
        '.css': 'css', '.json': 'json', '.md': 'markdown', '.sh': 'shell', '.ps1': 'powershell',
        '.yaml': 'yaml', '.yml': 'yaml', '.xml': 'xml', '.sql': 'sql', '.rs': 'rust', '.go': 'go',
        '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.rb': 'ruby', '.dart': 'dart' };
      language = langMap[ext] || ext.replace('.', '') || 'text';

      console.log('[editor-content] tab=%s lines=%d lang=%s image=%s', info.activeTab, totalLines, language, isImage);
      const result = {
        ok: true, text, totalLines, language, isImage,
        activeTab: info.activeTab, groupCount: info.groupCount || 1,
        filePath: filePath ? path.basename(filePath) : '',
      };
      if (imageUrl) result.imageUrl = imageUrl;
      res.json(result);
    } catch (e) {
      console.log('[editor-content] error:', e.message);
      resetLiveCDP();
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---------------------------------------------------------------------------
  // Window resize API (calls resize_window.js subprocess)
  // ---------------------------------------------------------------------------
  const resizeScript = path.join(__dirname, 'resize_window.js');

  app.get('/api/resize/info', async (req, res) => {
    const host = String(req.query.host || '127.0.0.1');
    const port = Number(req.query.port || 9292);
    const r = await runNode(resizeScript, ['--host', host, '--port', String(port), '--info', '--verbose']);
    const parsed = parseTrailingJson(r.out);
    if (parsed) {
      res.json(parsed);
    } else {
      res.status(500).json({ ok: false, code: r.code, stdout: r.out, stderr: r.err });
    }
  });

  app.post('/api/resize', async (req, res) => {
    const { host='127.0.0.1', port=9292, width, height, maximize } = req.body || {};
    const args = ['--host', String(host), '--port', String(port), '--verbose'];
    if (maximize) {
      args.push('--maximize');
    } else {
      if (width != null) args.push('-w', String(Math.round(width)));
      if (height != null) args.push('-h', String(Math.round(height)));
    }
    const r = await runNode(resizeScript, args);
    const parsed = parseTrailingJson(r.out);
    if (parsed) {
      res.json(parsed);
    } else {
      res.status(500).json({ ok: false, code: r.code, stdout: r.out, stderr: r.err });
    }
  });

  // GET /api/vscode-file/* — proxy Electron internal vscode-file://vscode-app/ resources
  app.get('/api/vscode-file/*filePath', async (req, res) => {
    const defaultHost = '127.0.0.1';
    const defaultPort = 9292;

    let appRoot;
    try {
      appRoot = await resolveAppRoot(defaultHost, defaultPort);
    } catch (e) {
      return res.status(503).json({ ok: false, error: 'appRoot unavailable: ' + String(e?.message || e) });
    }

    // Safely resolve the requested file path
    // In Express 5 the *name wildcard param may be an array — use req.path instead
    let rawPath = req.path.replace(/^\/api\/vscode-file\//, '');
    // Be resilient to accidental double-proxy paths like /api/vscode-file/api/vscode-file/...
    while (rawPath.startsWith('api/vscode-file/')) rawPath = rawPath.slice('api/vscode-file/'.length);

    const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
    const segments = rawPath
      .split('/')
      .filter(s => s.length > 0)
      .map(safeDecode)
      .filter(s => s !== '..');

    let filePath;
    // Support absolute Windows paths encoded in vscode-file:// URLs, e.g.:
    //   /api/vscode-file/c:/Program%20Files/cursor/resources/app/out/media/codicon.ttf
    // We still enforce that the resolved file must stay within appRoot.
    if (segments.length > 0 && /^[a-zA-Z]:$/.test(segments[0])) {
      filePath = path.win32.join(segments[0] + '\\', ...segments.slice(1));
    } else {
      filePath = path.join(appRoot, ...segments);
    }

    // Security: allow appRoot and Cursor extensions directory
    const resolvedAppRoot = path.resolve(appRoot);
    const resolvedFile = path.resolve(filePath);
    const norm = (p) => process.platform === 'win32' ? String(p).toLowerCase() : String(p);
    const fileNorm = norm(resolvedFile);

    const allowedRoots = [resolvedAppRoot];
    const cursorExtDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.cursor', 'extensions');
    if (fs.existsSync(cursorExtDir)) allowedRoots.push(path.resolve(cursorExtDir));
    // Also allow common Cursor install paths (resolveAppRoot may return VS Code path instead)
    for (const candidate of [
      path.join(process.env.ProgramFiles || '', 'cursor', 'resources', 'app'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'cursor', 'resources', 'app'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor', 'resources', 'app'),
    ]) {
      if (candidate && fs.existsSync(candidate) && !allowedRoots.includes(path.resolve(candidate))) {
        allowedRoots.push(path.resolve(candidate));
      }
    }

    const allowed = allowedRoots.some(root => {
      const rootNorm = norm(path.resolve(root));
      return fileNorm.startsWith(rootNorm + path.sep) || fileNorm === rootNorm;
    });
    if (!allowed) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    if (!fs.existsSync(resolvedFile)) {
      return res.status(404).json({ ok: false, error: 'not found' });
    }

    const mimeType = mime.lookup(resolvedFile) || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // Use stream to avoid sendFile path resolution issues on Windows
    const fileStream = fs.createReadStream(resolvedFile);
    fileStream.on('error', () => { if (!res.headersSent) res.status(404).end(); });
    fileStream.pipe(res);
  });

  const port = Number(process.env.PORT || 5123);
  const host = process.env.BIND || '0.0.0.0';

  await new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`cursor_auto server: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
      if (requireAuth) console.log('Auth enabled: provide header x-token or ?token=...');
      console.log('Static captures served at /captures/<timestamp>/index.html');
      console.log('Press Ctrl+C to stop.');
    });

    server.on('error', reject);

    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) {
        console.log('Force exit.');
        process.exit(0);
      }
      shuttingDown = true;
      console.log('\nShutting down server...');
      stopAllWatchers();
      resetLiveCDP();
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      server.close(() => {
        console.log('Server stopped.');
        resolve();
      });
      setTimeout(() => { console.log('Timeout, force exit.'); process.exit(0); }, 3000).unref();
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
