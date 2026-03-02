#!/usr/bin/env node

// Quick self-check for cursor_auto

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { connectOverCDP } = require('./cdp');

// Node >= 18 provides global fetch.

async function probeCDP(host, port) {
  const url = `http://${host}:${port}/json/version`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { ok: false, status: r.status, url };
    const j = await r.json().catch(() => null);
    return { ok: true, url, data: j };
  } catch (e) {
    return { ok: false, url, error: String(e?.message || e) };
  }
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('host', { type: 'string', default: '127.0.0.1' })
    .option('port', { type: 'number', default: 9222 })
    .help()
    .argv;

  const nodeMajor = Number(process.versions.node.split('.')[0] || 0);
  if (nodeMajor < 18) {
    console.error(`ERROR: Node ${process.versions.node} detected. cursor_auto expects Node >= 18.`);
    process.exit(2);
  }

  const probe = await probeCDP(argv.host, argv.port);
  if (!probe.ok) {
    console.error('ERROR: CDP endpoint not reachable:', probe);
    console.error('Fix: Start Cursor/VS Code with: --remote-debugging-port=9222');
    process.exit(3);
  }

  // Try Playwright connect
  try {
    const { browser } = await connectOverCDP({ host: argv.host, port: argv.port });
    const contexts = browser.contexts();
    const pages = contexts.length ? contexts[0].pages() : [];
    console.log('OK: Playwright connected over CDP.');
    console.log(` - contexts: ${contexts.length}`);
    console.log(` - pages (context[0]): ${pages.length}`);
    await browser.close();
  } catch (e) {
    console.error('ERROR: Playwright failed to connect over CDP:', String(e?.stack || e));
    process.exit(4);
  }

  console.log('All checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
