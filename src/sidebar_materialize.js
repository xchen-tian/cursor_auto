'use strict';

const { randomUUID } = require('crypto');
const { sleep } = require('./cdp');

const EMPHASIZED_SUFFIX_RE = /\s+•\s+Contains emphasized items$/;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeExplorerPath(rawPath) {
  return String(rawPath || '').replace(EMPHASIZED_SUFFIX_RE, '').trim();
}

function normalizeRow(raw) {
  const fullPath = normalizeExplorerPath(raw.fullPath || '');
  return {
    label: String(raw.label || '').trim(),
    fullPath,
    key: fullPath || `${raw.label || ''}|${raw.level || 0}|${raw.virtualTop || 0}`,
    virtualTop: Number(raw.virtualTop || 0),
    height: Number(raw.height || 22),
    lineHeight: Number(raw.lineHeight || raw.height || 22),
    level: Number(raw.level || 0),
    selected: !!raw.selected,
    expanded: raw.expanded == null ? null : !!raw.expanded,
    isDirectory: !!raw.isDirectory,
    className: String(raw.className || ''),
    iconClassName: String(raw.iconClassName || ''),
    html: String(raw.html || ''),
  };
}

async function readSidebarState(page) {
  const raw = await page.evaluate(() => {
    const parsePx = (value) => {
      const n = Number.parseFloat(String(value || '').replace('px', ''));
      return Number.isFinite(n) ? n : 0;
    };

    const explorer = document.querySelector('.explorer-folders-view');
    if (!explorer) return { exists: false };

    const scrollable = explorer.querySelector('.monaco-scrollable-element');
    const rowsContainer = explorer.querySelector('.monaco-list-rows');
    const scrollbar = scrollable?.querySelector('.scrollbar.vertical') || null;
    const slider = scrollbar?.querySelector('.slider') || null;
    const explorerRect = explorer.getBoundingClientRect();
    const trackRect = scrollbar?.getBoundingClientRect() || null;
    const sliderRect = slider?.getBoundingClientRect() || null;

    const rows = Array.from(explorer.querySelectorAll('.monaco-list-row')).map((row) => {
      const icon = row.querySelector('.monaco-icon-label');
      return {
        label: (row.getAttribute('aria-label') || row.textContent || '').trim(),
        fullPath: icon?.getAttribute('aria-label') || '',
        virtualTop: parsePx(row.style.top),
        height: parsePx(row.style.height) || row.getBoundingClientRect().height || 22,
        lineHeight: parsePx(row.style.lineHeight) || parsePx(row.style.height) || 22,
        level: Number(row.getAttribute('aria-level') || 0),
        selected: row.getAttribute('aria-selected') === 'true',
        expanded: row.hasAttribute('aria-expanded') ? row.getAttribute('aria-expanded') === 'true' : null,
        isDirectory: row.hasAttribute('aria-expanded'),
        className: row.className || '',
        iconClassName: icon?.className || '',
        html: row.outerHTML,
      };
    });

    return {
      exists: true,
      rowHeight: rows[0]?.height || 22,
      rowsContainerTop: parsePx(rowsContainer?.style.top),
      rowsContainerHeight: parsePx(rowsContainer?.style.height) || rowsContainer?.getBoundingClientRect().height || 0,
      scrollHeight: scrollable?.scrollHeight || 0,
      clientHeight: scrollable?.clientHeight || 0,
      wheelPoint: {
        x: explorerRect.left + Math.min(40, Math.max(20, explorerRect.width / 8)),
        y: explorerRect.top + Math.min(120, Math.max(60, explorerRect.height / 6)),
      },
      slider: {
        exists: !!slider && !!trackRect,
        top: parsePx(slider?.style.top),
        height: parsePx(slider?.style.height) || sliderRect?.height || 0,
        trackTop: trackRect?.top || 0,
        trackHeight: trackRect?.height || 0,
        centerX: sliderRect ? sliderRect.left + sliderRect.width / 2 : 0,
        centerY: sliderRect ? sliderRect.top + sliderRect.height / 2 : 0,
      },
      rows,
    };
  });

  return {
    exists: !!raw.exists,
    rowHeight: Number(raw.rowHeight || 22),
    rowsContainerTop: Number(raw.rowsContainerTop || 0),
    rowsContainerHeight: Number(raw.rowsContainerHeight || 0),
    scroll: {
      height: Number(raw.scrollHeight || 0),
      clientHeight: Number(raw.clientHeight || 0),
      maxScroll: Math.max(0, Number(raw.scrollHeight || 0) - Number(raw.clientHeight || 0)),
    },
    wheelPoint: raw.wheelPoint || { x: 0, y: 0 },
    slider: {
      exists: !!raw.slider?.exists,
      top: Number(raw.slider?.top || 0),
      height: Number(raw.slider?.height || 0),
      trackTop: Number(raw.slider?.trackTop || 0),
      trackHeight: Number(raw.slider?.trackHeight || 0),
      centerX: Number(raw.slider?.centerX || 0),
      centerY: Number(raw.slider?.centerY || 0),
    },
    rows: Array.isArray(raw.rows) ? raw.rows.map(normalizeRow) : [],
  };
}

