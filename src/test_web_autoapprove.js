const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const OUT = path.resolve(__dirname, '..', 'dist', 'visual-test', 'web_autoapprove');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TEST_FILE = path.resolve(__dirname, '..', `test_aa_${Date.now()}.txt`);

(async () => {
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);

  // Select local cursor_auto
  console.log('1. Select cursor_auto + Start Claude');
  const tab = page.locator('.tab', { hasText: 'cursor_auto' });
  if (await tab.count()) await tab.click();
  await sleep(1500);
  await page.locator('#btn-connect').click();
  await sleep(15000);

  // Verify AX is ON
  const axClass = await page.getAttribute('#btn-ax', 'class');
  console.log('   AX state:', axClass);

  // Type a prompt that triggers file write (needs approval)
  console.log('2. Typing prompt that triggers file write...');
  const te = page.locator('.xterm-helper-textarea');
  const fname = path.basename(TEST_FILE);
  const prompt = `create ${fname} with content 'auto-approve works'`;
  for (const ch of prompt) {
    await te.press(ch === ' ' ? 'Space' : ch);
    await sleep(15);
  }
  await te.press('Enter');
  console.log('   Prompt sent. Waiting for auto-approve...');

  // Poll for approval
  let approved = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const count = await page.textContent('#approve-count');
    if (count && Number(count) > 0) {
      console.log(`   AUTO-APPROVED! Count: ${count} (after ${i+1}s)`);
      approved = true;
      break;
    }
    if (i % 10 === 9) console.log(`   ... waiting (${i+1}s)`);
  }

  await page.screenshot({ path: path.join(OUT, 'after_approve.png') });

  if (!approved) {
    console.log('   TIMEOUT: auto-approve did not fire in 60s');
    // Screenshot the screen text for debugging
    const screen = await page.evaluate(() => {
      if (!window.term) return '';
      const buf = window.term.buffer.active;
      const lines = [];
      for (let i = 0; i < window.term.rows; i++) {
        const l = buf.getLine(i);
        if (l) lines.push(l.translateToString(true));
      }
      return lines.join('\n');
    });
    console.log('   Screen (last 300):', screen.slice(-300));
  }

  // Wait for file creation
  console.log('3. Checking file...');
  await sleep(10000);
  if (fs.existsSync(TEST_FILE)) {
    const content = fs.readFileSync(TEST_FILE, 'utf8').trim();
    console.log('   FILE CREATED:', content);
  } else {
    console.log('   File not found');
  }

  await page.screenshot({ path: path.join(OUT, 'final.png') });
  await browser.close();

  // Cleanup
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);

  console.log('\nRESULT:', approved ? 'PASS' : 'FAIL');
  console.log('Screenshots:', OUT);
  process.exit(approved ? 0 : 1);
})();
