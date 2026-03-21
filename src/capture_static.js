#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const cheerio = require('cheerio');
const mime = require('mime-types');

const { connectOverCDP, findPageWithSelector, findPageByTargetId, findAllWorkbenchPages, extractProjectName } = require('./cdp');
const { rewriteCssUrls } = require('./css_rewrite');

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

async function capturePage(context, page, outDir, argv) {
  ensureDir(outDir);

  const client = await context.newCDPSession(page);
  await client.send('Page.enable');

  let mhtmlPath = null;
  try {
    const { data } = await client.send('Page.captureSnapshot', { format: 'mhtml' });
    mhtmlPath = path.join(outDir, 'snapshot.mhtml');
    fs.writeFileSync(mhtmlPath, data, 'utf8');
  } catch (e) {
    fs.writeFileSync(path.join(outDir, 'snapshot_error.txt'), String(e?.stack || e), 'utf8');
  }

  const screenshotPath = path.join(outDir, 'screenshot.png');
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (e) {
    fs.writeFileSync(path.join(outDir, 'screenshot_error.txt'), String(e?.stack || e), 'utf8');
  }

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
    outputs: { screenshot: 'screenshot.png', mhtml: mhtmlPath ? 'snapshot.mhtml' : null, html: 'index.html' },
    inlinedCss: [], embeddedImages: [], missingCss: [], missingImages: [], notes: [],
  };

  const resolveUrl = (raw) => {
    if (!raw) return null;
    try { return new URL(raw, page.url()).toString(); } catch { return raw; }
  };

  const getResourceContent = async (absUrl) => {
    const meta = resMap.get(absUrl);
    if (!meta) return null;
    try {
      const { content, base64Encoded } = await client.send('Page.getResourceContent', { frameId: meta.frameId, url: absUrl });
      return { content, base64Encoded, mimeType: meta.mimeType, type: meta.type };
    } catch { return null; }
  };

  function decodeResource(res) {
    if (res.base64Encoded) return Buffer.from(res.content, 'base64');
    const mt = (res.mimeType || '').toLowerCase();
    const isText = mt.startsWith('text/') || mt.includes('json') || mt.includes('xml') || mt.includes('javascript') || mt.includes('css') || mt.includes('html');
    if (isText) return Buffer.from(res.content, 'utf8');
    return Buffer.from(res.content, 'latin1');
  }

  if (argv['inline-css']) {
    const links = $('link[rel="stylesheet"]').toArray();
    for (const el of links) {
      const href = $(el).attr('href');
      const abs = resolveUrl(href);
      const res = abs ? await getResourceContent(abs) : null;
      if (res && (res.mimeType?.includes('css') || res.type === 'Stylesheet')) {
        const css = res.base64Encoded ? Buffer.from(res.content, 'base64').toString('utf8') : res.content;
        const rewritten = rewriteCssUrls(css, abs, '/api/vscode-file');
        $(el).replaceWith(`<style data-inlined-from="${escapeHtml(abs)}">\n${rewritten}\n</style>`);
        report.inlinedCss.push(abs);
      } else {
        report.missingCss.push(abs || href || null);
      }
    }
  }

  $('style').each((_, el) => {
    if ($(el).attr('data-inlined-from')) return;
    const original = $(el).html() || '';
    const rewritten = rewriteCssUrls(original, info.pageUrl, '/api/vscode-file');
    if (rewritten !== original) $(el).html(rewritten);
  });

  if (argv['embed-images']) {
    const imgs = $('img[src]').toArray();
    for (const el of imgs) {
      const src = $(el).attr('src');
      const abs = resolveUrl(src);
      const res = abs ? await getResourceContent(abs) : null;
      if (res && (res.type === 'Image' || (res.mimeType && !res.mimeType.includes('html')))) {
        const bin = decodeResource(res);
        const mt = res.mimeType || mime.lookup(abs) || 'application/octet-stream';
        $(el).attr('src', `data:${mt};base64,${bin.toString('base64')}`);
        report.embeddedImages.push(abs);
      } else {
        report.missingImages.push(abs || src || null);
      }
    }
  }

  if (argv['remove-scripts']) {
    const scripts = $('script').toArray();
    if (scripts.length) report.notes.push(`Removed ${scripts.length} <script> tags for static snapshot.`);
    $('script').remove();
  }

  const outHtml = $.html({ decodeEntities: false });
  fs.writeFileSync(path.join(outDir, 'index.html'), outHtml, 'utf8');
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log('Captured:', outDir);
  console.log(' - index.html, screenshot.png' + (mhtmlPath ? ', snapshot.mhtml' : ''));
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('host', { type: 'string', default: '127.0.0.1' })
    .option('port', { type: 'number', default: 9292 })
    .option('selector', { type: 'string', default: '.monaco-workbench' })
    .option('contains', { type: 'string', default: '' })
    .option('out', { type: 'string', default: path.join('dist', 'capture') })
    .option('embed-images', { type: 'boolean', default: true })
    .option('inline-css', { type: 'boolean', default: true })
    .option('remove-scripts', { type: 'boolean', default: true })
    .option('timeout', { type: 'number', default: 15000 })
    .option('target-id', { type: 'string', default: '', describe: 'Capture a specific window by CDP target ID' })
    .help()
    .argv;

  const stamp = nowStamp();
  const { browser, context } = await connectOverCDP({ host: argv.host, port: argv.port });

  if (argv['target-id']) {
    const page = await findPageByTargetId(context, argv['target-id'], argv.timeout);
    if (!page) {
      console.error('ERROR: Could not find page with target-id:', argv['target-id']);
      await browser.close();
      process.exit(1);
    }
    const outDir = path.resolve(argv.out, stamp);
    await capturePage(context, page, outDir, argv);
  } else {
    const allPages = await findAllWorkbenchPages(context, { timeoutMs: argv.timeout });
    if (allPages.length === 0) {
      console.error('ERROR: No Cursor workbench pages found.');
      await browser.close();
      process.exit(1);
    }

    if (allPages.length === 1) {
      const outDir = path.resolve(argv.out, stamp);
      await capturePage(context, allPages[0].page, outDir, argv);
    } else {
      for (const wp of allPages) {
        const outDir = path.resolve(argv.out, stamp, wp.project);
        console.log(`Capturing window: ${wp.project} (${wp.targetId.substring(0, 8)}...)`);
        await capturePage(context, wp.page, outDir, argv);
      }
    }
  }

  await browser.close();
  console.log('Capture complete.');
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