async function dragSidebarSliderByTop(page, desiredTop, opts = {}) {
  const settleMs = Number(opts.settleMs || 180);
  const tolerancePx = Number(opts.tolerancePx || 2);
  const maxAttempts = Number(opts.maxAttempts || 4);

  let state = await readSidebarState(page);
  if (!state.exists || !state.slider.exists) return state;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (Math.abs(state.slider.top - desiredTop) <= tolerancePx) return state;

    const maxTop = Math.max(0, state.slider.trackHeight - state.slider.height);
    const targetTop = clamp(desiredTop, 0, maxTop);
    const targetY = state.slider.trackTop + targetTop + state.slider.height / 2;

    await page.mouse.move(state.slider.centerX, state.slider.centerY);
    await page.mouse.down();
    await page.mouse.move(state.slider.centerX, targetY, { steps: 12 });
    await page.mouse.up();
    await sleep(settleMs);

    state = await readSidebarState(page);
  }

  return state;
}

async function dragSidebarSliderToEdge(page, edge, opts = {}) {
  const settleMs = Number(opts.settleMs || 180);
  let state = await readSidebarState(page);
  if (!state.exists || !state.slider.exists) return state;

  const targetY = edge === 'bottom'
    ? state.slider.trackTop + state.slider.trackHeight - state.slider.height / 2
    : state.slider.trackTop + state.slider.height / 2;

  await page.mouse.move(state.slider.centerX, state.slider.centerY);
  await page.mouse.down();
  await page.mouse.move(state.slider.centerX, targetY, { steps: 14 });
  await page.mouse.up();
  await sleep(settleMs);

  return readSidebarState(page);
}

function mergeRows(seenRows, rows) {
  for (const row of rows) {
    if (!row.key || seenRows.has(row.key)) continue;
    seenRows.set(row.key, row);
  }
}

async function scanMaterializedSidebar(page, opts = {}) {
  const settleMs = Number(opts.settleMs || 220);
  const overlapRows = Number(opts.overlapRows || 6);
  const maxSamples = Number(opts.maxSamples || 200);
  const startedAt = Date.now();

  const original = await readSidebarState(page);
  if (!original.exists) {
    return {
      ok: false,
      error: 'explorer_not_visible',
      snapshotId: randomUUID(),
      items: [],
      meta: { restored: false, durationMs: Date.now() - startedAt },
    };
  }

  if (!original.slider.exists || original.scroll.maxScroll <= 0) {
    const items = [...original.rows].sort((a, b) => a.virtualTop - b.virtualTop || a.label.localeCompare(b.label));
    return {
      ok: true,
      snapshotId: randomUUID(),
      items,
      meta: {
        restored: true,
        durationMs: Date.now() - startedAt,
        rowHeight: original.rowHeight,
        baseVirtualTop: items[0]?.virtualTop || 0,
        scrollHeight: original.scroll.height,
        clientHeight: original.scroll.clientHeight,
        maxScroll: original.scroll.maxScroll,
        minSliderTop: original.slider.top,
        maxSliderTop: original.slider.top,
        sampleCount: 1,
      },
    };
  }

  const seenRows = new Map();
  let topState = null;
  let bottomState = null;
  let restoredState = null;
  let sampleCount = 0;

  try {
    topState = await dragSidebarSliderToEdge(page, 'top', { settleMs });
    mergeRows(seenRows, topState.rows);
    sampleCount++;

    bottomState = await dragSidebarSliderToEdge(page, 'bottom', { settleMs });
    const minSliderTop = topState.slider.top;
    const maxSliderTop = bottomState.slider.top;
    const maxScroll = topState.scroll.maxScroll;
    const baseVirtualTop = topState.rows[0]?.virtualTop || 0;
    const stepPx = Math.max(
      Math.floor(topState.scroll.clientHeight - topState.rowHeight * overlapRows),
      topState.rowHeight * 8
    );

    if (maxScroll > 0 && maxSliderTop > minSliderTop) {
      await dragSidebarSliderByTop(page, minSliderTop, { settleMs });
      for (let offset = stepPx; offset < maxScroll && sampleCount < maxSamples; offset += stepPx) {
        const ratio = offset / maxScroll;
        const targetTop = minSliderTop + ratio * (maxSliderTop - minSliderTop);
        const state = await dragSidebarSliderByTop(page, targetTop, { settleMs });
        mergeRows(seenRows, state.rows);
        sampleCount++;
      }
      const finalBottom = await dragSidebarSliderByTop(page, maxSliderTop, { settleMs });
      mergeRows(seenRows, finalBottom.rows);
      sampleCount++;
      bottomState = finalBottom;
    } else {
      mergeRows(seenRows, bottomState.rows);
      sampleCount++;
    }

    restoredState = await dragSidebarSliderByTop(page, original.slider.top, {
      settleMs,
      tolerancePx: 3,
      maxAttempts: 5,
    });

    const items = [...seenRows.values()].sort((a, b) => a.virtualTop - b.virtualTop || a.label.localeCompare(b.label));
    return {
      ok: true,
      snapshotId: randomUUID(),
      items,
      meta: {
        restored: !!restoredState && Math.abs(restoredState.slider.top - original.slider.top) <= 3,
        durationMs: Date.now() - startedAt,
        rowHeight: topState.rowHeight,
        baseVirtualTop,
        scrollHeight: topState.scroll.height,
        clientHeight: topState.scroll.clientHeight,
        maxScroll,
        minSliderTop,
        maxSliderTop: bottomState.slider.top,
        originalSliderTop: original.slider.top,
        sampleCount,
      },
    };
  } catch (error) {
    if (!restoredState && original.slider.exists) {
      try {
        restoredState = await dragSidebarSliderByTop(page, original.slider.top, {
          settleMs,
          tolerancePx: 3,
          maxAttempts: 5,
        });
      } catch {}
    }
    return {
      ok: false,
      error: String(error?.message || error),
      snapshotId: randomUUID(),
      items: [...seenRows.values()].sort((a, b) => a.virtualTop - b.virtualTop || a.label.localeCompare(b.label)),
      meta: {
        restored: !!restoredState && Math.abs(restoredState.slider.top - original.slider.top) <= 3,
        durationMs: Date.now() - startedAt,
        sampleCount,
      },
    };
  }
}

