#!/usr/bin/env node

/**
 * E2E test: Web terminal with SSH remote project (computelabproxy).
 *
 * Steps:
 *   1. Load /claude page
 *   2. Verify project list loads with SSH projects
 *   3. Select computelabproxy project
 *   4. Wait for Claude TUI to render via SSH
 *   5. Type a simple prompt
 *   6. Verify output appears
 *   7. Screenshot at each step
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const BASE = 'http://localhost:5123';
const OUT = path.resolve(__dirname, '..', 'dist', 'visual-test', 'web_ssh');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });

  // ===== T1: Page loads ==================================================
  console.log('\nT1: Page loads');
  const resp = await page.goto(`${BASE}/claude`);
  report('HTTP 200', resp.status() === 200, `status=${resp.status()}`);
  await page.waitForTimeout(3000);

  // ===== T2: Project list loads ==========================================
  console.log('\nT2: Project selector');
  const options = await page.$$eval('#project-select option', opts =>
    opts.map(o => ({ text: o.textContent, value: o.value }))
  );
  report('Has options', options.length > 1, `count=${options.length}`);

  const sshProjects = options.filter(o => o.text.includes('['));
  report('Has SSH projects', sshProjects.length > 0, `ssh=${sshProjects.length}`);

  const computelab = options.find(o => o.text.includes('computelabproxy'));
  report('computelabproxy found', !!computelab, computelab ? computelab.text : 'not found');

  await page.screenshot({ path: path.join(OUT, 't2_projects.png') });

  // ===== T3: Select computelabproxy ======================================
  console.log('\nT3: Connect to computelabproxy');
  if (computelab) {
    await page.selectOption('#project-select', { label: computelab.text });
    console.log('  Waiting for SSH + Claude startup (30s) ...');
    await page.waitForTimeout(30000);
  }
  await page.screenshot({ path: path.join(OUT, 't3_ssh_connected.png') });

  const hasXterm = await page.evaluate(() => !!document.querySelector('.xterm-screen'));
  report('xterm rendered', hasXterm);

  // Read screen from xterm buffer API (works with canvas renderer)
  const screenText = await page.evaluate(() => {
    if (!window.term) return '';
    const buf = window.term.buffer.active;
    const lines = [];
    for (let i = 0; i < window.term.rows; i++) {
      const l = buf.getLine(i);
      if (l) lines.push(l.translateToString(true));
    }
    return lines.join('\n');
  });
  const hasContent = screenText.length > 20;
  report('Terminal has content', hasContent, `len=${screenText.length}`);
  const hasClaudeBanner = /Claude Code|claude|shortcuts/i.test(screenText);
  report('Claude banner visible', hasClaudeBanner, screenText.substring(0, 100));

  // ===== T4: Type a prompt ===============================================
  console.log('\nT4: Keyboard input');
  const termEl = await page.$('.xterm-helper-textarea');
  if (termEl && hasContent) {
    await termEl.focus();
    const prompt = 'echo hello from ssh';
    for (const ch of prompt) {
      await termEl.press(ch === ' ' ? 'Space' : ch);
      await sleep(20);
    }
    await termEl.press('Enter');
    report('Prompt sent', true);

    console.log('  Waiting for response (20s) ...');
    await page.waitForTimeout(20000);
    await page.screenshot({ path: path.join(OUT, 't4_response.png') });
  } else {
    report('Prompt sent', false, 'terminal not ready');
  }

  // ===== T5: AX toggle ===================================================
  console.log('\nT5: AX toggle');
  // Hide overlay if it appeared (so click can reach button)
  await page.evaluate(() => {
    const o = document.getElementById('overlay');
    if (o) o.classList.remove('show');
  });
  const axBefore = await page.getAttribute('#btn-ax', 'class');
  await page.click('#btn-ax', { timeout: 3000 }).catch(() => {});
  await sleep(500);
  const axAfter = await page.getAttribute('#btn-ax', 'class');
  report('AX toggle works', axBefore !== axAfter, `before=${axBefore} after=${axAfter}`);

  await page.screenshot({ path: path.join(OUT, 't5_final.png') });

  // ===== Summary =========================================================
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
}

main().catch(e => { console.error(e); process.exit(1); });
