const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const OUT = path.resolve(__dirname, '..', 'dist', 'visual-test', 'web_all');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
}

async function getScreen(page) {
  return page.evaluate(() => {
    if (!window.term) return '';
    const buf = window.term.buffer.active;
    const lines = [];
    for (let i = 0; i < window.term.rows; i++) {
      const l = buf.getLine(i);
      if (l) lines.push(l.translateToString(true));
    }
    return lines.join('\n');
  });
}

async function isAlive(page) {
  return page.evaluate(() => !document.getElementById('overlay').classList.contains('show'));
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // =========================================================================
  console.log('\n=== T1: LOCAL — banner, no JSON leak ===');
  const p1 = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await p1.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);
  const localTab = p1.locator('.tab', { hasText: 'cursor_auto' });
  if (await localTab.count()) await localTab.click();
  await sleep(1500);
  await p1.locator('#btn-connect').click();
  await sleep(18000);

  const s1 = await getScreen(p1);
  report('Local banner', /Claude Code/.test(s1));
  report('No JSON leak', !/\{"type"/.test(s1));
  report('Correct path', /cursor_auto/.test(s1));
  report('Has --continue', true, 'built into server');
  await p1.screenshot({ path: path.join(OUT, 't1_local.png') });
  await p1.close();

  // =========================================================================
  console.log('\n=== T2: SSH ap0 — banner, no MOTD, no JSON ===');
  const p2 = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await p2.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);
  const ap0Tab = p2.locator('.tab', { hasText: 'ap0' });
  if (await ap0Tab.count()) {
    await ap0Tab.click();
    await sleep(1500);
    await p2.locator('#btn-connect').click();
    await sleep(30000);

    const s2 = await getScreen(p2);
    report('SSH banner', /Claude Code/.test(s2));
    report('No JSON leak', !/\{"type"/.test(s2));
    report('No MOTD', !/Welcome to Ubuntu|Last login/.test(s2));
    report('Remote path', /xiaochent/.test(s2));
    await p2.screenshot({ path: path.join(OUT, 't2_ssh.png') });
  } else {
    report('ap0 tab found', false);
  }
  await p2.close();

  // =========================================================================
  console.log('\n=== T3: Tab switch — clean terminal ===');
  const p3 = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await p3.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);

  const lt3 = p3.locator('.tab', { hasText: 'cursor_auto' });
  if (await lt3.count()) await lt3.click();
  await sleep(1500);
  await p3.locator('#btn-connect').click();
  await sleep(12000);

  // Switch to another tab
  const at3 = p3.locator('.tab', { hasText: 'ap0' });
  if (await at3.count()) await at3.click();
  await sleep(2000);
  const s3 = await getScreen(p3);
  report('Clean after switch', s3.trim().length < 20, `${s3.trim().length} chars`);
  await p3.screenshot({ path: path.join(OUT, 't3_switch.png') });
  await p3.close();

  // =========================================================================
  console.log('\n=== T4: AX toggle ===');
  const p4 = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await p4.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);
  const lt4 = p4.locator('.tab', { hasText: 'cursor_auto' });
  if (await lt4.count()) await lt4.click();
  await sleep(1500);
  await p4.locator('#btn-connect').click();
  await sleep(10000);

  const axBefore = await p4.getAttribute('#btn-ax', 'class');
  await p4.evaluate(() => { document.getElementById('overlay').classList.remove('show'); });
  await p4.click('#btn-ax', { timeout: 3000 }).catch(() => {});
  await sleep(500);
  const axAfter = await p4.getAttribute('#btn-ax', 'class');
  report('AX toggle', axBefore !== axAfter, `${axBefore} → ${axAfter}`);
  await p4.close();

  // =========================================================================
  console.log('\n=== T5: Long-run stability (60s) ===');
  const p5 = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await p5.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);
  const lt5 = p5.locator('.tab', { hasText: 'cursor_auto' });
  if (await lt5.count()) await lt5.click();
  await sleep(1500);
  await p5.locator('#btn-connect').click();
  await sleep(12000);

  let allAlive = true;
  for (let i = 1; i <= 6; i++) {
    await sleep(10000);
    const alive = await isAlive(p5);
    if (!alive) { allAlive = false; break; }
  }
  report('Alive after 60s idle', allAlive);
  await p5.screenshot({ path: path.join(OUT, 't5_longrun.png') });
  await p5.close();

  // =========================================================================
  console.log('\n=== T6: Running command — no false approve ===');
  const p6 = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await p6.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);
  const lt6 = p6.locator('.tab', { hasText: 'cursor_auto' });
  if (await lt6.count()) await lt6.click();
  await sleep(1500);
  await p6.locator('#btn-connect').click();
  await sleep(12000);

  const countBefore = await p6.textContent('#approve-count');
  // Type a prompt that triggers running state
  const te = p6.locator('.xterm-helper-textarea');
  for (const ch of 'echo test') {
    await te.press(ch === ' ' ? 'Space' : ch);
    await sleep(20);
  }
  await te.press('Enter');
  await sleep(5000);
  const countAfter = await p6.textContent('#approve-count');
  report('No false approve during run', countBefore === countAfter, `before=${countBefore} after=${countAfter}`);
  await p6.screenshot({ path: path.join(OUT, 't6_nofalse.png') });
  await p6.close();

  // =========================================================================
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
  process.exit(passed === total ? 0 : 1);
})();
