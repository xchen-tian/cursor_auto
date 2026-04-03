const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const OUT = path.resolve(__dirname, '..', 'dist', 'visual-test', 'web_longrun');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);

  // Start local session
  console.log('Starting local session...');
  const tab = page.locator('.tab', { hasText: 'cursor_auto' });
  if (await tab.count()) await tab.click();
  await sleep(1500);
  await page.locator('#btn-connect').click();
  await sleep(15000);

  // Verify Claude is up
  async function getScreen() {
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

  async function isAlive() {
    const overlay = await page.evaluate(() =>
      document.getElementById('overlay').classList.contains('show')
    );
    return !overlay;
  }

  let screen = await getScreen();
  console.log('Initial banner:', /Claude Code/.test(screen) ? 'YES' : 'NO');
  await page.screenshot({ path: path.join(OUT, '01_start.png') });

  // Send a prompt that takes time
  console.log('\nSending long task: "say hello, then wait 10 seconds, then say goodbye"...');
  const termEl = page.locator('.xterm-helper-textarea');
  const prompt = 'say hello then wait';
  for (const ch of prompt) {
    await termEl.press(ch === ' ' ? 'Space' : ch);
    await sleep(20);
  }
  await termEl.press('Enter');

  // Poll every 10 seconds for 100 seconds
  console.log('\nPolling session alive for 100 seconds...');
  let allAlive = true;
  for (let i = 1; i <= 10; i++) {
    await sleep(10000);
    const alive = await isAlive();
    const elapsed = i * 10;
    console.log(`  ${elapsed}s: ${alive ? 'ALIVE' : 'DEAD'}`);
    if (!alive) {
      allAlive = false;
      await page.screenshot({ path: path.join(OUT, `dead_at_${elapsed}s.png`) });
      break;
    }
  }

  if (allAlive) {
    console.log('\n100 seconds survived!');
    await page.screenshot({ path: path.join(OUT, '02_after_100s.png') });

    // Now idle for another 60 seconds (no input, no output)
    console.log('\nIdling for 60 more seconds...');
    await sleep(60000);
    const stillAlive = await isAlive();
    console.log(`  160s total: ${stillAlive ? 'ALIVE' : 'DEAD'}`);
    await page.screenshot({ path: path.join(OUT, '03_after_160s.png') });
  }

  await browser.close();
  console.log('\nDone. Screenshots:', OUT);
  console.log('RESULT:', allAlive ? 'PASS' : 'FAIL');
})();
