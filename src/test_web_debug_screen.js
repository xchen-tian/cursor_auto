const { chromium } = require('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.goto('http://localhost:5123/claude?host=127.0.0.1&port=9292');
  await sleep(5000);

  const tab = page.locator('.tab', { hasText: 'cursor_auto' });
  if (await tab.count()) await tab.click();
  await sleep(1500);
  await page.locator('#btn-connect').click();
  await sleep(15000);

  // Type prompt
  const te = page.locator('.xterm-helper-textarea');
  const fname = `test_dbg_${Date.now()}.txt`;
  const prompt = `create ${fname} with text 'ok'`;
  for (const ch of prompt) {
    await te.press(ch === ' ' ? 'Space' : ch);
    await sleep(15);
  }
  await te.press('Enter');
  console.log('Prompt sent:', prompt);

  // Wait for dialog to appear
  await sleep(20000);

  // Debug: dump screen buffer
  const debug = await page.evaluate(() => {
    const t = window.term;
    if (!t) return { error: 'no term' };

    const buf = t.buffer.active;
    const lines = [];
    for (let i = 0; i < t.rows; i++) {
      const l = buf.getLine(i);
      lines.push(l ? l.translateToString(true) : '');
    }
    const screen = lines.join('\n');

    return {
      rows: t.rows,
      cols: t.cols,
      bufferType: buf.type,
      baseY: buf.baseY,
      cursorY: buf.cursorY,
      length: buf.length,
      lineCount: lines.length,
      nonEmptyLines: lines.filter(l => l.trim()).length,
      hasYes: /❯\s*\d+\.\s*Yes/.test(screen),
      hasEscCancel: /Esc to cancel/.test(screen),
      hasDoYouWant: /Do you want to/.test(screen),
      hasEscInterrupt: /esc to interrupt/.test(screen),
      screen: screen,
      last5lines: lines.slice(-5).map((l, i) => `[${t.rows - 5 + i}] ${l}`),
    };
  });

  console.log('\n=== SCREEN BUFFER DEBUG ===');
  console.log('rows:', debug.rows, 'cols:', debug.cols);
  console.log('buffer type:', debug.bufferType, 'baseY:', debug.baseY, 'length:', debug.length);
  console.log('nonEmptyLines:', debug.nonEmptyLines, '/', debug.lineCount);
  console.log('hasYes:', debug.hasYes);
  console.log('hasEscCancel:', debug.hasEscCancel);
  console.log('hasDoYouWant:', debug.hasDoYouWant);
  console.log('hasEscInterrupt:', debug.hasEscInterrupt);
  console.log('\nLast 5 lines:');
  debug.last5lines?.forEach(l => console.log(' ', l));
  console.log('\nFull screen (first 500):');
  console.log(debug.screen?.substring(0, 500));

  await browser.close();
})();
