#!/usr/bin/env node
/**
 * Standalone test for the titlebar indicator.
 * Usage:
 *   node src/test_indicator.js              # inject + demo cycle
 *   node src/test_indicator.js --remove     # remove injected indicator
 */

const { connectOverCDP, findPageWithSelector, sleep } = require('./cdp');
const indicator = require('./indicator');

async function main() {
  const doRemove = process.argv.includes('--remove');
  const portArg = process.argv.indexOf('--port');
  const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : 9292;

  console.log(`Connecting to CDP on port ${port}...`);
  const { browser, context } = await connectOverCDP({ port });

  const page = await findPageWithSelector(context, {
    selector: '.monaco-workbench',
    timeoutMs: 10000,
  });

  if (!page) {
    console.error('ERROR: Could not find Cursor workbench page');
    await browser.close();
    process.exit(1);
  }
  console.log('Found workbench page:', await page.title());

  if (doRemove) {
    console.log('Remove result:', await indicator.remove(page));
    await browser.close();
    return;
  }

  console.log('Injecting indicator...');
  console.log('Inject result:', await indicator.inject(page));

  console.log('Demo: cycling states every 2s. Press Ctrl+C to stop and remove.');
  const states = [
    { state: 'scanning', text: 'scan [0]' },
    { state: 'scanning', text: 'idle [1] 8s' },
    { state: 'shimmer',  text: 'SHIMMER [2]' },
    { state: 'clicked',  text: 'RUN [2]' },
  ];

  const cleanup = async () => {
    console.log('\nCleaning up...');
    console.log('Remove result:', await indicator.remove(page));
    await browser.close();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  let i = 0;
  while (true) {
    const s = states[i % states.length];
    await indicator.update(page, s.state, s.text);
    console.log(`  [${s.state}] ${s.text}`);
    i++;
    await sleep(2000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
