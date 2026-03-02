#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const express = require('express');
const { spawn } = require('child_process');

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

  const port = Number(process.env.PORT || 5123);
  const host = process.env.BIND || '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`cursor_auto server: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    if (requireAuth) console.log('Auth enabled: provide header x-token or ?token=...');
    console.log('Static captures served at /captures/<timestamp>/index.html');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
