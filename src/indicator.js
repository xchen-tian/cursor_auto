/**
 * Visual indicator — inject/update/remove a spinner in the Cursor titlebar.
 *
 * States:
 *   "scanning" — red spinner, scanning tabs
 *   "shimmer"  — orange spinner, activity detected
 *   "clicked"  — green spinner, run button clicked
 */

const INDICATOR_ID = '__cursor_auto_scan_indicator';

const INDICATOR_CSS = [
  '@keyframes __ca_spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}',

  `#${INDICATOR_ID}{` +
    'display:flex;align-items:center;gap:6px;padding:0 8px;width:180px;height:100%;' +
    'flex-shrink:0;margin-left:auto;box-sizing:border-box;overflow:hidden;' +
    'font-family:system-ui,-apple-system,sans-serif;font-size:11px;color:#eee;' +
    'user-select:none;-webkit-app-region:no-drag;' +
    'background:rgba(229,57,53,0.15);border-right:1px solid rgba(229,57,53,0.3)}',

  `#${INDICATOR_ID} .__sp{` +
    'width:14px;height:14px;border-radius:50%;box-sizing:border-box;flex-shrink:0;' +
    'border:2.5px solid rgba(255,255,255,0.15);border-top-color:#e53935;' +
    'animation:__ca_spin 1s linear infinite}',

  `#${INDICATOR_ID}[data-state="clicked"]{background:rgba(67,160,71,0.15);border-right-color:rgba(67,160,71,0.3)}`,
  `#${INDICATOR_ID}[data-state="clicked"] .__sp{border-top-color:#43a047;animation:__ca_spin .6s linear infinite}`,

  `#${INDICATOR_ID}[data-state="shimmer"]{background:rgba(251,140,0,0.15);border-right-color:rgba(251,140,0,0.3)}`,
  `#${INDICATOR_ID}[data-state="shimmer"] .__sp{border-top-color:#fb8c00;animation:__ca_spin .8s linear infinite}`,

  `#${INDICATOR_ID} .__lb{opacity:.85;white-space:nowrap;font-weight:500;overflow:hidden;text-overflow:ellipsis}`,
].join('');

async function inject(page) {
  return await page.evaluate(({ id, css }) => {
    if (document.getElementById(id)) return { ok: true, exists: true };

    const style = document.createElement('style');
    style.id = id + '_style';
    style.textContent = css;
    document.head.appendChild(style);

    const container = document.createElement('div');
    container.id = id;
    container.dataset.state = 'scanning';

    const spinner = document.createElement('div');
    spinner.className = '__sp';
    container.appendChild(spinner);

    const label = document.createElement('span');
    label.className = '__lb';
    label.textContent = 'scan';
    container.appendChild(label);

    const titlebarRight = document.querySelector('.titlebar-right');
    const toolbar = titlebarRight && titlebarRight.querySelector('.action-toolbar-container');
    if (titlebarRight && toolbar) {
      titlebarRight.insertBefore(container, toolbar);
      return { ok: true };
    }
    return { ok: false, reason: 'titlebar not found' };
  }, { id: INDICATOR_ID, css: INDICATOR_CSS });
}

async function update(page, state, text) {
  await page.evaluate(({ id, state, text }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.dataset.state = state;
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

module.exports = { inject, update, remove, INDICATOR_ID };
