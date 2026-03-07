#!/usr/bin/env node

const path = require('path');
const { spawn } = require('child_process');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { extractProjectName, sleep } = require('./cdp');
const { findRunningClickSupervisors } = require('./click_watch_lock');

/**
 * Discover Cursor workbench windows via the CDP HTTP endpoint.
 * Returns [{ id, title, project }] for type=page targets whose title ends with " - Cursor".
 */
async function discoverWindows(host, port) {
  const url = `http://${host}:${port}/json/list`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const targets = await resp.json();
  return targets
    .filter(t => t.type === 'page' && / - Cursor$/.test(t.title))
    .map(t => ({
      id: t.id,
      title: t.title,
      project: extractProjectName(t.title),
    }));
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('host', { type: 'string', default: '127.0.0.1' })
    .option('port', { type: 'number', default: 9222 })
    .option('poll-interval', { type: 'number', default: 5000, describe: 'Window discovery poll interval (ms)' })
    .option('interval', { type: 'number', default: 3000, describe: 'Auto-click check interval (forwarded to workers)' })
    .option('selector', { type: 'string', default: '.composer-run-button' })
    .option('contains', { type: 'string', default: '' })
    .option('require-ready', { type: 'boolean', default: true })
    .option('ready-attr', { type: 'string', default: 'data-click-ready' })
    .option('scan-tabs', { type: 'boolean', default: false })
    .option('tab-selector', { type: 'string', default: '' })
    .option('tab-settle-ms', { type: 'number', default: 500 })
    .option('verbose', { type: 'boolean', default: false })
    .help()
    .argv;

  const existing = findRunningClickSupervisors({ host: argv.host, port: argv.port });
  if (existing.length > 0) {
    console.error(`ERROR: click watcher already running for ${argv.host}:${argv.port}`);
    existing.forEach(p => console.error(`  PID ${p.pid} (${p.mode}): ${p.cmd}`));
    process.exit(1);
  }

  const workers = new Map(); // targetId -> { child, project, startedAt }
  let shuttingDown = false;

  function buildWorkerArgs(targetId) {
    const args = [
      path.join(__dirname, 'auto_click.js'),
      '--host', argv.host,
      '--port', String(argv.port),
      '--target-id', targetId,
      '--selector', argv.selector,
      '--interval', String(argv.interval),
      '--require-ready', String(argv['require-ready']),
      '--ready-attr', argv['ready-attr'],
      '--tab-settle-ms', String(argv['tab-settle-ms']),
      '--force',
    ];
    if (argv.contains) args.push('--contains', argv.contains);
    if (argv['scan-tabs']) args.push('--scan-tabs');
    if (argv['tab-selector']) args.push('--tab-selector', argv['tab-selector']);
    if (argv.verbose) args.push('--verbose');
    return args;
  }

  function spawnWorker(targetId, project) {
    const args = buildWorkerArgs(targetId);
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const prefix = `[${project}]`;
    child.stdout.on('data', (d) => {
      for (const line of d.toString().split(/\r?\n/).filter(Boolean)) {
        console.log(prefix, line);
      }
    });
    child.stderr.on('data', (d) => {
      for (const line of d.toString().split(/\r?\n/).filter(Boolean)) {
        console.error(prefix, line);
      }
    });
    child.on('exit', (code) => {
      if (argv.verbose) console.log(`${prefix} worker exited (code ${code})`);
      workers.delete(targetId);
    });

    workers.set(targetId, { child, project, startedAt: Date.now() });
    console.log(`[supervisor] Started worker for "${project}" (${targetId.substring(0, 8)}...)`);
  }

  function killWorker(targetId) {
    const w = workers.get(targetId);
    if (!w) return;
    console.log(`[supervisor] Stopping worker for "${w.project}" (window gone)`);
    try { w.child.kill('SIGTERM'); } catch {}
    workers.delete(targetId);
  }

  function killAll() {
    for (const [id, w] of workers) {
      try { w.child.kill('SIGTERM'); } catch {}
    }
    workers.clear();
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[supervisor] Shutting down, killing all workers...');
    killAll();
    await sleep(500);
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[supervisor] Watching CDP at ${argv.host}:${argv.port}, poll every ${argv['poll-interval']}ms`);

  while (!shuttingDown) {
    try {
      const windows = await discoverWindows(argv.host, argv.port);
      const currentIds = new Set(windows.map(w => w.id));

      for (const w of windows) {
        if (!workers.has(w.id)) {
          spawnWorker(w.id, w.project);
        }
      }

      for (const [id] of workers) {
        if (!currentIds.has(id)) {
          killWorker(id);
        }
      }

      if (argv.verbose) {
        const summary = windows.map(w => {
          const running = workers.has(w.id);
          return `${w.project}(${running ? 'running' : 'starting'})`;
        }).join(', ');
        console.log(`[supervisor] ${windows.length} window(s): ${summary}`);
      }
    } catch (e) {
      if (argv.verbose) console.error('[supervisor] Discovery error:', e.message);
    }

    await sleep(argv['poll-interval']);
  }
}

main().catch((e) => {
  console.error('[supervisor]', e);
  process.exit(1);
});
