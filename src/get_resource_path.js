#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const os = require('os');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { connectOverCDP } = require('./cdp');

/** Known Cursor / VS Code installation roots per platform */
function candidateAppRoots() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(local, 'Programs', 'cursor',               'resources', 'app'),
      path.join(local, 'Programs', 'Microsoft VS Code',    'resources', 'app'),
      path.join(local, 'Programs', 'VSCodium',             'resources', 'app'),
      'C:\\Program Files\\Cursor\\resources\\app',
      'C:\\Program Files\\Microsoft VS Code\\resources\\app',
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Cursor.app/Contents/Resources/app',
      path.join(home, 'Applications/Cursor.app/Contents/Resources/app'),
      '/Applications/Visual Studio Code.app/Contents/Resources/app',
    ];
  }
  // Linux
  return [
    path.join(home, '.local/share/cursor/resources/app'),
    '/opt/cursor/resources/app',
    '/usr/share/cursor/resources/app',
    '/usr/lib/cursor/resources/app',
    '/usr/share/code/resources/app',
    '/opt/visual-studio-code/resources/app',
  ];
}

/** Try process.resourcesPath in every page (works when nodeIntegration is on) */
async function cdpResourcesPath(context) {
  for (const page of context.pages()) {
    try {
      const r = await page.evaluate(() => {
        if (typeof process !== 'undefined' && process.resourcesPath)
          return String(process.resourcesPath);
        return null;
      });
      if (r) return r;
    } catch { /* skip */ }
  }
  return null;
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('host', { type: 'string', default: '127.0.0.1' })
    .option('port', { type: 'number', default: 9222 })
    .help()
    .argv;

  // Strategy 1: well-known installation paths (fast, no CDP needed)
  for (const appRoot of candidateAppRoots()) {
    if (fs.existsSync(appRoot)) {
      const resourcesPath = path.dirname(appRoot);
      console.log(JSON.stringify({ ok: true, resourcesPath, appRoot, source: 'known-path' }));
      return;
    }
  }

  // Strategy 2: ask Electron renderer via CDP
  const { browser, context } = await connectOverCDP({ host: argv.host, port: argv.port });
  try {
    const resourcesPath = await cdpResourcesPath(context);
    if (resourcesPath) {
      const appRoot = path.join(resourcesPath, 'app');
      console.log(JSON.stringify({ ok: true, resourcesPath, appRoot, source: 'cdp-eval' }));
      return;
    }
    throw new Error(
      'appRoot not found in known paths and process.resourcesPath unavailable via CDP.\n' +
      'Set CURSOR_APP_ROOT env var to the app directory (e.g. .../resources/app) to override.'
    );
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(JSON.stringify({ ok: false, error: String(e?.message || e) }) + '\n');
  process.exit(1);
});
