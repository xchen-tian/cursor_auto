const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const OUT = path.resolve(__dirname, '..', 'dist', 'visual-test', 'web_buttons');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // === T1: Initial overlay shows both buttons ===
  console.log('\n=== T1: Overlay buttons ===');
  const p1 = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await p1.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);
  const tab = p1.locator('.tab', { hasText: 'cursor_auto' });
  if (await tab.count()) await tab.click();
  await sleep(2000);

  const resumeVisible = await p1.locator('#btn-connect').isVisible();
  const newVisible = await p1.locator('#btn-new').isVisible();
  report('Resume button visible', resumeVisible);
  report('New Session button visible', newVisible);
  await p1.screenshot({ path: path.join(OUT, 't1_overlay.png') });
  await p1.close();

  // === T2: Resume button starts with --continue ===
  console.log('\n=== T2: Resume (--continue) ===');
  const p2 = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await p2.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);
  const tab2 = p2.locator('.tab', { hasText: 'cursor_auto' });
  if (await tab2.count()) await tab2.click();
  await sleep(1500);
  await p2.locator('#btn-connect').click();
  await sleep(15000);

  const screen2 = await p2.evaluate(() => {
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
  report('Resume shows Claude', /Claude Code/.test(screen2));
  await p2.screenshot({ path: path.join(OUT, 't2_resume.png') });
  await p2.close();

  // === T3: New Session starts fresh (no --continue) ===
  console.log('\n=== T3: New Session (no --continue) ===');
  const p3 = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await p3.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);
  const tab3 = p3.locator('.tab', { hasText: 'cursor_auto' });
  if (await tab3.count()) await tab3.click();
  await sleep(1500);
  await p3.locator('#btn-new').click();
  await sleep(15000);

  const screen3 = await p3.evaluate(() => {
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
  report('New Session shows Claude', /Claude Code/.test(screen3));
  // New session should NOT show previous conversation history
  const hasOldHistory = /say hello then wait|auto-approve works/.test(screen3);
  report('No old history in new session', !hasOldHistory, hasOldHistory ? 'old history found' : 'clean');
  await p3.screenshot({ path: path.join(OUT, 't3_new.png') });
  await p3.close();

  // === T4: Scroll stays at bottom (xterm 6.0 fix) ===
  console.log('\n=== T4: Scroll stability ===');
  const p4 = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await p4.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);
  const tab4 = p4.locator('.tab', { hasText: 'cursor_auto' });
  if (await tab4.count()) await tab4.click();
  await sleep(1500);
  await p4.locator('#btn-connect').click();
  await sleep(12000);

  // Type something to generate output
  const te = p4.locator('.xterm-helper-textarea');
  for (const ch of 'echo scroll test') {
    await te.press(ch === ' ' ? 'Space' : ch);
    await sleep(15);
  }
  await te.press('Enter');
  await sleep(8000);

  // Check scroll position
  const scrollInfo = await p4.evaluate(() => {
    const vp = document.querySelector('.xterm-viewport');
    if (!vp) return { top: 0, max: 0 };
    return { top: vp.scrollTop, max: vp.scrollHeight - vp.clientHeight };
  });
  const atBottom = scrollInfo.max <= 0 || scrollInfo.top >= scrollInfo.max - 10;
  report('Scroll at bottom', atBottom, `top=${scrollInfo.top} max=${scrollInfo.max}`);
  await p4.screenshot({ path: path.join(OUT, 't4_scroll.png') });
  await p4.close();

  // === Summary ===
  await browser.close();
  const passed = results.filter(r => r.pass).length;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed}/${results.length} passed`);
  if (passed < results.length) {
    results.filter(r => !r.pass).forEach(r => console.log(`  FAIL: ${r.name} — ${r.detail || ''}`));
  }
  console.log('Screenshots:', OUT);
  process.exit(passed === results.length ? 0 : 1);
})();
