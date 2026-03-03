/**
 * AX status — visual indicator injected into the Cursor titlebar.
 *
 * States:
 *   "init"       — gray spinner, switching tab / mode (initializing)
 *   "scanning"   — red spinner, scanning tabs
 *   "shimmer"    — orange spinner, activity detected
 *   "generating" — green spinner (slow), AI is generating a response
 *   "clicked"    — green spinner (fast), run button clicked
 *   "paused"     — gray-blue, detection paused
 */

const INDICATOR_ID = '__cursor_auto_scan_indicator';
const HEARTBEAT_TIMEOUT_MS = 15000;
const HEARTBEAT_CHECK_MS = 5000;

const INDICATOR_CSS = [
  '@keyframes __ca_spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}',

  `#${INDICATOR_ID}{` +
    'display:flex;align-items:center;gap:6px;padding:0 8px;width:210px;height:100%;' +
    'flex-shrink:0;margin-left:auto;box-sizing:border-box;overflow:hidden;' +
    'font-family:system-ui,-apple-system,sans-serif;font-size:11px;color:#eee;' +
    'user-select:none;-webkit-app-region:no-drag;' +
    'background:rgba(229,57,53,0.15);border-right:1px solid rgba(229,57,53,0.3)}',

  `#${INDICATOR_ID} .__sw{` +
    'display:flex;align-items:center;justify-content:center;' +
    'width:22px;height:16px;border-radius:8px;flex-shrink:0;cursor:pointer;' +
    'font-size:10px;font-weight:700;color:#fff;line-height:1;' +
    'background:#4a7ccc;border:none;padding:0;' +
    '-webkit-app-region:no-drag;pointer-events:auto;position:relative;z-index:1;' +
    'transition:background .15s}',
  `#${INDICATOR_ID} .__sw:hover{filter:brightness(1.2)}`,
  `#${INDICATOR_ID}[data-mode="scan"] .__sw{background:#8855bb}`,

  `#${INDICATOR_ID} .__ps{` +
    'display:flex;align-items:center;justify-content:center;width:18px;height:18px;' +
    'border:none;background:transparent;padding:0;cursor:pointer;flex-shrink:0;' +
    '-webkit-app-region:no-drag;pointer-events:auto;position:relative;z-index:1}',
  `#${INDICATOR_ID} .__ps:hover .__sp{filter:brightness(1.2)}`,

  `#${INDICATOR_ID} .__sp{` +
    'width:14px;height:14px;border-radius:50%;box-sizing:border-box;flex-shrink:0;' +
    'border:2.5px solid rgba(255,255,255,0.15);border-top-color:#e53935;' +
    'animation:__ca_spin 1s linear infinite;position:relative}',

  `#${INDICATOR_ID}[data-state="init"]{background:rgba(158,158,158,0.12);border-right-color:rgba(158,158,158,0.25)}`,
  `#${INDICATOR_ID}[data-state="init"] .__sp{border-top-color:#9e9e9e;animation:__ca_spin 1.5s linear infinite}`,

  `#${INDICATOR_ID}[data-state="clicked"]{background:rgba(67,160,71,0.15);border-right-color:rgba(67,160,71,0.3)}`,
  `#${INDICATOR_ID}[data-state="clicked"] .__sp{border-top-color:#43a047;animation:__ca_spin .6s linear infinite}`,

  `#${INDICATOR_ID}[data-state="generating"]{background:rgba(67,160,71,0.15);border-right-color:rgba(67,160,71,0.3)}`,
  `#${INDICATOR_ID}[data-state="generating"] .__sp{border-top-color:#43a047;animation:__ca_spin 1.2s linear infinite}`,

  `#${INDICATOR_ID}[data-state="shimmer"]{background:rgba(251,140,0,0.15);border-right-color:rgba(251,140,0,0.3)}`,
  `#${INDICATOR_ID}[data-state="shimmer"] .__sp{border-top-color:#fb8c00;animation:__ca_spin .8s linear infinite}`,

  `#${INDICATOR_ID}[data-state="paused"]{background:rgba(120,144,156,0.16);border-right-color:rgba(120,144,156,0.35)}`,
  `#${INDICATOR_ID}[data-state="paused"] .__sp{border-top-color:#90a4ae;animation:none}`,
  `#${INDICATOR_ID}[data-paused="true"] .__sp{border-color:rgba(255,255,255,0.35);border-top-color:rgba(255,255,255,0.35);animation:none}`,
  `#${INDICATOR_ID}[data-paused="true"] .__sp::before{` +
    'content:"\\25B6";position:absolute;left:3px;top:-1px;font-size:10px;line-height:1;color:#fff}',

  `#${INDICATOR_ID} .__lb{opacity:.85;white-space:nowrap;font-weight:500;overflow:hidden;text-overflow:ellipsis}`,
].join('');

