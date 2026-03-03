#!/usr/bin/env node

const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const cheerio = require('cheerio');
const mime = require('mime-types');

const { connectOverCDP, findPageWithSelector } = require('./cdp');
const { rewriteCssUrls } = require('./css_rewrite');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function buildClickForwarderScript(token, proxyBase) {
  const tokenJson = JSON.stringify(token || '');
  return `<script>
(function() {
  var TOKEN = ${tokenJson};

  // Visual flash overlay
  var flash = document.createElement('div');
  flash.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(255,255,0,0.18);pointer-events:none;z-index:2147483647;display:none;';
  document.body.appendChild(flash);

  function showFlash() {
    flash.style.display = 'block';
    setTimeout(function() { flash.style.display = 'none'; }, 200);
  }

  function buildSelector(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
      if (node.id) {
        parts.unshift('#' + node.id);
        break;
      }
      var tag = node.tagName.toLowerCase();
      var classes = Array.from(node.classList)
        .filter(function(c) { return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(c); })
        .slice(0, 3);
      var seg = tag + (classes.length ? '.' + classes.join('.') : '');
      // add :nth-of-type if siblings with same tag exist
      var parent = node.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === node.tagName; });
        if (siblings.length > 1) {
          var idx = siblings.indexOf(node) + 1;
          seg += ':nth-of-type(' + idx + ')';
        }
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  document.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var sel = buildSelector(e.target);
    showFlash();
    var headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['x-token'] = TOKEN;
    fetch('/api/remote-click', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ selector: sel, requireReady: false })
    }).catch(function() {});
  }, true);

  function findScrollable(el) {
    var node = el;
    while (node && node !== document.documentElement) {
      if (node.scrollHeight > node.clientHeight + 5 && node.clientHeight > 0) return node;
      node = node.parentElement;
    }
    return null;
  }
  document.addEventListener('wheel', function(e) {
    e.preventDefault();
    var scrollable = findScrollable(e.target);
    if (scrollable) {
      scrollable.scrollTop += e.deltaY;
      if (e.deltaX) scrollable.scrollLeft += e.deltaX;
    } else if (window.parent !== window) {
      window.parent.postMessage({ type: 'cursor-auto-scroll', deltaX: e.deltaX, deltaY: e.deltaY }, '*');
    }
  }, { passive: false, capture: true });
})();
</script>`;
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('host', { type: 'string', default: '127.0.0.1' })
    .option('port', { type: 'number', default: 9222 })
    .option('selector', { type: 'string', default: '.monaco-workbench' })
    .option('contains', { type: 'string', default: '' })
    .option('timeout', { type: 'number', default: 15000 })
    .option('token', { type: 'string', default: '' })
    .option('proxy-base', { type: 'string', default: '/api/vscode-file' })
    .help()
    .argv;

  const { browser, context } = await connectOverCDP({ host: argv.host, port: argv.port });

  const page = await findPageWithSelector(context, {
    selector: argv.selector,
    containsText: argv.contains || undefined,
    timeoutMs: argv.timeout,
  });

  if (!page) {
    process.stderr.write('ERROR: Could not find a page containing selector: ' + argv.selector + '\n');
    await browser.close();
    process.exit(1);
  }

  const client = await context.newCDPSession(page);
  await client.send('Page.enable');

  // Build resource map
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
      for (const c of frameTree.childFrames || []) walk(c);
    };
    walk(tree.frameTree);
  } catch (e) {
    process.stderr.write('Warning: resource tree unavailable: ' + String(e?.message || e) + '\n');
  }

  const resolveUrl = (raw) => {
    if (!raw) return null;
    try {
      return new URL(raw, page.url()).toString();
    } catch {
      return raw;
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

  // Capture DOM
  const html = await page.content();
  const pageUrl = page.url();
  const $ = cheerio.load(html, { decodeEntities: false });

  // Remove CSP
  $('meta[http-equiv="Content-Security-Policy"]').remove();

  const proxyBase = argv['proxy-base'];

  // Inline <link rel=stylesheet> and rewrite URLs in one pass.
  // We pass the original CSS file URL so relative paths like ../../media/codicon.ttf
  // can be resolved correctly before proxying.
  const links = $('link[rel="stylesheet"]').toArray();
  for (const el of links) {
    const href = $(el).attr('href');
    const abs = resolveUrl(href);
    const res = abs ? await getResourceContent(abs) : null;
    if (res && (res.mimeType?.includes('css') || res.type === 'Stylesheet')) {
      const css = res.base64Encoded
        ? Buffer.from(res.content, 'base64').toString('utf8')
        : res.content;
      const rewritten = rewriteCssUrls(css, abs, proxyBase);
      $(el).replaceWith(`<style data-inlined-from="${escapeHtml(abs)}">\n${rewritten}\n</style>`);
    }
  }

  // Rewrite any pre-existing <style> tags (use page URL as base for relative refs)
  $('style').each((_, el) => {
    // Skip styles we already inlined+rewrote from <link rel="stylesheet">
    if ($(el).attr('data-inlined-from')) return;
    const original = $(el).html() || '';
    const rewritten = rewriteCssUrls(original, pageUrl, proxyBase);
    if (rewritten !== original) $(el).html(rewritten);
  });

  function hasScheme(u) {
    return /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(u);
  }

  function stripQueryHash(u) {
    return String(u || '').split('?')[0].split('#')[0];
  }

  const VSCODE_PREFIX = 'vscode-file://vscode-app/';

  function encodePathPreservingEscapes(pathText) {
    const s = String(pathText || '');
    const saved = [];
    const protectedStr = s.replace(/%[0-9A-Fa-f]{2}/g, (m) => {
      const id = saved.length;
      saved.push(m);
      return `__PERCENT_ESC_${id}__`;
    });
    const encoded = encodeURI(protectedStr);
    return encoded.replace(/__PERCENT_ESC_(\d+)__/g, (_, id) => saved[Number(id)] || _);
  }

  function toProxyFromVscodeUrl(vscodeUrl) {
    if (!vscodeUrl || !vscodeUrl.startsWith(VSCODE_PREFIX)) return null;
    const filePath = stripQueryHash(vscodeUrl.slice(VSCODE_PREFIX.length)).replace(/^\/+/, '');
    return `${proxyBase}/${encodePathPreservingEscapes(filePath)}`;
  }

  function rewriteAttrUrl(raw) {
    const v = String(raw || '').trim();
    if (!v) return null;
    if (v.startsWith('#')) return null;
    if (v.startsWith('data:')) return null;
    if (v.startsWith('http://') || v.startsWith('https://') || v.startsWith('//')) return null;
    if (v.startsWith('blob:')) return null;
    if (v === proxyBase || v.startsWith(proxyBase + '/')) return null;

    // Absolute vscode-file URL
    if (v.startsWith(VSCODE_PREFIX)) return toProxyFromVscodeUrl(v);

    // Relative URL — resolve against the original Cursor page URL (vscode-file://...)
    if (!hasScheme(v)) {
      try {
        const resolved = new URL(v, pageUrl).toString();
        if (resolved.startsWith(VSCODE_PREFIX)) return toProxyFromVscodeUrl(resolved);
      } catch {
        return null;
      }
    }
    return null;
  }

  // Rewrite vscode-file:// (and relative URLs that resolve to it) in src/href attributes
  for (const attr of ['src', 'href']) {
    $(`[${attr}]`).each((_, el) => {
      const raw = $(el).attr(attr) || '';
      const rewritten = rewriteAttrUrl(raw);
      if (rewritten) $(el).attr(attr, rewritten);
    });
  }

  // Remove original scripts
  $('script').remove();

  // Inject click-forwarder before </body>
  const forwarder = buildClickForwarderScript(argv.token, proxyBase);
  $('body').append(forwarder);

  await browser.close();

  const outHtml = $.html({ decodeEntities: false });
  process.stdout.write(outHtml);
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + '\n');
  process.exit(1);
});
