const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const OUT = path.resolve(__dirname, '..', 'dist', 'visual-test', 'web_final');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: true });

  // === Test 1: Local (cursor_auto) ===
  console.log('=== T1: LOCAL cursor_auto ===');
  const p1 = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await p1.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);

  const localTab = p1.locator('.tab', { hasText: 'cursor_auto' });
  if (await localTab.count()) {
    await localTab.click();
    await sleep(2000);
    await p1.locator('#btn-connect').click();
    console.log('  Starting local claude...');
    await sleep(18000);
    await p1.screenshot({ path: path.join(OUT, 't1_local.png') });
    console.log('  t1_local.png');

    // Check screen content
    const text1 = await p1.evaluate(() => {
      if (!window.term) return '';
      const buf = window.term.buffer.active;
      const lines = [];
      for (let i = 0; i < window.term.rows; i++) {
        const l = buf.getLine(i);
        if (l) lines.push(l.translateToString(true));
      }
      return lines.join('\n');
    });
    const hasLocalBanner = /Claude Code|cursor_auto/i.test(text1);
    console.log('  Banner OK:', hasLocalBanner);
    const hasJson = /\{"type"/.test(text1);
    console.log('  No JSON leak:', !hasJson);
  }
  await p1.close();

  // === Test 2: SSH (ap0 via ProxyJump) ===
  console.log('\n=== T2: SSH ap0 ===');
  const p2 = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await p2.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);

  const ap0Tab = p2.locator('.tab', { hasText: 'ap0' });
  if (await ap0Tab.count()) {
    await ap0Tab.click();
    await sleep(2000);
    await p2.locator('#btn-connect').click();
    console.log('  Starting SSH claude on ap0...');
    await sleep(30000);
    await p2.screenshot({ path: path.join(OUT, 't2_ssh_ap0.png') });
    console.log('  t2_ssh_ap0.png');

    const text2 = await p2.evaluate(() => {
      if (!window.term) return '';
      const buf = window.term.buffer.active;
      const lines = [];
      for (let i = 0; i < window.term.rows; i++) {
        const l = buf.getLine(i);
        if (l) lines.push(l.translateToString(true));
      }
      return lines.join('\n');
    });
    const hasSshBanner = /Claude Code|xiaochent/i.test(text2);
    console.log('  Banner OK:', hasSshBanner);
    const hasJson2 = /\{"type"/.test(text2);
    console.log('  No JSON leak:', !hasJson2);
    const hasMotd = /Welcome to Ubuntu|Last login/i.test(text2);
    console.log('  No MOTD leak:', !hasMotd);
    console.log('  First 200 chars:', text2.substring(0, 200));
  } else {
    console.log('  ap0 tab not found');
  }
  await p2.close();

  // === Test 3: Switch tabs (no residue) ===
  console.log('\n=== T3: Tab switch - no residue ===');
  const p3 = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await p3.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);

  // Start local first
  const localTab3 = p3.locator('.tab', { hasText: 'cursor_auto' });
  if (await localTab3.count()) {
    await localTab3.click();
    await sleep(1000);
    await p3.locator('#btn-connect').click();
    await sleep(15000);

    // Now switch to ap0 tab
    const ap0Tab3 = p3.locator('.tab', { hasText: 'ap0' });
    if (await ap0Tab3.count()) {
      await ap0Tab3.click();
      await sleep(2000);
      await p3.screenshot({ path: path.join(OUT, 't3_after_switch.png') });
      console.log('  t3_after_switch.png');

      // Check no local residue
      const text3 = await p3.evaluate(() => {
        if (!window.term) return '';
        const buf = window.term.buffer.active;
        const lines = [];
        for (let i = 0; i < window.term.rows; i++) {
          const l = buf.getLine(i);
          if (l) lines.push(l.translateToString(true));
        }
        return lines.join('\n').trim();
      });
      const noResidue = text3.length < 10;
      console.log('  Clean after switch:', noResidue, `(${text3.length} chars)`);
    }
  }
  await p3.close();

  await browser.close();
  console.log('\nDone. Screenshots:', OUT);
})();
