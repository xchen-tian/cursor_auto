'use strict';

const cheerio = require('cheerio');
const { rewriteCssUrls } = require('./css_rewrite');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildClickForwarderScript(token) {
  const tokenJson = JSON.stringify(token || '');
  return `<script>
(function() {
  var TOKEN = ${tokenJson};
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
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      var tag = node.tagName.toLowerCase();
      var classes = Array.from(node.classList)
        .filter(function(c) { return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(c); }).slice(0, 3);
      var seg = tag + (classes.length ? '.' + classes.join('.') : '');
      var parent = node.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === node.tagName; });
        if (siblings.length > 1) { seg += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'; }
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }
  document.addEventListener('click', function(e) {
    e.preventDefault(); e.stopPropagation();
    var sel = buildSelector(e.target);
    showFlash();
    var headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['x-token'] = TOKEN;
    fetch('/api/remote-click', {
      method: 'POST', headers: headers,
      body: JSON.stringify({ selector: sel, requireReady: false })
    }).then(function() {
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'cursor-auto-click-done' }, '*');
      }
    }).catch(function() {});
  }, true);
})();
</script>`;
}

const VSCODE_PREFIX = 'vscode-file://vscode-app/';

function hasScheme(u) {
  return /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(u);
}

function stripQueryHash(u) {
  return String(u || '').split('?')[0].split('#')[0];
}

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

function toProxyUrl(vscodeUrl, proxyBase) {
  if (!vscodeUrl || !vscodeUrl.startsWith(VSCODE_PREFIX)) return null;
  const fp = stripQueryHash(vscodeUrl.slice(VSCODE_PREFIX.length)).replace(/^\/+/, '');
  return `${proxyBase}/${encodePathPreservingEscapes(fp)}`;
}

function makeAttrRewriter(pageUrl, proxyBase) {
  return function rewriteAttrUrl(raw) {
    const v = String(raw || '').trim();
    if (!v || v.startsWith('#') || v.startsWith('data:') || v.startsWith('blob:')) return null;
    if (v.startsWith('http://') || v.startsWith('https://') || v.startsWith('//')) return null;
    if (v === proxyBase || v.startsWith(proxyBase + '/')) return null;
    if (v.startsWith(VSCODE_PREFIX)) return toProxyUrl(v, proxyBase);
    if (!hasScheme(v)) {
      try {
        const resolved = new URL(v, pageUrl).toString();
        if (resolved.startsWith(VSCODE_PREFIX)) return toProxyUrl(resolved, proxyBase);
      } catch { return null; }
    }
    return null;
  };
}

/**
 * Build resource map from CDP Page.getResourceTree.
 */
function buildResMap(tree) {
  const resMap = new Map();
  const walk = (ft) => {
    const fid = ft.frame.id;
    for (const r of ft.resources || []) {
      if (r?.url) resMap.set(r.url, { frameId: fid, type: r.type, mimeType: r.mimeType });
    }
    for (const c of ft.childFrames || []) walk(c);
  };
  walk(tree.frameTree);
  return resMap;
}

/**
 * Render a live snapshot HTML from a CDP page.
 *
 * @param {object} page      - Playwright page (connected via CDP)
 * @param {object} client    - CDP session (from context.newCDPSession)
 * @param {object} opts
 * @param {string} opts.proxyBase  - e.g. '/api/vscode-file'
 * @param {string} [opts.token]    - auth token for click forwarder
 * @param {Map}    [opts.cssCache] - shared cache: url → { rewritten, at }
 * @param {number} [opts.cssTtl]   - cache TTL in ms (default 5 min)
 * @param {Map}    [opts.resMap]   - pre-built resource map (skips getResourceTree)
 * @returns {Promise<{html: string, resMap: Map}>}
 */
