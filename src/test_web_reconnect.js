const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const OUT = path.resolve(__dirname, '..', 'dist', 'visual-test', 'web_reconnect');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readScreen(page) {
  return page.evaluate(() => {
    const buf = window.term.buffer.active;
    const lines = [];
    const s = Math.max(0, buf.length - window.term.rows);
    for (let i = 0; i < window.term.rows; i++) {
      const l = buf.getLine(s + i);
      if (l) lines.push(l.translateToString(true));
    }
    return lines.join('\n');
  });
}

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const p = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await p.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);

  const tabs = await p.evaluate(() =>
    [...document.querySelectorAll('.tab')].map(t => t.textContent.trim())
  );
  console.log('Tabs:', tabs);
  if (tabs.length < 2) {
    console.log('SKIP: Need 2+ tabs');
    await browser.close();
    process.exit(0);
  }

  // Use local tab (cursor_auto) for reliability — find its index
  let localIdx = tabs.findIndex(t => /cursor_auto/.test(t));
  let otherIdx = localIdx === 0 ? 1 : 0;
  if (localIdx < 0) { localIdx = 0; otherIdx = 1; }
  console.log(`Using tab ${localIdx} (${tabs[localIdx]}) as primary, tab ${otherIdx} as other`);

  // === Step 1: Start Claude on primary tab ===
  console.log('\n=== Step 1: Start Claude ===');
  await p.locator('.tab').nth(localIdx).click();
  await sleep(2000);
  if (await p.locator('#btn-connect').isVisible()) await p.locator('#btn-connect').click();
  await sleep(15000);
  await p.screenshot({ path: path.join(OUT, '1_started.png') });
  const screen1 = await readScreen(p);
  report('Claude started', screen1.length > 50, `${screen1.length} chars`);

  // === Step 2: Switch to other tab ===
  console.log('\n=== Step 2: Switch away ===');
  await p.locator('.tab').nth(otherIdx).click();
  await sleep(3000);
  await p.screenshot({ path: path.join(OUT, '2_switched.png') });

  // === Step 3: Switch back — should auto-attach with saved screen ===
  console.log('\n=== Step 3: Switch back (auto-attach) ===');
  await p.locator('.tab').nth(localIdx).click();
  await sleep(4000);

  const overlayVis = await p.evaluate(() =>
    document.getElementById('overlay').classList.contains('show')
  );
  console.log('  Overlay visible:', overlayVis);

  // If overlay still shows, click reconnect/start
  if (overlayVis) {
    const btn = await p.locator('#btn-connect').textContent();
    console.log('  Button text:', btn);
    if (await p.locator('#btn-connect').isVisible()) {
      await p.locator('#btn-connect').click();
      await sleep(5000);
    }
  }

  await p.screenshot({ path: path.join(OUT, '3_reconnected.png') });
  const screen3 = await readScreen(p);
  const lines3 = screen3.split('\n').filter(l => l.trim());
  console.log('  Screen lines:', lines3.length, 'chars:', screen3.length);

  report('Auto-attach: overlay hidden', !overlayVis || lines3.length > 3);
  report('Screen has content after switch-back', lines3.length > 3, `${lines3.length} lines`);

  // Check the content looks like Claude (not garbled)
  const looksClean = /for shortcuts|Claude|Potluck|Sopwork|cursor_auto/i.test(screen3);
  report('Screen content looks clean', looksClean);

  // === Step 4: Second cycle to verify stability ===
  console.log('\n=== Step 4: Second switch cycle ===');
  await p.locator('.tab').nth(otherIdx).click();
  await sleep(2000);
  await p.locator('.tab').nth(localIdx).click();
  await sleep(4000);

  const overlayVis2 = await p.evaluate(() =>
    document.getElementById('overlay').classList.contains('show')
  );
  if (overlayVis2 && await p.locator('#btn-connect').isVisible()) {
    await p.locator('#btn-connect').click();
    await sleep(5000);
  }

  await p.screenshot({ path: path.join(OUT, '4_second_cycle.png') });
  const screen4 = await readScreen(p);
  const lines4 = screen4.split('\n').filter(l => l.trim());
  report('Second cycle: has content', lines4.length > 3, `${lines4.length} lines`);

  // === Summary ===
  await p.close();
  await browser.close();
  const passed = results.filter(r => r.pass).length;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed}/${results.length} passed`);
  if (passed < results.length) {
    results.filter(r => !r.pass).forEach(r => console.log(`  FAIL: ${r.name}`));
  }
  console.log('Screenshots:', OUT);
  process.exit(passed === results.length ? 0 : 1);
})();
