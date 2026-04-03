const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const OUT = path.resolve(__dirname, '..', 'dist', 'visual-test', 'web_debug');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);

  const allTabs = await page.locator('.tab').allTextContents();
  console.log('Tabs:', allTabs);

  async function testProject(name, waitMs, outFile) {
    console.log(`\n--- ${name} ---`);
    const tab = page.locator('.tab', { hasText: name });
    if (!(await tab.count())) { console.log('  tab not found'); return; }
    await tab.click();
    await sleep(2000);

    // Always click the button (Start/Reconnect) - the UI's click handler
    // does query→attach(existing) or start(new). To force fresh, we
    // override: send 'start' directly which kills any old session.
    const btn = page.locator('#btn-connect');
    if (await btn.isVisible()) {
      await btn.click();
    }
    console.log(`  Waiting ${waitMs/1000}s...`);
    await sleep(waitMs);
    await page.screenshot({ path: path.join(OUT, outFile) });
    console.log(`  ${outFile} saved`);
  }

  await testProject('cursor_auto', 15000, 'local.png');
  await testProject('ap0', 25000, 'ssh_ap0.png');

  await browser.close();
  console.log('\nDone. Screenshots:', OUT);
})();