async function inject(page, initialMode = 'watch') {
  return await page.evaluate(({ id, css, mode, hbTimeout, hbCheck }) => {
    document.getElementById(id)?.remove();
    document.getElementById(id + '_style')?.remove();
    if (window.__ca_watchdog) clearInterval(window.__ca_watchdog);

    const style = document.createElement('style');
    style.id = id + '_style';
    style.textContent = css;
    document.head.appendChild(style);

    const container = document.createElement('div');
    container.id = id;
    container.dataset.state = 'scanning';
    container.dataset.mode = mode;
    container.dataset.paused = 'false';
    container.dataset.hb = String(Date.now());

    window.__ca_watchdog = setInterval(() => {
      const el = document.getElementById(id);
      if (!el) { clearInterval(window.__ca_watchdog); return; }
      const last = parseInt(el.dataset.hb || '0', 10);
      if (Date.now() - last > hbTimeout) {
        el.remove();
        document.getElementById(id + '_style')?.remove();
        clearInterval(window.__ca_watchdog);
      }
    }, hbCheck);

    const sw = document.createElement('button');
    sw.className = '__sw';
    sw.type = 'button';
    sw.textContent = mode === 'scan' ? 'S' : 'W';
    sw.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const cur = container.dataset.mode;
      const next = cur === 'scan' ? 'watch' : 'scan';
      container.dataset.mode = next;
      sw.textContent = next === 'scan' ? 'S' : 'W';
      if (container.dataset.paused === 'true') {
        const lbl = container.querySelector('.__lb');
        if (lbl) lbl.textContent = next === 'scan' ? 'SCAN: paused' : 'WATCH: paused';
      }
    });
    container.appendChild(sw);

    const pauseBtn = document.createElement('button');
    pauseBtn.className = '__ps';
    pauseBtn.type = 'button';
    const spinner = document.createElement('div');
    spinner.className = '__sp';
    pauseBtn.appendChild(spinner);

    const setPauseUi = (paused) => {
      container.dataset.paused = paused ? 'true' : 'false';
      pauseBtn.title = paused ? 'Resume detection' : 'Pause detection';
      pauseBtn.setAttribute('aria-label', pauseBtn.title);
    };
    setPauseUi(false);

    pauseBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const nextPaused = container.dataset.paused !== 'true';
      setPauseUi(nextPaused);

      const modeTag = container.dataset.mode === 'scan' ? 'SCAN' : 'WATCH';
      const lbl = container.querySelector('.__lb');
      if (nextPaused) {
        container.dataset.state = 'paused';
        if (lbl) lbl.textContent = `${modeTag}: paused`;
      } else {
        container.dataset.state = 'init';
        if (lbl) lbl.textContent = `${modeTag}: resuming`;
      }
    });
    container.appendChild(pauseBtn);

    const label = document.createElement('span');
    label.className = '__lb';
    label.textContent = mode === 'scan' ? 'scan' : 'watch';
    container.appendChild(label);

    const titlebarRight = document.querySelector('.titlebar-right');
    const toolbar = titlebarRight && titlebarRight.querySelector('.action-toolbar-container');
    if (titlebarRight && toolbar) {
      titlebarRight.insertBefore(container, toolbar);
      return { ok: true };
    }
    return { ok: false, reason: 'titlebar not found' };
  }, { id: INDICATOR_ID, css: INDICATOR_CSS, mode: initialMode, hbTimeout: HEARTBEAT_TIMEOUT_MS, hbCheck: HEARTBEAT_CHECK_MS });
}

async function update(page, state, text) {
  await page.evaluate(({ id, state, text }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.dataset.state = state;
    el.dataset.hb = String(Date.now());
    const lbl = el.querySelector('.__lb');
    if (lbl) lbl.textContent = text || 'scan';
  }, { id: INDICATOR_ID, state, text });
}

async function remove(page) {
  return await page.evaluate((id) => {
    const el = document.getElementById(id);
    const style = document.getElementById(id + '_style');
    const found = !!el || !!style;
    el?.remove();
    style?.remove();
    return { ok: true, removed: found };
  }, INDICATOR_ID);
}

async function getMode(page) {
  return await page.evaluate((id) => {
    const el = document.getElementById(id);
    return el?.dataset?.mode || 'watch';
  }, INDICATOR_ID);
}

async function setMode(page, mode) {
  await page.evaluate(({ id, mode }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.dataset.mode = mode;
    const sw = el.querySelector('.__sw');
    if (sw) sw.textContent = mode === 'scan' ? 'S' : 'W';
    const lbl = el.querySelector('.__lb');
    if (lbl && el.dataset.paused === 'true') {
      lbl.textContent = mode === 'scan' ? 'SCAN: paused' : 'WATCH: paused';
    }
  }, { id: INDICATOR_ID, mode });
}

async function poll(page) {
  return await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return { exists: false, paused: false, mode: 'watch' };
    el.dataset.hb = String(Date.now());
    return {
      exists: true,
      paused: el.dataset.paused === 'true',
      mode: el.dataset.mode || 'watch',
    };
  }, INDICATOR_ID);
}

async function peek(page) {
  return await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return { exists: false };
    const hb = parseInt(el.dataset.hb || '0', 10);
    return {
      exists: true,
      state: el.dataset.state || 'unknown',
      mode: el.dataset.mode || 'watch',
      paused: el.dataset.paused === 'true',
      label: el.querySelector('.__lb')?.textContent || '',
      hbAgeMs: Date.now() - hb,
    };
  }, INDICATOR_ID);
}

async function getPaused(page) {
  return await page.evaluate((id) => {
    const el = document.getElementById(id);
    return el?.dataset?.paused === 'true';
  }, INDICATOR_ID);
}

async function setPaused(page, paused) {
  await page.evaluate(({ id, paused }) => {
    const el = document.getElementById(id);
    if (!el) return;
    const next = !!paused;
    el.dataset.paused = next ? 'true' : 'false';
    const pauseBtn = el.querySelector('.__ps');
    if (pauseBtn) {
      const title = next ? 'Resume detection' : 'Pause detection';
      pauseBtn.title = title;
      pauseBtn.setAttribute('aria-label', title);
    }
  }, { id: INDICATOR_ID, paused });
}

module.exports = { inject, update, remove, poll, peek, getMode, setMode, getPaused, setPaused, INDICATOR_ID };
