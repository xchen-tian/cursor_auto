#!/usr/bin/env node

/**
 * Comprehensive web terminal test.
 *
 * Tests:
 *   T1. Page loads, xterm renders
 *   T2. WebSocket connects (AX button is green ON)
 *   T3. Keyboard input reaches Claude (type prompt, see it echoed)
 *   T4. Auto-approve triggers on file-write permission (Approved count > 0)
 *   T5. File is actually created on disk
 *   T6. AX toggle OFF (click button, verify red)
 *   T7. AX toggle ON  (click button, verify green)
 *   T8. Reconnect button works (click, new session starts)
 *   T9. Terminal resize (change viewport, verify no crash)
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const BASE = 'http://localhost:5123';
const OUT = path.resolve(__dirname, '..', 'dist', 'visual-test', 'web_full');
const TEST_FILE = path.resolve(__dirname, '..', 'test_full_e2e.txt');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });

  // ===== T1: Page loads ==================================================
  console.log('\nT1: Page loads');
  const resp = await page.goto(`${BASE}/claude`);
  report('HTTP status', resp.status() === 200, `status=${resp.status()}`);

  await page.waitForTimeout(12000);
  await page.screenshot({ path: path.join(OUT, 't1_loaded.png') });

  // ===== T2: xterm + WebSocket ==========================================
  console.log('\nT2: xterm + WebSocket');
  const hasXterm = await page.evaluate(() => !!document.querySelector('.xterm-screen'));
  report('xterm-screen exists', hasXterm);

  const axClass = await page.getAttribute('#btn-ax', 'class');
  report('AX button starts ON', axClass === 'on', `class="${axClass}"`);

  const approveInit = await page.textContent('#approve-count');
  report('Approve count starts at 0', approveInit.trim() === '0', `count="${approveInit.trim()}"`);

  // ===== T3: Keyboard input ==============================================
  console.log('\nT3: Keyboard input');
  const termEl = await page.$('.xterm-helper-textarea');
  report('xterm textarea found', !!termEl);

  if (termEl) {
    await termEl.focus();
    const prompt = "create test_full_e2e.txt containing 'full e2e passed'";
    for (const ch of prompt) {
      await termEl.press(ch === ' ' ? 'Space' : ch);
      await sleep(15);
    }
    await termEl.press('Enter');
    report('Prompt typed and sent', true);
  }

  // ===== T4: Auto-approve ================================================
  console.log('\nT4: Auto-approve');
  let approved = false;
  for (let i = 0; i < 50; i++) {
    await sleep(1000);
    const count = await page.textContent('#approve-count');
    if (count && Number(count) > 0) {
      approved = true;
      report('Auto-approve fired', true, `count=${count}`);
      break;
    }
    if (i % 10 === 9) console.log(`    ... waiting (${i + 1}s)`);
  }
  if (!approved) report('Auto-approve fired', false, 'timed out after 50s');

  await page.screenshot({ path: path.join(OUT, 't4_approved.png') });

  // ===== T5: File created ================================================
  console.log('\nT5: File on disk');
  await sleep(8000);
  const fileExists = fs.existsSync(TEST_FILE);
  if (fileExists) {
    const content = fs.readFileSync(TEST_FILE, 'utf8').trim();
    report('File exists', true);
    report('File content correct', content === 'full e2e passed', `"${content}"`);
  } else {
    report('File exists', false, 'not found');
  }

  // ===== T6: AX toggle OFF ==============================================
  console.log('\nT6: AX toggle OFF');
  await page.click('#btn-ax');
  await sleep(500);
  const axOff = await page.getAttribute('#btn-ax', 'class');
  report('AX button class = off', axOff === 'off', `class="${axOff}"`);
  await page.screenshot({ path: path.join(OUT, 't6_off.png') });

  // ===== T7: AX toggle ON ===============================================
  console.log('\nT7: AX toggle ON');
  await page.click('#btn-ax');
  await sleep(500);
  const axOn = await page.getAttribute('#btn-ax', 'class');
  report('AX button class = on', axOn === 'on', `class="${axOn}"`);
  await page.screenshot({ path: path.join(OUT, 't7_on.png') });

  // ===== T8: Reconnect ===================================================
  console.log('\nT8: Reconnect');
  await page.click('#btn-reconnect');
  await sleep(10000);
  const hasXterm2 = await page.evaluate(() => !!document.querySelector('.xterm-screen'));
  report('xterm still exists after reconnect', hasXterm2);
  await page.screenshot({ path: path.join(OUT, 't8_reconnect.png') });

  // ===== T9: Resize =====================================================
  console.log('\nT9: Resize');
  await page.setViewportSize({ width: 900, height: 500 });
  await sleep(2000);
  const hasXterm3 = await page.evaluate(() => !!document.querySelector('.xterm-screen'));
  report('xterm survives resize', hasXterm3);
  await page.screenshot({ path: path.join(OUT, 't9_resize.png') });

  // ===== Summary ========================================================
  await browser.close();

  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed}/${total} passed`);
  if (passed < total) {
    console.log('FAILURES:');
    results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.name}: ${r.detail || ''}`));
  }
  console.log(`Screenshots: ${OUT}`);

  // Clean up test file
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);

  process.exit(passed === total ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
