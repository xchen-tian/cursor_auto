#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const express = require('express');
const { spawn } = require('child_process');
const mime = require('mime-types');
const { connectOverCDP, findPageWithSelector } = require('./cdp');
const { renderLive, buildResMap } = require('./live_render');

// Node >= 18 provides global fetch.

function tailLines(s, maxLines = 200) {
  const lines = String(s || '').split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
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

  const token = process.env.CURSOR_AUTO_TOKEN || '';
  const requireAuth = !!token;

  app.use((req, res, next) => {
    if (!requireAuth) return next();
    const t = req.get('x-token') || req.query.token || '';
    if (t !== token) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
  });

  const publicDir = path.join(__dirname, '..', 'public');
  app.use('/', express.static(publicDir));

  const captureBase = path.join(__dirname, '..', 'dist', 'capture');
  app.use('/captures', express.static(captureBase));

  // A single long-running watcher process (auto-click loop)
  /** @type {{ child: import('child_process').ChildProcess | null, startedAt: number|null, params: any, out: string, err: string }} */
  const watcher = { child: null, startedAt: null, params: null, out: '', err: '' };

  function stopWatcher() {
    if (!watcher.child) return { ok: true, stopped: false };
    try { watcher.child.kill('SIGTERM'); } catch {}
    watcher.child = null;
    watcher.startedAt = null;
    watcher.params = null;
    return { ok: true, stopped: true };
  }

  app.post('/api/click', async (req, res) => {
    const { host='127.0.0.1', port=9222, selector='.composer-run-button', contains='Fetch', requireReady=true } = req.body || {};

    const probe = await probeCDP(host, port);
    if (!probe.ok) {
      return res.status(400).json({
        ok: false,
        error: 'cdp_unreachable',
        detail: probe,
        hint: 'Start Cursor/VS Code with --remote-debugging-port=9222, then retry.'
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

  // Start long-running auto-click loop (one watcher at a time)
  app.post('/api/click/start', async (req, res) => {
    const { host='127.0.0.1', port=9222, selector='.composer-run-button', contains='Fetch', requireReady=true, interval=300 } = req.body || {};
    if (watcher.child) {
      return res.status(409).json({ ok: false, error: 'watcher_already_running', startedAt: watcher.startedAt, params: watcher.params });
    }

    const probe = await probeCDP(host, port);
    if (!probe.ok) {
      return res.status(400).json({
        ok: false,
        error: 'cdp_unreachable',
        detail: probe,
        hint: 'Start Cursor/VS Code with --remote-debugging-port=9222, then retry.'
      });
    }

    const script = path.join(__dirname, 'auto_click.js');
    const args = [
      '--host', String(host),
      '--port', String(port),
      '--selector', selector,
      '--interval', String(interval),
      '--verbose'
    ];
    if (contains) args.push('--contains', contains);
    if (!requireReady) args.push('--require-ready=false');

    const child = spawnNodeLong(script, args);
    watcher.child = child;
    watcher.startedAt = Date.now();
    watcher.params = { host, port, selector, contains, requireReady, interval };
    watcher.out = '';
    watcher.err = '';
    child.stdout.on('data', (d) => watcher.out += d.toString());
    child.stderr.on('data', (d) => watcher.err += d.toString());
    child.on('exit', () => {
      watcher.child = null;
      watcher.startedAt = null;
      watcher.params = null;
    });
    res.json({ ok: true, startedAt: watcher.startedAt, params: watcher.params });
  });

  app.post('/api/click/stop', (req, res) => {
    res.json(stopWatcher());
  });

  app.get('/api/click/status', (req, res) => {
    res.json({
      ok: true,
      running: !!watcher.child,
      startedAt: watcher.startedAt,
      params: watcher.params,
      stdoutTail: tailLines(watcher.out, 200),
      stderrTail: tailLines(watcher.err, 200),
    });
  });

  app.post('/api/capture', async (req, res) => {
    const { host='127.0.0.1', port=9222, selector='.monaco-workbench', contains='' } = req.body || {};

    const probe = await probeCDP(host, port);
    if (!probe.ok) {
      return res.status(400).json({
        ok: false,
        error: 'cdp_unreachable',
        detail: probe,
        hint: 'Start Cursor/VS Code with --remote-debugging-port=9222, then retry.'
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
    const port = Number(req.query.port || 9222);
    const probe = await probeCDP(host, port);
    const latest = latestCaptureDir(captureBase);
    const rel = latest ? path.relative(captureBase, latest).replace(/\\/g, '/') : null;
    res.json({
      ok: true,
      cdp: probe,
      watcherRunning: !!watcher.child,
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
    browser: null, context: null, page: null, client: null,
    resMap: null, resMapAt: 0,
    cssCache: new Map(),
    connecting: null,
  };
  const RES_MAP_TTL = 60 * 1000;
  const CSS_TTL = 5 * 60 * 1000;

  function resetLiveCDP() {
    try { liveState.browser?.close(); } catch {}
    liveState.browser = null;
    liveState.context = null;
    liveState.page = null;
    liveState.client = null;
    liveState.resMap = null;
    liveState.resMapAt = 0;
    liveState.connecting = null;
  }

  async function getLiveCDP(host, port, selector, timeout) {
    if (liveState.connecting) {
      await liveState.connecting;
      if (liveState.page) return liveState;
    }

    if (liveState.page) {
      try {
        await liveState.page.title();
        return liveState;
      } catch {
        resetLiveCDP();
      }
    }

    liveState.connecting = (async () => {
      try {
        const { browser, context } = await connectOverCDP({ host, port });
        const page = await findPageWithSelector(context, {
          selector, timeoutMs: timeout || 15000,
        });
        if (!page) throw new Error('Workbench page not found');
        const client = await context.newCDPSession(page);
        await client.send('Page.enable');

        liveState.browser = browser;
        liveState.context = context;
        liveState.page = page;
        liveState.client = client;
        liveState.resMap = null;
        liveState.resMapAt = 0;
      } finally {
        liveState.connecting = null;
      }
    })();
    await liveState.connecting;
    return liveState;
  }

  async function ensureResMap(state) {
    const now = Date.now();
    if (state.resMap && (now - state.resMapAt) < RES_MAP_TTL) return state.resMap;
    const tree = await state.client.send('Page.getResourceTree');
    state.resMap = buildResMap(tree);
    state.resMapAt = now;
    return state.resMap;
  }

  // GET /api/live — render live snapshot in-process (persistent CDP, cached CSS)
  app.get('/api/live', async (req, res) => {
    const host = String(req.query.host || '127.0.0.1');
    const port = Number(req.query.port || 9222);
    const selector = String(req.query.selector || '.monaco-workbench');
    const timeout = Number(req.query.timeout || 15000);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    let state;
    try {
      state = await getLiveCDP(host, port, selector, timeout);
    } catch (e) {
      resetLiveCDP();
      return res.status(400).send('<html><body>CDP connect failed: ' + String(e?.message || e) + '</body></html>');
    }

    try {
      const t0 = Date.now();
      const resMap = await ensureResMap(state);
      const t1 = Date.now();
      const { html } = await renderLive(state.page, state.client, {
        proxyBase: '/api/vscode-file',
        token: requireAuth ? token : '',
        cssCache: liveState.cssCache,
        cssTtl: CSS_TTL,
        resMap,
      });
      const t2 = Date.now();
      const acceptGzip = (req.get('Accept-Encoding') || '').includes('gzip');
      if (acceptGzip) {
        const buf = zlib.gzipSync(html);
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', buf.length);
        res.end(buf);
        console.log('[live] resMap=%dms render=%dms gzip=%dms total=%dms raw=%dKB gz=%dKB',
          t1 - t0, t2 - t1, Date.now() - t2, Date.now() - t0,
          (html.length / 1024) | 0, (buf.length / 1024) | 0);
      } else {
        res.send(html);
        console.log('[live] resMap=%dms render=%dms total=%dms size=%dKB',
          t1 - t0, t2 - t1, Date.now() - t0, (html.length / 1024) | 0);
      }
    } catch (e) {
      resetLiveCDP();
      if (!res.headersSent) {
        res.status(500).send('<html><body>Live render error: ' + String(e?.message || e) + '</body></html>');
      }
    }
  });

  // POST /api/remote-click — trigger CDP click on remote Cursor
  app.post('/api/remote-click', async (req, res) => {
    const { host='127.0.0.1', port=9222, selector, containsText='', requireReady=false } = req.body || {};
    console.log('[remote-click] selector=%s', selector?.substring(0, 120));

    if (!selector || !selector.trim()) {
      return res.status(400).json({ ok: false, error: 'selector is required' });
    }

    try {
      const state = await getLiveCDP(host, port, '.monaco-workbench', 10000);
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
      host = '127.0.0.1', port = 9222,
      text = '', append = true, send = false,
    } = req.body || {};
    console.log('[composer/insert] len=%d append=%s send=%s', text.length, append, send);

    if (!text && !send) {
      return res.status(400).json({ ok: false, error: 'text is required (or set send=true to just press Enter)' });
    }

    try {
      const state = await getLiveCDP(host, port, '.monaco-workbench', 10000);

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
    const { host = '127.0.0.1', port = 9222 } = req.body || {};
    console.log('[composer/send]');

    try {
      const state = await getLiveCDP(host, port, '.monaco-workbench', 10000);

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

  // ---------------------------------------------------------------------------
  // Window resize API (calls resize_window.js subprocess)
  // ---------------------------------------------------------------------------
  const resizeScript = path.join(__dirname, 'resize_window.js');

  app.get('/api/resize/info', async (req, res) => {
    const host = String(req.query.host || '127.0.0.1');
    const port = Number(req.query.port || 9222);
    const r = await runNode(resizeScript, ['--host', host, '--port', String(port), '--info', '--verbose']);
    try {
      res.json(JSON.parse(r.out.trim().split('\n').pop()));
    } catch {
      res.status(500).json({ ok: false, code: r.code, stdout: r.out, stderr: r.err });
    }
  });

  app.post('/api/resize', async (req, res) => {
    const { host='127.0.0.1', port=9222, width, height, maximize } = req.body || {};
    const args = ['--host', String(host), '--port', String(port), '--verbose'];
    if (maximize) {
      args.push('--maximize');
    } else {
      if (width != null) args.push('-w', String(Math.round(width)));
      if (height != null) args.push('-h', String(Math.round(height)));
    }
    const r = await runNode(resizeScript, args);
    try {
      const lines = r.out.trim().split('\n');
      res.json(JSON.parse(lines[lines.length - 1]));
    } catch {
      res.status(500).json({ ok: false, code: r.code, stdout: r.out, stderr: r.err });
    }
  });

  // GET /api/vscode-file/* — proxy Electron internal vscode-file://vscode-app/ resources
  app.get('/api/vscode-file/*filePath', async (req, res) => {
    const defaultHost = '127.0.0.1';
    const defaultPort = 9222;

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

    // Security: prevent path traversal
    const resolvedAppRoot = path.resolve(appRoot);
    const resolvedFile = path.resolve(filePath);
    const norm = (p) => process.platform === 'win32' ? String(p).toLowerCase() : String(p);
    const appRootNorm = norm(resolvedAppRoot);
    const fileNorm = norm(resolvedFile);
    if (!fileNorm.startsWith(appRootNorm + path.sep) && fileNorm !== appRootNorm) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    if (!fs.existsSync(resolvedFile)) {
      return res.status(404).json({ ok: false, error: 'not found' });
    }

    const mimeType = mime.lookup(resolvedFile) || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const relFile = path.relative(resolvedAppRoot, resolvedFile);
    res.sendFile(relFile, { root: resolvedAppRoot });
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
      stopWatcher();
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