async function renderLive(page, client, opts = {}) {
  const _t = { start: Date.now() };
  const proxyBase = opts.proxyBase || '/api/vscode-file';
  const token = opts.token || '';
  const cssCache = opts.cssCache || null;
  const cssTtl = opts.cssTtl || 5 * 60 * 1000;

  let resMap = opts.resMap || null;
  if (!resMap) {
    const tree = await client.send('Page.getResourceTree');
    resMap = buildResMap(tree);
  }

  const pageUrl = page.url();

  const resolveUrl = (raw) => {
    if (!raw) return null;
    try { return new URL(raw, pageUrl).toString(); } catch { return raw; }
  };

  const getResourceContent = async (absUrl) => {
    const meta = resMap.get(absUrl);
    if (!meta) return null;
    try {
      const { content, base64Encoded } = await client.send('Page.getResourceContent', {
        frameId: meta.frameId, url: absUrl,
      });
      return { content, base64Encoded, mimeType: meta.mimeType, type: meta.type };
    } catch { return null; }
  };

  _t.preContent = Date.now();
  const dom = await page.content();
  _t.content = Date.now();
  const $ = cheerio.load(dom, { decodeEntities: false });

  _t.cheerio = Date.now();

  $('meta[http-equiv="Content-Security-Policy"]').remove();

  const links = $('link[rel="stylesheet"]').toArray();
  let cssCacheHit = 0, cssFetched = 0;
  for (const el of links) {
    const href = $(el).attr('href');
    const abs = resolveUrl(href);
    if (!abs) continue;

    if (cssCache) {
      const cached = cssCache.get(abs);
      if (cached && (Date.now() - cached.at) < cssTtl) {
        $(el).replaceWith(`<style data-inlined-from="${escapeHtml(abs)}">\n${cached.rewritten}\n</style>`);
        cssCacheHit++;
        continue;
      }
    }

    const res = await getResourceContent(abs);
    if (res && (res.mimeType?.includes('css') || res.type === 'Stylesheet')) {
      const css = res.base64Encoded
        ? Buffer.from(res.content, 'base64').toString('utf8')
        : res.content;
      const rewritten = rewriteCssUrls(css, abs, proxyBase);
      if (cssCache) cssCache.set(abs, { rewritten, at: Date.now() });
      $(el).replaceWith(`<style data-inlined-from="${escapeHtml(abs)}">\n${rewritten}\n</style>`);
      cssFetched++;
    }
  }
  _t.css = Date.now();

  $('style').each((_, el) => {
    if ($(el).attr('data-inlined-from')) return;
    const original = $(el).html() || '';
    const rewritten = rewriteCssUrls(original, pageUrl, proxyBase);
    if (rewritten !== original) $(el).html(rewritten);
  });
  _t.styleRewrite = Date.now();

  const rewriteAttrUrl = makeAttrRewriter(pageUrl, proxyBase);
  for (const attr of ['src', 'href']) {
    $(`[${attr}]`).each((_, el) => {
      const raw = $(el).attr(attr) || '';
      const r = rewriteAttrUrl(raw);
      if (r) $(el).attr(attr, r);
    });
  }
  _t.attrRewrite = Date.now();

  $('script').remove();
  $('body').append(buildClickForwarderScript(token));

  const outHtml = $.html({ decodeEntities: false });
  _t.serialize = Date.now();

  console.log('[render] content=%dms cheerio=%dms css=%dms(%d cached/%d fetched) style=%dms attr=%dms serialize=%dms TOTAL=%dms dom=%dKB out=%dKB',
    _t.content - _t.preContent,
    _t.cheerio - _t.content,
    _t.css - _t.cheerio, cssCacheHit, cssFetched,
    _t.styleRewrite - _t.css,
    _t.attrRewrite - _t.styleRewrite,
    _t.serialize - _t.attrRewrite,
    _t.serialize - _t.start,
    (dom.length / 1024) | 0,
    (outHtml.length / 1024) | 0);

  return { html: outHtml, resMap };
}

module.exports = { renderLive, buildResMap, escapeHtml, buildClickForwarderScript };
