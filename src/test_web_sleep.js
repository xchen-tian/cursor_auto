const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const OUT = path.resolve(__dirname, '..', 'dist', 'visual-test', 'web_sleep');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);

  // Start local session
  const tab = page.locator('.tab', { hasText: 'cursor_auto' });
  if (await tab.count()) await tab.click();
  await sleep(1500);
  await page.locator('#btn-connect').click();
  console.log('Waiting for Claude to start (15s)...');
  await sleep(15000);

  // Type: run sleep 5 then echo done
  console.log('Typing prompt: run sleep 5 and echo done...');
  const te = page.locator('.xterm-helper-textarea');
  const prompt = 'run bash command: sleep 5 && echo SLEEP_DONE';
  for (const ch of prompt) {
    await te.press(ch === ' ' ? 'Space' : ch);
    await sleep(15);
  }
  await te.press('Enter');
  console.log('Prompt sent.');

  // Wait for permission prompt to appear
  console.log('Waiting for permission prompt (20s)...');
  await sleep(20000);

  // Screenshot 1: BEFORE approve (prompt visible, not yet approved)
  const count1 = await page.textContent('#approve-count');
  await page.screenshot({ path: path.join(OUT, '1_before_approve.png') });
  console.log('1_before_approve.png — Approved:', count1);

  // Wait for auto-approve to fire
  console.log('Waiting for auto-approve + sleep execution (30s)...');
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const c = await page.textContent('#approve-count');
    if (Number(c) > 0 && i > 5) break;
  }

  const count2 = await page.textContent('#approve-count');
  await page.screenshot({ path: path.join(OUT, '2_after_approve.png') });
  console.log('2_after_approve.png — Approved:', count2);

  // Wait for sleep to finish and SLEEP_DONE to appear
  console.log('Waiting for SLEEP_DONE (20s more)...');
  let foundDone = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const screen = await page.evaluate(() => {
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
    if (/SLEEP_DONE/.test(screen)) {
      foundDone = true;
      console.log(`  SLEEP_DONE found after ${i+1}s`);
      break;
    }
  }

  // Screenshot 3: AFTER sleep completed
  await page.screenshot({ path: path.join(OUT, '3_sleep_done.png') });
  const count3 = await page.textContent('#approve-count');
  console.log('3_sleep_done.png — Approved:', count3, '| SLEEP_DONE:', foundDone);

  await browser.close();
  console.log('\nRESULT:', foundDone ? 'PASS' : 'FAIL');
  console.log('Screenshots:', OUT);
  process.exit(foundDone ? 0 : 1);
})();
