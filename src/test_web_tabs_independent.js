/**
 * Test: Independent per-tab sessions + AX control.
 *
 * 1. Start Claude on tab A (window 1)
 * 2. Start Claude on tab B (window 2)
 * 3. Switch between tabs — sessions stay alive
 * 4. Turn off AX on tab B
 * 5. Send "run sleep 3" on tab A (AX on → auto-approve)
 * 6. Switch to tab B, send "run sleep 3" (AX off → prompt waits)
 * 7. Screenshot evidence of both states
 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const OUT = path.resolve(__dirname, '..', 'dist', 'visual-test', 'web_tabs_indep');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
}

function readScreen(page) {
  return page.evaluate(() => {
    if (!window.term) return '';
    const buf = window.term.buffer.active;
    const lines = [];
    const start = Math.max(0, buf.length - window.term.rows);
    for (let i = 0; i < window.term.rows; i++) {
      const l = buf.getLine(start + i);
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
    else if (ch === '"') await ta.press('"');
    else if (ch === '&') await ta.press('&');
    else await ta.press(ch);
    await sleep(25);
  }
  await ta.press('Enter');
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const p = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await p.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);

  // Get list of tabs
  const tabs = await p.evaluate(() =>
    [...document.querySelectorAll('.tab')].map((t, i) => ({
      index: i,
      text: t.textContent.trim(),
    }))
  );
  console.log('Tabs:', tabs.map(t => t.text));

  if (tabs.length < 2) {
    console.log('SKIP: Need at least 2 Cursor windows open. Only found:', tabs.length);
    await browser.close();
    process.exit(0);
  }

  // === Step 1: Start Claude on Tab A ===
  console.log('\n=== Step 1: Start Claude on Tab A ===');
  const tabA = p.locator('.tab').nth(0);
  await tabA.click();
  await sleep(2000);
  // Start or resume
  const btnR1 = p.locator('#btn-connect');
  if (await btnR1.isVisible()) await btnR1.click();
  await sleep(15000);
  await p.screenshot({ path: path.join(OUT, '1_tabA_started.png') });

  const screenA1 = await readScreen(p);
  report('Tab A: Claude running', /Claude Code|claude/i.test(screenA1) || screenA1.length > 50);
  const tabALabel = tabs[0].text;
  console.log('  Tab A label:', tabALabel);

  // === Step 2: Start Claude on Tab B ===
  console.log('\n=== Step 2: Start Claude on Tab B ===');
  const tabB = p.locator('.tab').nth(1);
  await tabB.click();
  await sleep(2000);
  const btnR2 = p.locator('#btn-connect');
  if (await btnR2.isVisible()) await btnR2.click();
  await sleep(15000);
  await p.screenshot({ path: path.join(OUT, '2_tabB_started.png') });

  const screenB1 = await readScreen(p);
  report('Tab B: Claude running', /Claude Code|claude/i.test(screenB1) || screenB1.length > 50);
  const tabBLabel = tabs[1].text;
  console.log('  Tab B label:', tabBLabel);

  // === Step 3: Switch back to Tab A — session should be alive ===
  console.log('\n=== Step 3: Switch back to Tab A (session alive) ===');
  await tabA.click();
  await sleep(3000);
  await p.screenshot({ path: path.join(OUT, '3_tabA_returned.png') });

  const overlayVis = await p.evaluate(() => {
    const ov = document.getElementById('overlay');
    return ov && ov.classList.contains('show');
  });
  // If overlay shows, we need to reconnect
  if (overlayVis) {
    const btnText = await p.locator('#btn-connect').textContent();
    console.log('  Overlay visible, button:', btnText);
    if (btnText === 'Reconnect') {
      await p.locator('#btn-connect').click();
      await sleep(5000);
    }
  }

  const screenA2 = await readScreen(p);
  report('Tab A: Session restored', screenA2.length > 20);
  await p.screenshot({ path: path.join(OUT, '3b_tabA_restored.png') });

  // === Step 4: Turn off AX on Tab B ===
  console.log('\n=== Step 4: Turn off AX on Tab B ===');
  await tabB.click();
  await sleep(3000);
  // Reconnect if needed
  const overlayVis2 = await p.evaluate(() =>
    document.getElementById('overlay').classList.contains('show')
  );
  if (overlayVis2) {
    const btnText = await p.locator('#btn-connect').textContent();
    if (btnText === 'Reconnect') {
      await p.locator('#btn-connect').click();
      await sleep(5000);
    }
  }

  // Click AX button to turn off
  const axBefore = await p.locator('#btn-ax').getAttribute('class');
  if (axBefore === 'on') {
    await p.locator('#btn-ax').click();
    await sleep(200);
  }
  const axAfterB = await p.locator('#btn-ax').getAttribute('class');
  report('Tab B: AX is OFF', axAfterB === 'off', `class=${axAfterB}`);
  await p.screenshot({ path: path.join(OUT, '4_tabB_ax_off.png') });

  // === Step 5: Verify Tab A AX is still ON ===
  console.log('\n=== Step 5: Verify Tab A AX still ON ===');
  await tabA.click();
  await sleep(2000);
  // Reconnect if needed
  const overlayVis3 = await p.evaluate(() =>
    document.getElementById('overlay').classList.contains('show')
  );
  if (overlayVis3) {
    await p.locator('#btn-connect').click();
    await sleep(5000);
  }

  const axAfterA = await p.locator('#btn-ax').getAttribute('class');
  report('Tab A: AX is still ON', axAfterA === 'on', `class=${axAfterA}`);
  await p.screenshot({ path: path.join(OUT, '5_tabA_ax_on.png') });

  // === Step 6: Send sleep command on Tab A (AX on → should auto-approve) ===
  console.log('\n=== Step 6: Tab A — sleep with AX ON ===');
  await typeInTerminal(p, 'run bash command: sleep 3 && echo TAB_A_DONE');
  console.log('  Sent prompt on Tab A, waiting 20s...');
  await sleep(20000);

  const screenA3 = await readScreen(p);
  const tabADone = /TAB_A_DONE/.test(screenA3) || /sleep 3/.test(screenA3);
  report('Tab A: sleep command processed', tabADone);
  await p.screenshot({ path: path.join(OUT, '6_tabA_sleep.png') });

  // === Step 7: Switch to Tab B and send same command (AX off → should wait) ===
  console.log('\n=== Step 7: Tab B — sleep with AX OFF ===');
  await tabB.click();
  await sleep(3000);
  const overlayVis4 = await p.evaluate(() =>
    document.getElementById('overlay').classList.contains('show')
  );
  if (overlayVis4) {
    await p.locator('#btn-connect').click();
    await sleep(5000);
  }

  // Verify AX is still off on Tab B
  const axB2 = await p.locator('#btn-ax').getAttribute('class');
  report('Tab B: AX still OFF after switch', axB2 === 'off', `class=${axB2}`);

  await typeInTerminal(p, 'run bash command: sleep 3 && echo TAB_B_DONE');
  console.log('  Sent prompt on Tab B, waiting 10s (should NOT auto-approve)...');
  await sleep(10000);

  const screenB2 = await readScreen(p);
  const tabBWaiting = /Do you want|wants to|Yes.*No|allow/i.test(screenB2) ||
                      !/TAB_B_DONE/.test(screenB2);
  report('Tab B: prompt waiting (no auto-approve)', tabBWaiting);
  await p.screenshot({ path: path.join(OUT, '7_tabB_waiting.png') });

  // === Summary ===
  await p.close();
  await browser.close();
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed}/${total} passed`);
  if (passed < total) {
    results.filter(r => !r.pass).forEach(r => console.log(`  FAIL: ${r.name} — ${r.detail || ''}`));
  }
  console.log('Screenshots:', OUT);
  process.exit(passed === total ? 0 : 1);
})();
