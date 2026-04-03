/**
 * Full reconnect lifecycle test:
 * 1. Start Claude, type commands, screenshot
 * 2. Simulate disconnect (close ws)
 * 3. Reconnect, verify content restored
 * 4. Type more commands after reconnect
 * 5. Tab switch + switch back (client-side reconnect)
 * 6. Screenshot everything
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const OUT = path.resolve(__dirname, '..', 'dist', 'visual-test', 'web_reconnect_full');
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

async function typeInTerminal(page, text) {
  const ta = page.locator('.xterm-helper-textarea');
  await ta.focus();
  for (const ch of text) {
    if (ch === ' ') await ta.press('Space');
    else if (ch === '-') await ta.press('Minus');
    else if (ch === "'") await ta.press("'");
    else if (ch === '&') await ta.press('&');
    else if (ch === '.') await ta.press('.');
    else await ta.press(ch);
    await sleep(25);
  }
  await ta.press('Enter');
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

  // Find cursor_auto (local) tab
  let localIdx = tabs.findIndex(t => /cursor_auto/.test(t));
  if (localIdx < 0) localIdx = 0;
  const otherIdx = localIdx === 0 ? Math.min(1, tabs.length - 1) : 0;
  console.log(`Primary: [${localIdx}] ${tabs[localIdx]}`);

  // ========================================
  // Phase 1: Start session + type commands
  // ========================================
  console.log('\n=== Phase 1: Start + type commands ===');
  await p.locator('.tab').nth(localIdx).click();
  await sleep(2000);
  if (await p.locator('#btn-connect').isVisible()) await p.locator('#btn-connect').click();
  await sleep(15000);

  const screen1 = await readScreen(p);
  report('Session started', screen1.length > 50);
  await p.screenshot({ path: path.join(OUT, '1_started.png') });

  // Type a command
  console.log('  Typing: echo HELLO_RECONNECT_TEST');
  await typeInTerminal(p, 'echo HELLO_RECONNECT_TEST');
  await sleep(10000);

  const screen2 = await readScreen(p);
  const hasHello = /HELLO_RECONNECT_TEST/.test(screen2);
  report('Command output visible', hasHello);
  await p.screenshot({ path: path.join(OUT, '2_after_command.png') });

  // Type another command
  console.log('  Typing: echo SECOND_CMD');
  await typeInTerminal(p, 'echo SECOND_CMD');
  await sleep(8000);

  const screen3 = await readScreen(p);
  report('Second command visible', /SECOND_CMD/.test(screen3));
  await p.screenshot({ path: path.join(OUT, '3_second_cmd.png') });

  // ========================================
  // Phase 2: Simulate disconnect (close ws)
  // ========================================
  console.log('\n=== Phase 2: Disconnect ===');
  await p.evaluate(() => { if (ws) ws.close(); });
  await sleep(2000);

  const overlayAfterDC = await p.evaluate(() => ({
    visible: document.getElementById('overlay').classList.contains('show'),
    msg: document.getElementById('overlay-msg').textContent,
    btn: document.getElementById('btn-connect').textContent,
  }));
  console.log('  Overlay:', JSON.stringify(overlayAfterDC));
  report('Disconnect shows overlay', overlayAfterDC.visible);
  report('Overlay says Disconnected', /Disconnect/i.test(overlayAfterDC.msg));
  await p.screenshot({ path: path.join(OUT, '4_disconnected.png') });

  // ========================================
  // Phase 3: Reconnect via button
  // ========================================
  console.log('\n=== Phase 3: Reconnect ===');
  await p.locator('#btn-connect').click();
  await sleep(5000);

  const overlayAfterRC = await p.evaluate(() =>
    document.getElementById('overlay').classList.contains('show')
  );
  report('Overlay hidden after reconnect', !overlayAfterRC);

  const screen4 = await readScreen(p);
  const lines4 = screen4.split('\n').filter(l => l.trim());
  console.log('  Screen lines after reconnect:', lines4.length);
  // After ws reconnect, server replays outputBuf (raw replay, no saved screenLines)
  report('Has content after reconnect', lines4.length > 3, `${lines4.length} lines`);
  await p.screenshot({ path: path.join(OUT, '5_reconnected.png') });

  // ========================================
  // Phase 4: Type command after reconnect
  // ========================================
  console.log('\n=== Phase 4: Type after reconnect ===');
  await typeInTerminal(p, 'echo AFTER_RECONNECT_OK');
  await sleep(10000);

  const screen5 = await readScreen(p);
  report('Post-reconnect command works', /AFTER_RECONNECT_OK/.test(screen5));
  await p.screenshot({ path: path.join(OUT, '6_after_reconnect_cmd.png') });

  // ========================================
  // Phase 5: Tab switch reconnect (client-side)
  // ========================================
  if (tabs.length >= 2) {
    console.log('\n=== Phase 5: Tab switch reconnect ===');
    await p.locator('.tab').nth(otherIdx).click();
    await sleep(2000);
    await p.screenshot({ path: path.join(OUT, '7_other_tab.png') });

    await p.locator('.tab').nth(localIdx).click();
    await sleep(4000);

    // Should auto-attach with saved screen
    const overlayTabSwitch = await p.evaluate(() =>
      document.getElementById('overlay').classList.contains('show')
    );
    if (overlayTabSwitch && await p.locator('#btn-connect').isVisible()) {
      await p.locator('#btn-connect').click();
      await sleep(5000);
    }

    const screen6 = await readScreen(p);
    const lines6 = screen6.split('\n').filter(l => l.trim());
    report('Tab switch: content restored', lines6.length > 3, `${lines6.length} lines`);
    const hasAfterRC = /AFTER_RECONNECT_OK/.test(screen6);
    report('Tab switch: previous commands visible', hasAfterRC);
    await p.screenshot({ path: path.join(OUT, '8_tab_switch_back.png') });
  }

  // ========================================
  // Summary
  // ========================================
  await p.close();
  await browser.close();
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed}/${total} passed`);
  if (passed < total) {
    results.filter(r => !r.pass).forEach(r => console.log(`  FAIL: ${r.name}`));
  }
  console.log('Screenshots:', OUT);
  process.exit(passed === total ? 0 : 1);
})();
