#!/usr/bin/env node

/**
 * End-to-end test for the web terminal (/claude).
 *
 * 1. Opens the page in a headless browser
 * 2. Waits for Claude Code TUI to render
 * 3. Types a prompt that triggers a file-write permission
 * 4. Verifies auto-approve fires
 * 5. Checks the file was created
 * 6. Clicks the AX toggle button
 * 7. Takes screenshots at each step
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const BASE = process.env.BASE_URL || 'http://localhost:5123';
const OUT = path.resolve(__dirname, '..', 'dist', 'visual-test', 'web_e2e');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });

  // ---- Step 1: Open the terminal page -----------------------------------
  console.log('Step 1: Opening /claude ...');
  await page.goto(`${BASE}/claude`);
  await page.waitForTimeout(12000);
  await page.screenshot({ path: path.join(OUT, '01_initial.png') });
  console.log('  Screenshot: 01_initial.png');

  // ---- Step 2: Verify xterm rendered ------------------------------------
  console.log('Step 2: Checking xterm rendered ...');
  const hasXterm = await page.evaluate(() => !!document.querySelector('.xterm-screen'));
  console.log('  xterm-screen found:', hasXterm);

  // ---- Step 3: Check AX button state ------------------------------------
  console.log('Step 3: Checking AX button ...');
  const axText = await page.textContent('#btn-ax');
  const axClass = await page.getAttribute('#btn-ax', 'class');
  console.log('  AX button:', axText, '| class:', axClass);

  // ---- Step 4: Type a prompt that triggers file write -------------------
  console.log('Step 4: Typing prompt ...');
  const termEl = await page.$('.xterm-helper-textarea');
  if (termEl) {
    await termEl.focus();
    const prompt = "create a file called test_web_e2e.txt with content 'web terminal works'";
    for (const ch of prompt) {
      await termEl.press(ch === ' ' ? 'Space' : ch);
      await sleep(20);
    }
    await termEl.press('Enter');
    console.log('  Prompt sent, waiting for Claude to process ...');
  } else {
    console.log('  WARNING: xterm textarea not found, cannot type');
  }

  // ---- Step 5: Wait for auto-approve ------------------------------------
  console.log('Step 5: Waiting for auto-approve (up to 45s) ...');
  let approved = false;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const count = await page.textContent('#approve-count');
    if (count && Number(count) > 0) {
      console.log(`  Auto-approved! Count: ${count}`);
      approved = true;
      break;
    }
    if (i % 10 === 9) console.log(`  ... still waiting (${i + 1}s)`);
  }
  await page.screenshot({ path: path.join(OUT, '02_after_approve.png') });
  console.log('  Screenshot: 02_after_approve.png');

  // ---- Step 6: Wait a bit more for file creation ------------------------
  if (approved) {
    console.log('Step 6: Waiting for file creation ...');
    await sleep(8000);
    const fileExists = fs.existsSync(path.resolve(__dirname, '..', 'test_web_e2e.txt'));
    if (fileExists) {
      const content = fs.readFileSync(path.resolve(__dirname, '..', 'test_web_e2e.txt'), 'utf8');
      console.log('  File created! Content:', content.trim());
    } else {
      console.log('  File not found yet (Claude may still be processing)');
    }
  }

  // ---- Step 7: Click AX toggle button -----------------------------------
  console.log('Step 7: Clicking AX toggle ...');
  await page.click('#btn-ax');
  await sleep(1000);
  const axText2 = await page.textContent('#btn-ax');
  const axClass2 = await page.getAttribute('#btn-ax', 'class');
  console.log('  After toggle - AX button:', axText2, '| class:', axClass2);
  await page.screenshot({ path: path.join(OUT, '03_toggle_off.png') });
  console.log('  Screenshot: 03_toggle_off.png');

  // ---- Step 8: Toggle back ON ------------------------------------------
  console.log('Step 8: Clicking AX toggle again (back to ON) ...');
  await page.click('#btn-ax');
  await sleep(1000);
  const axText3 = await page.textContent('#btn-ax');
  const axClass3 = await page.getAttribute('#btn-ax', 'class');
  console.log('  After toggle back - AX button:', axText3, '| class:', axClass3);
  await page.screenshot({ path: path.join(OUT, '04_toggle_on.png') });
  console.log('  Screenshot: 04_toggle_on.png');

  // ---- Summary ----------------------------------------------------------
  console.log('\n=== RESULTS ===');
  console.log('xterm rendered:', hasXterm);
  console.log('AX button initial:', axText, axClass);
  console.log('Auto-approved:', approved);
  console.log('AX after OFF:', axText2, axClass2);
  console.log('AX after ON:', axText3, axClass3);
  console.log('Screenshots in:', OUT);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
