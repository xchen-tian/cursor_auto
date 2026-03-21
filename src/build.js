#!/usr/bin/env node

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { connectOverCDP, findPageWithSelector, sleep } = require('./cdp');

const SEL = {
  modelDropdown: '.composer-unified-dropdown-model',
  dropdownItem: '.composer-unified-dropdown-item[data-is-model]',
  buildButton: '.composer-create-plan-build-button',
  stopButton: '.send-with-mode .anysphere-icon-button[data-stop-button="true"]',
};

async function getCurrentModel(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const spans = el.querySelectorAll('span');
    for (const s of spans) {
      if (s.classList.contains('codicon')) continue;
      const t = s.textContent?.trim();
      if (t) return t;
    }
    return el.textContent?.trim() || null;
  }, SEL.modelDropdown);
}

async function openModelDropdown(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, SEL.modelDropdown);
}

async function readDropdownModels(page) {
  return page.evaluate((itemSel) => {
    const items = Array.from(document.querySelectorAll(itemSel));
    return items
      .filter(el => el.offsetParent !== null)
      .map(el => {
        const label = el.querySelector('.monaco-highlighted-label');
        const name = label?.textContent?.trim() || el.textContent?.trim() || '';
        const selected = el.hasAttribute('data-is-selected');
        return { name, selected };
      })
      .filter(m => m.name);
  }, SEL.dropdownItem);
}

async function clickModelInDropdown(page, modelName) {
  return page.evaluate(({ itemSel, name }) => {
    const items = Array.from(document.querySelectorAll(itemSel));
    const lower = name.toLowerCase();
    const target = items.find(el => {
      if (!el.offsetParent) return false;
      const label = el.querySelector('.monaco-highlighted-label');
      const t = (label?.textContent?.trim() || el.textContent?.trim() || '').toLowerCase();
      return t === lower || t.includes(lower);
    });
    if (!target) {
      const available = items
        .filter(el => el.offsetParent !== null)
        .map(el => el.querySelector('.monaco-highlighted-label')?.textContent?.trim())
        .filter(Boolean);
      return { ok: false, reason: 'model_not_found', available };
    }
    target.click();
    const selectedName = target.querySelector('.monaco-highlighted-label')?.textContent?.trim()
                      || target.textContent?.trim();
    return { ok: true, model: selectedName };
  }, { itemSel: SEL.dropdownItem, name: modelName });
}

async function clickBuild(page) {
  return page.evaluate(({ buildSel, stopSel }) => {
    const stop = document.querySelector(stopSel);
    if (stop) return { ok: false, reason: 'composer_running', hint: 'Composer is already running (stop button visible)' };

    const els = Array.from(document.querySelectorAll(buildSel));
    const btn = els.find(b => {
      const t = (b.textContent || '').trim();
      return t.includes('Build') || t.includes('Plan');
    });
    if (!btn) return { ok: false, reason: 'build_button_not_found' };
    if (btn.getAttribute('data-disabled') === 'true') return { ok: false, reason: 'disabled' };
    if (btn.getAttribute('data-click-ready') !== 'true') return { ok: false, reason: 'not_ready' };
    btn.scrollIntoView({ block: 'center', inline: 'center' });
    btn.click();
    return { ok: true, buttonText: btn.textContent?.trim() };
  }, { buildSel: SEL.buildButton, stopSel: SEL.stopButton });
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('host', { type: 'string', default: '127.0.0.1' })
    .option('port', { type: 'number', default: 9292 })
    .option('model', { type: 'string', default: '', describe: 'Model to select before building' })
    .option('list-models', { type: 'boolean', default: false, describe: 'List available models and exit' })
    .option('build', { type: 'boolean', default: true, describe: 'Click Build (use --no-build to skip)' })
    .option('timeout', { type: 'number', default: 15000 })
    .option('verbose', { type: 'boolean', default: false })
    .help()
    .argv;

  const { browser, context } = await connectOverCDP({ host: argv.host, port: argv.port });

  let closing = false;
  async function closeAll(code = 0) {
    if (closing) return;
    closing = true;
    try { await browser.close(); } catch {}
    process.exit(code);
  }

  process.on('SIGTERM', () => closeAll(0));
  process.on('SIGINT', () => closeAll(0));

  const page = await findPageWithSelector(context, {
    selector: SEL.modelDropdown,
    timeoutMs: argv.timeout,
  });

  if (!page) {
    console.error('ERROR: Could not find a page with the Composer model dropdown.');
    console.error('Tip: make sure the Cursor Composer is open and visible.');
    await closeAll(1);
  }

  const current = await getCurrentModel(page);
  if (argv.verbose || argv['list-models']) {
    console.log('Current model:', current || '(unknown)');
  }

  if (argv['list-models']) {
    if (!await openModelDropdown(page)) {
      console.error('ERROR: Could not open model dropdown.');
      await closeAll(1);
    }
    await sleep(500);
    const models = await readDropdownModels(page);
    await page.keyboard.press('Escape');
    if (!models.length) {
      console.log('(no models found in dropdown)');
    } else {
      for (const m of models) {
        console.log(`  ${m.selected ? '* ' : '  '}${m.name}`);
      }
    }
    await closeAll(0);
  }

  if (argv.model) {
    const target = argv.model;
    if (current && current.toLowerCase().includes(target.toLowerCase())) {
      if (argv.verbose) console.log('Already using:', current);
    } else {
      if (!await openModelDropdown(page)) {
        console.error('ERROR: Could not open model dropdown.');
        await closeAll(1);
      }
      await sleep(500);
      const r = await clickModelInDropdown(page, target);
      if (!r.ok) {
        console.error('ERROR: Model not found:', r);
        await page.keyboard.press('Escape');
        await closeAll(1);
      }
      if (argv.verbose) console.log('Switched to:', r.model);
      await sleep(300);
    }
  }

  if (argv.build) {
    const r = await clickBuild(page);
    if (!r.ok) {
      console.error('Build failed:', r);
      await closeAll(2);
    }
    if (argv.verbose) console.log('Build clicked');
  }

  await closeAll(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
