'use strict';

/**
 * Rewrite url() references in CSS so they point to /api/vscode-file/<path>.
 *
 * Handles:
 *   - Absolute:  url(vscode-file://vscode-app/<path>)
 *   - Relative:  url(../../media/codicon.ttf) resolved against cssFileUrl
 *                (e.g. vscode-file://vscode-app/out/vs/workbench/workbench.desktop.main.css)
 *
 * Leaves data:, http:, https:, // and other absolute schemes untouched.
 * Strips query strings and hash fragments from proxied paths (files are served by path).
 */
function rewriteCssUrls(cssText, cssFileUrl, proxyBase) {
  const src = String(cssText || '');
  const baseUrl = String(cssFileUrl || '');
  const pb = String(proxyBase || '').replace(/\/+$/, '');
  if (!pb) return src;

  const VSCODE_PREFIX = 'vscode-file://vscode-app/';

  const stripQueryHash = (s) => String(s).split('?')[0].split('#')[0];

  // Decode CSS escape sequences in a URL string, e.g.:
  //   vscode-file\:\/\/vscode-app\/c\:\/Program\ Files\/...\/seti\.woff
  // -> vscode-file://vscode-app/c:/Program Files/.../seti.woff
  function cssUnescape(s) {
    return String(s).replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_, esc) => {
      // Hex escape: \HHHHHH[ ]
      if (/^[0-9a-fA-F]/.test(esc)) {
        const hex = esc.trim();
        const cp = parseInt(hex, 16);
        if (!Number.isFinite(cp)) return esc;
        try { return String.fromCodePoint(cp); } catch { return esc; }
      }
      // Simple escape: \<char>
      return esc;
    });
  }

  function hasScheme(u) {
    return /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(u);
  }

  function isAlreadyProxied(u) {
    if (!u) return false;
    if (u === pb) return true;
    if (u.startsWith(pb + '/')) return true;
    // Also guard against missing leading slash variants, e.g. api/vscode-file/...
    const pbNoLead = pb.replace(/^\/+/, '');
    return pbNoLead && (u === pbNoLead || u.startsWith(pbNoLead + '/'));
  }

  function toProxiedUrlFromVscodePath(vscodePath) {
    const pathOnly = stripQueryHash(vscodePath)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    return `${pb}/${encodePathPreservingEscapes(pathOnly)}`;
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

  function rewriteOneUrl(rawUrl) {
    const u0 = String(rawUrl || '').trim();
    if (!u0) return null;
    if (u0.startsWith('#')) return null;
    if (u0.startsWith('data:')) return null;
    if (u0.startsWith('http://') || u0.startsWith('https://') || u0.startsWith('//')) return null;
    if (u0.startsWith('blob:')) return null;
    if (isAlreadyProxied(u0)) return null;

    // Absolute vscode-file URL
    if (u0.startsWith(VSCODE_PREFIX)) {
      return toProxiedUrlFromVscodePath(u0.slice(VSCODE_PREFIX.length));
    }

    // Relative URL — resolve against the CSS file's original URL
    if (!hasScheme(u0) && baseUrl) {
      const safe = u0.replace(/\\/g, '/');
      let resolved = null;
      try {
        resolved = new URL(safe, baseUrl).toString();
      } catch {
        try {
          resolved = new URL(encodeURI(safe), baseUrl).toString();
        } catch {
          return null;
        }
      }
      if (resolved.startsWith(VSCODE_PREFIX)) {
        return toProxiedUrlFromVscodePath(resolved.slice(VSCODE_PREFIX.length));
      }
    }

    return null;
  }

  // Lightweight url(...) parser (case-insensitive), robust to quoted URLs with spaces.
  const lower = src.toLowerCase();
  let out = '';
  let i = 0;
  while (i < src.length) {
    const start = lower.indexOf('url(', i);
    if (start < 0) {
      out += src.slice(i);
      break;
    }

    out += src.slice(i, start);

    let j = start + 4; // after "url("
    while (j < src.length && /\s/.test(src[j])) j++;

    const quote = (src[j] === '"' || src[j] === "'") ? src[j] : null;
    let inner = '';
    if (quote) {
      j++;
      const innerStart = j;
      while (j < src.length && src[j] !== quote) j++;
      inner = src.slice(innerStart, j);
      if (j < src.length && src[j] === quote) j++;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (j >= src.length || src[j] !== ')') {
        // Malformed, keep original
        out += src.slice(start, j);
        i = j;
        continue;
      }
    } else {
      const innerStart = j;
      while (j < src.length && src[j] !== ')') j++;
      if (j >= src.length) {
        out += src.slice(start);
        break;
      }
      inner = src.slice(innerStart, j).trim();
    }

    const end = j + 1; // include ')'
    const decoded = cssUnescape(inner);
    const replacement = rewriteOneUrl(decoded);

    if (replacement === null) {
      out += src.slice(start, end);
    } else if (quote) {
      out += `url(${quote}${replacement}${quote})`;
    } else {
      out += `url(${replacement})`;
    }

    i = end;
  }

  return out;
}

module.exports = { rewriteCssUrls };
