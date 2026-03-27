#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { connectOverCDP, findPageWithSelector, sleep } = require('./cdp');

const PS_HELPER = path.join(__dirname, '_win32_window.ps1');

function ensurePsHelper() {
  if (!fs.existsSync(PS_HELPER)) {
    throw new Error('Missing helper script: ' + PS_HELPER + '\nPlease ensure _win32_window.ps1 exists in src/');
  }
}

function runPsHelper(args) {
  ensurePsHelper();
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${PS_HELPER}" ${args}`;
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
    return JSON.parse(out.trim());
  } catch (e) {
    return { ok: false, error: e.stderr?.substring(0, 200) || e.message };
  }
}

async function getBrowserPid(browser) {
  try {
    const client = await browser.newBrowserCDPSession();
    const info = await client.send('SystemInfo.getProcessInfo');
    const bp = info.processInfo.find(p => p.type === 'browser');
    return bp ? bp.id : null;
  } catch {
    return null;
  }
}

async function getWindowInfo(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    screenX: window.screenX,
    screenY: window.screenY,
    screenWidth: screen.width,
    screenHeight: screen.height,
    devicePixelRatio: window.devicePixelRatio,
    maximized: !!document.querySelector('.monaco-workbench.maximized'),
  }));
}

/**
 * Get CDP window bounds via Browser.getWindowForTarget.
 * Returns { windowId, bounds } or null.
 */
async function getCdpWindowBounds(browserSession, page, context) {
  try {
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send('Target.getTargetInfo');
    await session.detach();
    const { windowId, bounds } = await browserSession.send('Browser.getWindowForTarget', {
      targetId: targetInfo.targetId,
    });
    return { windowId, bounds };
  } catch {
    return null;
  }
}

/**
 * Set CDP window bounds via Browser.setWindowBounds.
 */
