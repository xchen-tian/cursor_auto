#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.resolve(__dirname, '..', 'dist', 'visual-test', 'web_ap0');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });

  console.log('1. Open /claude');
  await page.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);
  await page.screenshot({ path: path.join(OUT, '1_tabs.png') });

  // Find and click the ap0 tab
  console.log('2. Click ap0 tab');
  const tabs = await page.$$('.tab');
  let ap0Tab = null;
  for (const t of tabs) {
    const text = await t.textContent();
    if (text.includes('ap0')) { ap0Tab = t; break; }
  }
  if (ap0Tab) {
    await ap0Tab.click();
    await sleep(3000);
    console.log('   ap0 tab clicked, waiting for overlay...');
    await page.screenshot({ path: path.join(OUT, '2_ap0_selected.png') });

    // Click Start Claude
    console.log('3. Click Start Claude');
    const btn = await page.$('#btn-connect');
    if (btn) {
      await btn.click();
      console.log('   Waiting 25s for SSH + Claude startup...');
      await sleep(25000);
      await page.screenshot({ path: path.join(OUT, '3_ap0_running.png') });

      // Check terminal content
      const text = await page.evaluate(() => {
        if (!window.term) return '';
        const buf = window.term.buffer.active;
        const lines = [];
        for (let i = 0; i < window.term.rows; i++) {
          const l = buf.getLine(i);
          if (l) lines.push(l.translateToString(true));
        }
        return lines.join('\n');
      });
      const hasClaude = /Claude Code|claude|shortcuts/i.test(text);
      console.log('   Claude banner:', hasClaude);
      console.log('   Screen text (first 200):', text.substring(0, 200));
    } else {
      console.log('   btn-connect not found!');
    }
  } else {
    console.log('   ap0 tab NOT found! Available tabs:');
    for (const t of tabs) console.log('   -', await t.textContent());
  }

  await browser.close();
  console.log('Screenshots:', OUT);
})();