async function revealSidebarPath(page, targetPath, meta = {}, opts = {}) {
  const settleMs = Number(opts.settleMs || 180);
  const normalizedTarget = normalizeExplorerPath(targetPath);
  const targetTop = Number(opts.virtualTop ?? 0);
  const maxAttempts = Number(opts.maxAttempts || 6);

  const matchVisibleRow = async () => page.evaluate((wantedPath) => {
    const normalize = (value) => String(value || '').replace(/\s+•\s+Contains emphasized items$/, '').trim();
    const rows = Array.from(document.querySelectorAll('.explorer-folders-view .monaco-list-row'));
    for (const row of rows) {
      const icon = row.querySelector('.monaco-icon-label');
      const fullPath = normalize(icon?.getAttribute('aria-label') || '');
      if (fullPath !== wantedPath) continue;
      const rect = row.getBoundingClientRect();
      return {
        found: true,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    }
    return { found: false };
  }, normalizedTarget);

  let state = await readSidebarState(page);
  let match = await matchVisibleRow();
  if (match.found) return { ok: true, state, point: match };
  if (!state.slider.exists || !state.scroll.maxScroll) return { ok: false, reason: 'not_found' };

  const baseVirtualTop = Number(meta.baseVirtualTop || 0);
  const maxScroll = Number(meta.maxScroll || state.scroll.maxScroll || 0);
  const minSliderTop = Number(meta.minSliderTop ?? state.slider.top);
  const maxSliderTop = Number(meta.maxSliderTop ?? state.slider.top);

  if (targetTop > 0 && maxScroll > 0 && maxSliderTop > minSliderTop) {
    const desiredScroll = clamp(targetTop - baseVirtualTop - state.rowHeight * 3, 0, maxScroll);
    const ratio = desiredScroll / maxScroll;
    const desiredSliderTop = minSliderTop + ratio * (maxSliderTop - minSliderTop);
    state = await dragSidebarSliderByTop(page, desiredSliderTop, { settleMs });
    match = await matchVisibleRow();
    if (match.found) return { ok: true, state, point: match };
  }

  state = await dragSidebarSliderToEdge(page, 'top', { settleMs });
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    match = await matchVisibleRow();
    if (match.found) return { ok: true, state, point: match };
    await page.mouse.move(state.wheelPoint.x, state.wheelPoint.y);
    await page.mouse.wheel(0, Math.max(state.scroll.clientHeight - state.rowHeight * 6, state.rowHeight * 8));
    await sleep(settleMs);
    const next = await readSidebarState(page);
    if (!next.slider.exists || next.slider.top <= state.slider.top + 1) break;
    state = next;
  }

  return { ok: false, reason: 'not_found' };
}

module.exports = {
  normalizeExplorerPath,
  readSidebarState,
  scanMaterializedSidebar,
  revealSidebarPath,
};
