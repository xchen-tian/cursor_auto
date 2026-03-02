#!/usr/bin/env node

// Build a simple static site under dist/site/ that lists captured snapshots.

const fs = require('fs');
const path = require('path');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dst) {
  ensureDir(dst);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function main() {
  const root = path.join(__dirname, '..');
  const captureBase = path.join(root, 'dist', 'capture');
  const siteBase = path.join(root, 'dist', 'site');
  const siteCaps = path.join(siteBase, 'captures');

  ensureDir(siteBase);
  ensureDir(siteCaps);

  if (!fs.existsSync(captureBase)) {
    console.error('No captures found at:', captureBase);
    console.error('Run: npm run capture');
    process.exit(1);
  }

  const dirs = fs.readdirSync(captureBase, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
    .reverse();

  // Clean site/captures (avoid stale)
  if (fs.existsSync(siteCaps)) {
    for (const ent of fs.readdirSync(siteCaps, { withFileTypes: true })) {
      fs.rmSync(path.join(siteCaps, ent.name), { recursive: true, force: true });
    }
  }

  const items = [];
  for (const name of dirs) {
    const src = path.join(captureBase, name);
    const dst = path.join(siteCaps, name);
    copyDir(src, dst);

    const thumb = fs.existsSync(path.join(dst, 'screenshot.png')) ? `captures/${name}/screenshot.png` : null;
    const href = `captures/${name}/index.html`;
    items.push({ name, href, thumb });
  }

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>cursor_auto snapshots</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;line-height:1.4}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
    .card{border:1px solid #ddd;border-radius:14px;padding:12px;overflow:hidden}
    .title{font-weight:600;margin:0 0 8px 0;font-size:14px}
    img{max-width:100%;border-radius:10px;border:1px solid #eee}
    a{color:#0b66c3;text-decoration:none}
    a:hover{text-decoration:underline}
    .hint{color:#666;font-size:13px;margin-bottom:14px}
  </style>
</head>
<body>
  <h1>cursor_auto snapshots</h1>
  <p class="hint">These are static snapshots (read-only). Newest first.</p>
  <div class="grid">
    ${items.map(it => `
      <div class="card">
        <div class="title"><a href="${it.href}">${htmlEscape(it.name)}</a></div>
        ${it.thumb ? `<a href="${it.href}"><img src="${it.thumb}" alt="${htmlEscape(it.name)}" /></a>` : ''}
      </div>
    `).join('')}
  </div>
</body>
</html>`;

  fs.writeFileSync(path.join(siteBase, 'index.html'), html, 'utf8');
  console.log('Built static site at:', siteBase);
  console.log('Preview locally: npx serve dist/site');
}

main();