async function setCdpWindowBounds(browserSession, windowId, bounds) {
  await browserSession.send('Browser.setWindowBounds', { windowId, bounds });
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('host', { type: 'string', default: '127.0.0.1' })
    .option('port', { type: 'number', default: 9292 })
    .option('width', { type: 'number', alias: 'w', describe: 'Window width (CSS pixels)' })
    .option('height', { type: 'number', alias: 'h', describe: 'Window height (CSS pixels)' })
    .option('left', { type: 'number', alias: 'x', describe: 'Window X position' })
    .option('top', { type: 'number', alias: 'y', describe: 'Window Y position' })
    .option('center', { type: 'boolean', default: false, describe: 'Center window on screen' })
    .option('maximize', { type: 'boolean', default: false, describe: 'Maximize the window' })
    .option('restore', { type: 'boolean', default: false, describe: 'Restore from maximized' })
    .option('info', { type: 'boolean', default: false, describe: 'Print current window info and exit' })
    .option('settle', { type: 'number', default: 500, describe: 'Wait ms after resize for layout' })
    .option('timeout', { type: 'number', default: 10000 })
    .option('verbose', { type: 'boolean', default: false })
    .example('$0 --info', 'Show current window bounds')
    .example('$0 -w 1920 -h 1080', 'Resize to 1920×1080')
    .example('$0 -w 1280 -h 800 --center', 'Resize and center')
    .example('$0 --maximize', 'Maximize')
    .example('$0 --restore', 'Restore from maximized')
    .help()
    .argv;

  const { browser, context } = await connectOverCDP({ host: argv.host, port: argv.port });

  try {
    const page = await findPageWithSelector(context, {
      selector: '.monaco-workbench',
      timeoutMs: argv.timeout,
    });
    if (!page) {
      console.error('ERROR: Could not find Cursor workbench page.');
      process.exit(1);
    }

    const useWin32 = process.platform === 'win32';
    let pid = null;
    let browserSession = null;
    let windowId = null;

    if (useWin32) {
      pid = await getBrowserPid(browser);
      if (!pid) {
        console.error('ERROR: Could not determine browser PID.');
        process.exit(1);
      }
      if (argv.verbose) console.log('Browser PID:', pid);
    } else {
      browserSession = await browser.newBrowserCDPSession();
      const winInfo = await getCdpWindowBounds(browserSession, page, context);
      if (!winInfo) {
        console.error('ERROR: Could not get window bounds via CDP.');
        process.exit(1);
      }
      windowId = winInfo.windowId;
      if (argv.verbose) console.log('CDP windowId:', windowId, 'bounds:', winInfo.bounds);
    }

    if (argv.info) {
      const webInfo = await getWindowInfo(page);
      if (useWin32) {
        const winInfo = runPsHelper(`-TargetPid ${pid} -Action info`);
        console.log(JSON.stringify({ ok: true, pid, web: webInfo, win32: winInfo }, null, 2));
      } else {
        const cdpInfo = await getCdpWindowBounds(browserSession, page, context);
        console.log(JSON.stringify({ ok: true, web: webInfo, cdp: cdpInfo?.bounds || null }, null, 2));
      }
      return;
    }

    const before = await getWindowInfo(page);
    if (argv.verbose) {
      console.log('Before:', `${before.outerWidth}×${before.outerHeight} maximized=${before.maximized}`);
    }

    if (useWin32) {
      // Windows: use PowerShell helper
      if (argv.maximize) {
        const r = runPsHelper(`-TargetPid ${pid} -Action maximize`);
        if (argv.verbose) console.log('Maximize:', JSON.stringify(r));
      } else if (argv.restore) {
        const r = runPsHelper(`-TargetPid ${pid} -Action restore`);
        if (argv.verbose) console.log('Restore:', JSON.stringify(r));
      } else {
        const dpr = before.devicePixelRatio;
        const physW = argv.width != null ? Math.round(argv.width) : 0;
        const physH = argv.height != null ? Math.round(argv.height) : 0;
        let xArg = '-99999';
        let yArg = '-99999';

        if (argv.center && (physW > 0 || physH > 0)) {
          const screenW = Math.round(before.screenWidth * dpr);
          const screenH = Math.round(before.screenHeight * dpr);
          const finalW = physW > 0 ? physW : Math.round(before.outerWidth * dpr);
          const finalH = physH > 0 ? physH : Math.round(before.outerHeight * dpr);
          xArg = String(Math.max(0, Math.round((screenW - finalW) / 2)));
          yArg = String(Math.max(0, Math.round((screenH - finalH) / 2)));
        } else if (argv.left != null || argv.top != null) {
          if (argv.left != null) xArg = String(argv.left);
          if (argv.top != null) yArg = String(argv.top);
        }

        const r = runPsHelper(`-TargetPid ${pid} -Action resize -W ${physW} -H ${physH} -X ${xArg} -Y ${yArg}`);
        if (argv.verbose) console.log('Resize result:', JSON.stringify(r));
      }
    } else {
      // macOS / Linux: use CDP Browser.setWindowBounds
      if (argv.maximize) {
        await setCdpWindowBounds(browserSession, windowId, { windowState: 'maximized' });
        if (argv.verbose) console.log('Maximize via CDP');
      } else if (argv.restore) {
        await setCdpWindowBounds(browserSession, windowId, { windowState: 'normal' });
        if (argv.verbose) console.log('Restore via CDP');
      } else {
        // First restore from maximized if needed (CDP requires normal state for bounds)
        const cur = await getCdpWindowBounds(browserSession, page, context);
        if (cur?.bounds?.windowState === 'maximized' || cur?.bounds?.windowState === 'fullscreen') {
          await setCdpWindowBounds(browserSession, windowId, { windowState: 'normal' });
          await sleep(200);
        }

        const bounds = {};
        if (argv.width != null) bounds.width = Math.round(argv.width);
        if (argv.height != null) bounds.height = Math.round(argv.height);

        if (argv.center) {
          const finalW = bounds.width || before.outerWidth;
          const finalH = bounds.height || before.outerHeight;
          bounds.left = Math.max(0, Math.round((before.screenWidth - finalW) / 2));
          bounds.top = Math.max(0, Math.round((before.screenHeight - finalH) / 2));
        } else {
          if (argv.left != null) bounds.left = argv.left;
          if (argv.top != null) bounds.top = argv.top;
        }

        if (Object.keys(bounds).length > 0) {
          await setCdpWindowBounds(browserSession, windowId, bounds);
          if (argv.verbose) console.log('Resize via CDP:', bounds);
        }
      }
    }

    await sleep(argv.settle);

    const after = await getWindowInfo(page);
    if (argv.verbose) {
      console.log('After:', `${after.outerWidth}×${after.outerHeight} maximized=${after.maximized}`);
    }

    console.log(JSON.stringify({ ok: true, before, after }));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
