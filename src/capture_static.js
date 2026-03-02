#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const cheerio = require('cheerio');
const mime = require('mime-types');

const { connectOverCDP, findPageWithSelector } = require('./cdp');

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function stripCsp($) {
  // Remove meta CSP because it will break offline rendering when served from a website.
  $('meta[http-equiv="Content-Security-Policy"]').remove();
}

function addBanner($, info) {
  const banner = `
  <div style="position:sticky;top:0;z-index:999999;background:#fffbdd;color:#333;border-bottom:1px solid #e6d48c;padding:8px 12px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;font-size:12px;line-height:1.4;">
    <b>Static snapshot</b> captured from Cursor/VS Code workbench at <code>${info.timestamp}</code>. This is a static view; buttons/commands will not work.
  </div>`;
  const body = $('body');
  body.prepend(banner);
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('host', { type: 'string', default: '127.0.0.1' })
    .option('port', { type: 'number', default: 9222 })
    .option('selector', { type: 'string', default: '.monaco-workbench' })
    .option('contains', { type: 'string', default: '' })
    .option('out', { type: 'string', default: path.join('dist', 'capture') })
    .option('embed-images', { type: 'boolean', default: true })
    .option('inline-css', { type: 'boolean', default: true })
    .option('remove-scripts', { type: 'boolean', default: true })
    .option('timeout', { type: 'number', default: 15000 })
    .help()
    .argv;

  const stamp = nowStamp();
  const outDir = path.resolve(argv.out, stamp);
  ensureDir(outDir);

  const { browser, context } = await connectOverCDP({ host: argv.host, port: argv.port });

  const page = await findPageWithSelector(context, {
    selector: argv.selector,
    containsText: argv.contains || undefined,
    timeoutMs: argv.timeout,
  });

  if (!page) {
    console.error('ERROR: Could not find a page containing selector:', argv.selector);
    await browser.close();
    process.exit(1);
  }

  // CDP session for low-level capture
  const client = await context.newCDPSession(page);
  await client.send('Page.enable');

  // 1) Capture MHTML snapshot (best-effort, includes many resources)
  let mhtmlPath = null;
  try {
    const { data } = await client.send('Page.captureSnapshot', { format: 'mhtml' });
    mhtmlPath = path.join(outDir, 'snapshot.mhtml');
    fs.writeFileSync(mhtmlPath, data, 'utf8');
  } catch (e) {
    // Some Electron builds may disable this; still continue with HTML capture.
    fs.writeFileSync(path.join(outDir, 'snapshot_error.txt'), String(e?.stack || e), 'utf8');
  }

  // 2) Screenshot (quick viewing on phone)
  const screenshotPath = path.join(outDir, 'screenshot.png');
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (e) {
    fs.writeFileSync(path.join(outDir, 'screenshot_error.txt'), String(e?.stack || e), 'utf8');
  }

  // 3) DOM HTML capture
  const html = await page.content();
  const info = {
    timestamp: new Date().toISOString(),
    pageTitle: await page.title().catch(() => ''),
    pageUrl: page.url(),
    selector: argv.selector,
    contains: argv.contains || null,
  };

  const $ = cheerio.load(html, { decodeEntities: false });
  stripCsp($);
  addBanner($, info);

  // 4) Build resource map from Page.getResourceTree (URLs -> {frameId,type,mimeType})
  let resMap = new Map();
  try {
    const tree = await client.send('Page.getResourceTree');
    const walk = (frameTree) => {
      const frameId = frameTree.frame.id;
      const resources = frameTree.resources || [];
      for (const r of resources) {
        if (!r?.url) continue;
        resMap.set(r.url, { frameId, type: r.type, mimeType: r.mimeType });
      }
      const children = frameTree.childFrames || [];
      for (const c of children) walk(c);
    };
    walk(tree.frameTree);
  } catch (e) {
    fs.writeFileSync(path.join(outDir, 'resource_tree_error.txt'), String(e?.stack || e), 'utf8');
  }

  const report = {
    ...info,
    outputs: {
      screenshot: 'screenshot.png',
      mhtml: mhtmlPath ? 'snapshot.mhtml' : null,
      html: 'index.html',
    },
    inlinedCss: [],
    embeddedImages: [],
    missingCss: [],
    missingImages: [],
    notes: [],
  };

  const resolveUrl = (raw) => {
    if (!raw) return null;
    try {
      return new URL(raw, page.url()).toString();
    } catch {
      return raw; // custom schemes may not parse, keep as-is
    }
  };

  const getResourceContent = async (absUrl) => {
    const meta = resMap.get(absUrl);
    if (!meta) return null;
    try {
      const { content, base64Encoded } = await client.send('Page.getResourceContent', {
        frameId: meta.frameId,
        url: absUrl,
      });
      return { content, base64Encoded, mimeType: meta.mimeType, type: meta.type };
    } catch {
      return null;
    }
  };

  function decodeResource(res) {
    // CDP returns string; if base64Encoded is true, it's safe to decode as base64.
    if (res.base64Encoded) {
      return Buffer.from(res.content, 'base64');
    }
    // For text-like types, treat as UTF-8.
    const mt = (res.mimeType || '').toLowerCase();
    const isText = mt.startsWith('text/') || mt.includes('json') || mt.includes('xml') || mt.includes('javascript') || mt.includes('css') || mt.includes('html');
    if (isText) {
      return Buffer.from(res.content, 'utf8');
    }
    // Best-effort binary decode. CDP sometimes returns binary-ish data in a latin1 string.
    return Buffer.from(res.content, 'latin1');
  }

  // 5) Inline CSS <link rel=stylesheet>
  if (argv['inline-css']) {
    const links = $('link[rel="stylesheet"]').toArray();
    for (const el of links) {
      const href = $(el).attr('href');
      const abs = resolveUrl(href);
      const res = abs ? await getResourceContent(abs) : null;
      if (res && (res.mimeType?.includes('css') || res.type === 'Stylesheet')) {
        const css = res.base64Encoded ? Buffer.from(res.content, 'base64').toString('utf8') : res.content;
        $(el).replaceWith(`<style data-inlined-from="${escapeHtml(abs)}">\n${css}\n</style>`);
        report.inlinedCss.push(abs);
      } else {
        report.missingCss.push(abs || href || null);
      }
    }
  }

  // 6) Optionally embed <img> as data: URLs
  if (argv['embed-images']) {
    const imgs = $('img[src]').toArray();
    for (const el of imgs) {
      const src = $(el).attr('src');
      const abs = resolveUrl(src);
      const res = abs ? await getResourceContent(abs) : null;
      if (res && (res.type === 'Image' || (res.mimeType && !res.mimeType.includes('html')))) {
        const bin = decodeResource(res);
        const mt = res.mimeType || mime.lookup(abs) || 'application/octet-stream';
        const dataUrl = `data:${mt};base64,${bin.toString('base64')}`;
        $(el).attr('src', dataUrl);
        report.embeddedImages.push(abs);
      } else {
        report.missingImages.push(abs || src || null);
      }
    }
  }

  // 7) Remove scripts for static hosting (otherwise they'll error / need Electron services)
  if (argv['remove-scripts']) {
    const scripts = $('script').toArray();
    if (scripts.length) {
      report.notes.push(`Removed ${scripts.length} <script> tags for static snapshot.`);
    }
    $('script').remove();
  }

  // 8) Write outputs
  const outHtml = $.html({ decodeEntities: false });
  fs.writeFileSync(path.join(outDir, 'index.html'), outHtml, 'utf8');
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  await browser.close();

  console.log('Capture complete:', outDir);
  console.log(' - index.html (static snapshot)');
  console.log(' - screenshot.png');
  if (mhtmlPath) console.log(' - snapshot.mhtml (best-effort)');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
