#!/usr/bin/env node

const { execSync } = require('child_process');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { connectOverCDP, findPageWithSelector, sleep } = require('./cdp');
const indicator = require('./indicator');

/**
 * Check if another auto_click process is already running.
 * Returns array of { pid, cmd } for matching processes (excluding self).
 */
function findExistingProcesses() {
  try {
    const out = execSync(
      'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const procs = JSON.parse(out);
    const list = Array.isArray(procs) ? procs : [procs];
    const self = process.pid;
    return list.filter(p =>
      p.ProcessId !== self &&
      p.CommandLine &&
      /auto_click\.js/.test(p.CommandLine) &&
      !/--remove/.test(p.CommandLine)
    ).map(p => ({ pid: p.ProcessId, cmd: p.CommandLine.substring(0, 120) }));
  } catch {
    return [];
  }
}

// Shimmer selectors for normal Composer mode.
const SHIMMER_SELECTORS = [
  '.ui-tool-call-line-shimmer',
  '.ui-task-tool-call__shimmer',
  '.ui-collapsible-shimmer',
].join(',');

// Agent mode: tool calls in active state (prompt/filename loading animations).
const AGENT_LOADING_SELECTORS = [
  '.ui-shell-tool-call__prompt--loading',
  '.ui-edit-tool-call__filename--loading',
].join(',');

// Agent mode approval selectors
const AGENT_APPROVAL_SEL = {
  runButton: '.composer-run-button',
  skipButton: '.composer-skip-button',
  allowlistButton: '.composer-tool-call-allowlist-button',
  allowButton: '.view-allow-btn-container .anysphere-button',
};

// ---------------------------------------------------------------------------
// Page interaction helpers
// ---------------------------------------------------------------------------

async function clickOnce(page, { selector, containsText, requireReady, readyAttr }) {
  return await page.evaluate(({ selector, containsText, requireReady, readyAttr }) => {
    const nodes = Array.from(document.querySelectorAll(selector));
    const node = containsText
      ? nodes.find(n => (n.textContent || '').includes(containsText))
      : nodes[0];
    if (!node) return { ok: false, reason: 'not_found' };

    if (requireReady) {
      const dsKey = readyAttr.startsWith('data-') ? readyAttr.slice(5) : readyAttr;
      const camel = dsKey.includes('-') ? dsKey.replace(/-([a-z])/g, (_, c) => c) : dsKey;
      const kebab = dsKey.includes('-') ? dsKey : dsKey.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
      const v =
        node.getAttribute(readyAttr) ??
        node.getAttribute('data-' + kebab) ??
        node.dataset?.[camel];
      if (v !== 'true') return { ok: false, reason: 'not_ready', ready: v ?? null };
    }

    node.scrollIntoView({ block: 'center', inline: 'center' });
    node.click();
    return { ok: true };
  }, { selector, containsText, requireReady, readyAttr });
}

async function detectActivity(page, { selector, containsText, shimmerSelector, agentLoadingSel, agentApprovalSel }) {
  return await page.evaluate(({ selector, containsText, shimmerSelector, agentLoadingSel, agentApprovalSel }) => {
    const btnNodes = Array.from(document.querySelectorAll(selector));
    const hasRun = containsText
      ? btnNodes.some(n => (n.textContent || '').includes(containsText))
      : btnNodes.length > 0;
    const hasShimmer = document.querySelectorAll(shimmerSelector).length > 0;
    const bar = document.querySelector('.composer-bar[data-composer-status]');
    const composerStatus = bar?.dataset?.composerStatus ?? null;
    const headers = document.querySelectorAll('.composer-tool-call-top-header');
    const hasRunningCmd = Array.from(headers).some(h =>
      /^Runn?(?:ing)? command:/i.test((h.textContent || '').trim())
    );

    const isAgent = document.body.classList.contains('agent-unification-enabled')
      || !!document.querySelector('.composer-unified-dropdown[data-mode="agent"]');
    const hasAgentLoading = agentLoadingSel
      ? document.querySelectorAll(agentLoadingSel).length > 0
      : false;
    const toolStatuses = Array.from(document.querySelectorAll('[data-tool-status]'))
      .map(el => el.getAttribute('data-tool-status'));
    const hasToolLoading = toolStatuses.includes('loading');
    const hasSkipButton = !!document.querySelector(agentApprovalSel?.skipButton || '.composer-skip-button');
    const hasAllowlistButton = !!document.querySelector(agentApprovalSel?.allowlistButton || '.composer-tool-call-allowlist-button');
    const allowBtnSel = agentApprovalSel?.allowButton || '.view-allow-btn-container .anysphere-button';
    const hasAllowButton = !!document.querySelector(allowBtnSel);
    const hasAgentRunButton = isAgent && btnNodes.length > 0;
    const hasAgentApproval = isAgent && (hasSkipButton || hasAllowlistButton || hasAgentRunButton)
      || hasAllowButton;

    return {
      hasRun, hasShimmer, composerStatus, hasRunningCmd,
      isAgent, hasAgentLoading, hasToolLoading,
      hasSkipButton, hasAllowlistButton, hasAllowButton, hasAgentApproval,
    };
  }, { selector, containsText, shimmerSelector, agentLoadingSel, agentApprovalSel });
}

async function scrollChatToBottom(page) {
  await page.evaluate(() => {
    for (const c of document.querySelectorAll(
      '.composer-messages-container, [class*=conversations] .monaco-scrollable-element'
    )) c.scrollTop = c.scrollHeight;
    for (const s of document.querySelectorAll('.auxiliarybar .monaco-scrollable-element > div'))
      s.scrollTop = s.scrollHeight;
  });
}

// ---------------------------------------------------------------------------
// Chat tab helpers
// ---------------------------------------------------------------------------

function chatTabFilter(t) {
  if (t.closest('.tabs-container')) return false;
  if (t.closest('.panel .composite-bar')) return false;
  if (t.closest('.composite.bar')) return false;
  if (t.closest('.activitybar')) return false;
  return true;
}

async function listChatTabs(page, tabSelector) {
  return await page.evaluate((sel) => {
    const chatTabFilter = (t) => {
      if (t.closest('.tabs-container')) return false;
      if (t.closest('.panel .composite-bar')) return false;
      if (t.closest('.composite.bar')) return false;
      if (t.closest('.activitybar')) return false;
      return true;
    };
    const tabs = sel
      ? Array.from(document.querySelectorAll(sel))
      : Array.from(document.querySelectorAll('[role="tab"]')).filter(chatTabFilter);
    return tabs.map((t, i) => ({
      index: i,
      label: (t.getAttribute('aria-label') || t.textContent || '').trim().substring(0, 50),
      selected: t.getAttribute('aria-selected') === 'true',
    }));
  }, tabSelector);
}

async function clickChatTab(page, tabSelector, index) {
  return await page.evaluate(({ sel, idx }) => {
    const chatTabFilter = (t) => {
      if (t.closest('.tabs-container')) return false;
      if (t.closest('.panel .composite-bar')) return false;
      if (t.closest('.composite.bar')) return false;
      if (t.closest('.activitybar')) return false;
      return true;
    };
    const tabs = sel
      ? Array.from(document.querySelectorAll(sel))
      : Array.from(document.querySelectorAll('[role="tab"]')).filter(chatTabFilter);
    if (idx >= tabs.length) return { ok: false, reason: 'out_of_range', total: tabs.length };
    tabs[idx].click();
    return {
      ok: true,
      total: tabs.length,
      index: idx,
      label: (tabs[idx].getAttribute('aria-label') || tabs[idx].textContent || '').trim().substring(0, 50),
    };
  }, { sel: tabSelector, idx: index });
}

// ---------------------------------------------------------------------------
// TabScheduler — priority-based scheduling with adaptive wait times
// ---------------------------------------------------------------------------

class TabScheduler {
  constructor({ baseWaitMs = 3000, maxWaitMs = 60000, stepMs = 5000 }) {
    this.baseWaitMs = baseWaitMs;
    this.maxWaitMs = maxWaitMs;
    this.stepMs = stepMs;
    this.tabs = new Map();
    this.lastSwitchAt = 0;
  }

  sync(tabList) {
    const now = Date.now();
    const oldTabs = this.tabs;
    const newTabs = new Map();

    for (const t of tabList) {
      let existing = oldTabs.get(t.index);

      if (!existing || existing.label !== t.label) {
        for (const [k, v] of oldTabs) {
          if (v.label === t.label && !newTabs.has(k)) {
            existing = v;
            break;
          }
        }
      }

      if (existing) {
        existing.label = t.label;
        newTabs.set(t.index, existing);
      } else {
        newTabs.set(t.index, {
          label: t.label,
          waitMs: this.baseWaitMs,
          nextCheckAt: now + this.baseWaitMs * (t.index + 1),
          lastActivity: 0,
          consecutiveIdle: 0,
        });
      }
    }

    this.tabs = newTabs;
  }

  report(index, activity) {
    const s = this.tabs.get(index);
    if (!s) return;
    const now = Date.now();

    const active = activity.hasRun || activity.hasShimmer
      || activity.composerStatus === 'generating' || activity.hasRunningCmd
      || activity.hasAgentApproval || activity.hasAgentLoading
      || (activity.hasToolLoading && activity.composerStatus !== 'completed');
    if (active) {
      s.waitMs = this.baseWaitMs;
      s.lastActivity = now;
      s.consecutiveIdle = 0;
    } else {
      s.consecutiveIdle++;
      s.waitMs = Math.min(s.waitMs + this.stepMs, this.maxWaitMs);
    }
    s.nextCheckAt = now + s.waitMs;
    this.lastSwitchAt = now;
  }

  /**
   * waitMs = check period — each tab must be checked at least once per waitMs.
   * Among due/overdue tabs, pick the one that has been neglected the longest
   * (largest `now - nextCheckAt`). This guarantees every tab gets its turn.
   * If none due, wait until the soonest one becomes due.
   * Enforces at least baseWaitMs between any two switches.
   */
  pickNext() {
    const now = Date.now();
    const earliest = Math.max(this.lastSwitchAt + this.baseWaitMs, now);

    let bestOverdue = null;
    let bestOverdueBy = -1;
    let soonest = null;
    let soonestTime = Infinity;

    for (const [index, s] of this.tabs) {
      if (s.nextCheckAt <= earliest) {
        const overdueBy = earliest - s.nextCheckAt;
        if (overdueBy > bestOverdueBy) {
          bestOverdueBy = overdueBy;
          bestOverdue = index;
        }
      }
      if (s.nextCheckAt < soonestTime) {
        soonestTime = s.nextCheckAt;
        soonest = index;
      }
    }

    if (bestOverdue !== null) {
      const s = this.tabs.get(bestOverdue);
      return { index: bestOverdue, waitUntil: earliest, label: s.label, waitMs: s.waitMs };
    }
    if (soonest !== null) {
      const s = this.tabs.get(soonest);
      return { index: soonest, waitUntil: Math.max(soonestTime, earliest), label: s.label, waitMs: s.waitMs };
    }
    return null;
  }

  statusLine() {
    return Array.from(this.tabs)
      .map(([i, s]) => `[${i}] ${(s.waitMs / 1000).toFixed(0)}s idle:${s.consecutiveIdle} "${s.label}"`)
      .join('  |  ');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('host', { type: 'string', default: '127.0.0.1' })
    .option('port', { type: 'number', default: 9222 })
    .option('selector', { type: 'string', default: '.composer-run-button' })
    .option('contains', { type: 'string', default: '' })
    .option('once', { type: 'boolean', default: false })
    .option('interval', { type: 'number', default: 3000 })
    .option('timeout', { type: 'number', default: 15000 })
    .option('require-ready', { type: 'boolean', default: true })
    .option('ready-attr', { type: 'string', default: 'data-click-ready' })
    .option('scan-tabs', { type: 'boolean', default: false, describe: 'Cycle through AI chat tabs with smart scheduling' })
    .option('tab-selector', { type: 'string', default: '', describe: 'CSS selector for chat tabs (auto-detect if empty)' })
    .option('tab-settle-ms', { type: 'number', default: 500, describe: 'Wait ms after switching tab before probing' })
    .option('verbose', { type: 'boolean', default: false })
    .option('force', { type: 'boolean', default: false, describe: 'Skip duplicate process check' })
    .help()
    .argv;

  if (!argv.force) {
    const existing = findExistingProcesses();
    if (existing.length > 0) {
      console.error('WARNING: Found existing auto_click process(es):');
      existing.forEach(p => console.error(`  PID ${p.pid}: ${p.cmd}`));
      console.error('Running multiple instances will conflict. Use --force to override, or stop the existing process first.');
      process.exit(1);
    }
  }

  const { browser, context } = await connectOverCDP({ host: argv.host, port: argv.port });

  let closing = false;
  let activePage = null;

  async function closeAll(code = 0) {
    if (closing) return;
    closing = true;
    if (activePage) { try { await indicator.remove(activePage); } catch {} }
    try { await browser.close(); } catch {}
    process.exit(code);
  }

  process.on('SIGTERM', () => closeAll(0));
  process.on('SIGINT', () => closeAll(0));

  const scanTabs = argv['scan-tabs'];
  const tabSel = argv['tab-selector'] || '';
  const settleMs = argv['tab-settle-ms'];

  const page = await findPageWithSelector(context, {
    selector: '.monaco-workbench',
    timeoutMs: argv.timeout,
  });

  if (!page) {
    console.error('ERROR: Could not find Cursor workbench page.');
    console.error('Tip: make sure Cursor/VS Code was started with --remote-debugging-port.');
    await closeAll(1);
  }
  activePage = page;

  const clickOpts = {
    selector: argv.selector,
    containsText: argv.contains || undefined,
    requireReady: argv['require-ready'],
    readyAttr: argv['ready-attr'],
  };

  const activityOpts = {
    selector: argv.selector,
    containsText: argv.contains || undefined,
    shimmerSelector: SHIMMER_SELECTORS,
    agentLoadingSel: AGENT_LOADING_SELECTORS,
    agentApprovalSel: AGENT_APPROVAL_SEL,
  };

  // -- once mode --
  if (argv.once) {
    if (scanTabs) {
      const tabs = await listChatTabs(page, tabSel);
      if (argv.verbose) console.log(`Found ${tabs.length} chat tab(s):`, tabs.map(t => t.label));
      for (let i = 0; i < tabs.length; i++) {
        const sw = await clickChatTab(page, tabSel, i);
        if (argv.verbose) console.log(`  Tab ${i}/${tabs.length}: ${sw.label}`);
        await sleep(settleMs);
        const r = await clickOnce(page, clickOpts);
        if (r.ok) {
          if (argv.verbose) console.log(`  Clicked OK on tab: ${sw.label}`);
          await closeAll(0);
        }
      }
      console.error('Button not found on any tab');
      await closeAll(2);
    }
    const r = await clickOnce(page, clickOpts);
    if (!r.ok) { console.error('Click failed:', r); await closeAll(2); }
    if (argv.verbose) console.log('Clicked once OK');
    await closeAll(0);
  }

  // -- unified watch/scan loop with runtime mode switching --
  const initialMode = scanTabs ? 'scan' : 'watch';
  const schedulerConfig = { baseWaitMs: 3000, maxWaitMs: 300000, stepMs: 50000 };
  let scheduler = new TabScheduler(schedulerConfig);

  try { await indicator.inject(page, initialMode); } catch (e) {
    if (argv.verbose) console.log('Indicator injection failed (non-fatal):', e.message);
  }

  if (argv.verbose) {
    console.log(`Auto-click loop started (mode: ${initialMode}). Press Ctrl+C to stop.`);
  }

  async function sleepInterruptible(waitMs, expectedMode) {
    let remain = Math.max(0, Number(waitMs) || 0);
    while (remain > 0) {
      const chunk = Math.min(remain, 500);
      await sleep(chunk);
      remain -= chunk;
      let status;
      try {
        status = await indicator.poll(page);
      } catch {
        return { interrupted: true, disconnected: true };
      }
      if (!status.exists) {
        return { interrupted: true, disconnected: true };
      }
      if (status.paused || status.mode !== expectedMode) {
        return { interrupted: true, paused: status.paused, mode: status.mode };
      }
    }
    return { interrupted: false, paused: false, mode: expectedMode };
  }

  let prevMode = initialMode;
  let wasPaused = false;
  let pausedShownMode = null;
  let lastCheckedTab = -1;

  while (true) {
    let status;
    try {
      status = await indicator.poll(page);
    } catch {
      if (argv.verbose) console.log('Page disconnected during poll.');
      break;
    }
    if (!status.exists) {
      if (argv.verbose) console.log('Indicator removed externally.');
      break;
    }
    const mode = status.mode;
    const paused = status.paused;

    if (paused) {
      const pausedLabel = mode === 'scan' ? 'SCAN: paused' : 'WATCH: paused';
      if (!wasPaused || pausedShownMode !== mode) {
        try { await indicator.update(page, 'paused', pausedLabel); } catch {}
        if (argv.verbose) console.log(`[PAUSE] ${mode}`);
        pausedShownMode = mode;
      }
      wasPaused = true;
      await sleep(Math.min(Math.max(argv.interval, 500), 1500));
      continue;
    }

    if (wasPaused) {
      wasPaused = false;
      pausedShownMode = null;
      if (mode === 'scan') {
        scheduler = new TabScheduler(schedulerConfig);
        lastCheckedTab = -1;
      }
      try {
        await indicator.update(page, 'init', mode === 'scan' ? 'SCAN: resumed' : 'WATCH: resumed');
      } catch {}
      if (argv.verbose) console.log(`[RESUME] ${mode}`);
      await sleep(settleMs);
    }

    if (mode !== prevMode) {
      const label = mode === 'scan' ? 'SCAN: init' : 'WATCH: init';
      try { await indicator.update(page, 'init', label); } catch {}
      if (argv.verbose) console.log(`[MODE] ${prevMode} → ${mode}`);
      if (mode === 'scan') scheduler = new TabScheduler(schedulerConfig);
      lastCheckedTab = -1;
      prevMode = mode;
      await sleep(settleMs);
    }

    try {

    if (mode === 'scan') {
      // === SCAN MODE ===
      scheduler.sync(await listChatTabs(page, tabSel));

      const pick = scheduler.pickNext();
      if (!pick) { await sleep(1000); continue; }

      const sameTab = pick.index === lastCheckedTab;

      const delay = pick.waitUntil - Date.now();
      if (delay > 0) {
        const waitResult = await sleepInterruptible(delay, mode);
        if (waitResult.disconnected) break;
        if (waitResult.interrupted) continue;
      }

      if (!sameTab) {
        try { await indicator.update(page, 'init', `SCAN: [${pick.index}] ${pick.label}`); } catch {}

        const sw = await clickChatTab(page, tabSel, pick.index);
        if (!sw.ok) {
          if (argv.verbose) console.log(`Tab ${pick.index} switch failed: ${sw.reason}`);
          continue;
        }
        await sleep(settleMs);
        try { await scrollChatToBottom(page); } catch {}
      }

      lastCheckedTab = pick.index;

      const activity = await detectActivity(page, activityOpts);
      scheduler.report(pick.index, activity);

      const isGen = activity.composerStatus === 'generating';
      const isActive = activity.hasShimmer || isGen || activity.hasAgentLoading
        || (activity.hasToolLoading && activity.composerStatus !== 'completed');
      const tag = activity.hasRun ? 'RUN'
        : activity.hasAgentApproval ? 'APPROVE'
        : activity.hasRunningCmd ? 'RUN'
        : isActive ? 'SHIMMER' : 'idle';
      try {
        if (activity.hasRun || activity.hasRunningCmd || activity.hasAgentApproval) {
          await indicator.update(page, 'clicked', `SCAN: ${tag} [${pick.index}]`);
        } else if (isActive) {
          await indicator.update(page, 'shimmer', `SCAN: SHIMMER [${pick.index}]`);
        } else {
          const sec = (scheduler.tabs.get(pick.index)?.waitMs / 1000).toFixed(0);
          await indicator.update(page, 'scanning', `SCAN: idle [${pick.index}] ${sec}s`);
        }
      } catch {}

      if (argv.verbose) {
        const sec = (scheduler.tabs.get(pick.index)?.waitMs / 1000).toFixed(0);
        console.log(`[${tag}] tab ${pick.index} "${pick.label}" next:${sec}s  |  ${scheduler.statusLine()}`);
      }

      if (activity.hasRun) {
        const r = await clickOnce(page, clickOpts);
        if (argv.verbose) console.log(r.ok ? '  >> Clicked OK' : `  >> Click failed: ${r.reason}`);
      } else if (activity.hasAllowButton) {
        const r = await clickOnce(page, {
          selector: AGENT_APPROVAL_SEL.allowButton,
          requireReady: clickOpts.requireReady,
          readyAttr: clickOpts.readyAttr,
        });
        if (argv.verbose) console.log(r.ok ? '  >> Allow clicked' : `  >> Allow click failed: ${r.reason}`);
      } else if (activity.hasAgentApproval) {
        const r = await clickOnce(page, { ...clickOpts, containsText: undefined });
        if (argv.verbose) console.log(r.ok ? '  >> Agent approved' : `  >> Agent approve failed: ${r.reason}`);
      }

    } else {
      // === WATCH MODE ===
      const activity = await detectActivity(page, activityOpts);
      const isGen = activity.composerStatus === 'generating';
      const isActive = activity.hasShimmer || isGen || activity.hasAgentLoading
        || (activity.hasToolLoading && activity.composerStatus !== 'completed');
      const tag = activity.hasRun ? 'RUN'
        : activity.hasAgentApproval ? 'APPROVE'
        : activity.hasRunningCmd ? 'RUN'
        : isActive ? 'SHIMMER' : 'idle';

      try {
        if (activity.hasRun || activity.hasRunningCmd || activity.hasAgentApproval) {
          await indicator.update(page, 'clicked', `WATCH: ${tag}`);
        } else if (isActive) {
          await indicator.update(page, 'shimmer', 'WATCH: SHIMMER');
        } else {
          await indicator.update(page, 'scanning', 'WATCH: idle');
        }
      } catch {}

      if (activity.hasRun) {
        const r = await clickOnce(page, clickOpts);
        if (argv.verbose) console.log(`[${tag}] ${r.ok ? 'Clicked OK' : 'Click failed: ' + r.reason}`);
      } else if (activity.hasAllowButton) {
        const r = await clickOnce(page, {
          selector: AGENT_APPROVAL_SEL.allowButton,
          requireReady: clickOpts.requireReady,
          readyAttr: clickOpts.readyAttr,
        });
        if (argv.verbose) console.log(`[${tag}] ${r.ok ? 'Allow clicked' : 'Allow click failed: ' + r.reason}`);
      } else if (activity.hasAgentApproval) {
        const r = await clickOnce(page, { ...clickOpts, containsText: undefined });
        if (argv.verbose) console.log(`[${tag}] ${r.ok ? 'Agent approved' : 'Agent approve failed: ' + r.reason}`);
      } else if (argv.verbose && tag !== 'idle') {
        console.log(`[${tag}]`);
      }

      const waitResult = await sleepInterruptible(argv.interval, mode);
      if (waitResult.disconnected) break;
      if (waitResult.interrupted) continue;
    }

    } catch (e) {
      const msg = e?.message || String(e);
      if (/closed|destroyed|disposed|disconnected/i.test(msg)) {
        if (argv.verbose) console.log('Page disconnected during loop.');
        break;
      }
      throw e;
    }
  }

  await closeAll(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
