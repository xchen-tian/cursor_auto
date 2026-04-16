const fs = require('fs');
const path = require('path');

function ensureNodePtySpawnHelperExecutable() {
  if (process.platform !== 'darwin') return null;

  let pkgPath;
  try {
    pkgPath = require.resolve('node-pty/package.json');
  } catch {
    return null;
  }

  const pkgDir = path.dirname(pkgPath);
  const candidates = [
    path.join(pkgDir, 'build', 'Release', 'spawn-helper'),
    path.join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  ];

  for (const helperPath of candidates) {
    try {
      const stat = fs.statSync(helperPath);
      if (!stat.isFile()) continue;
      const mode = stat.mode & 0o777;
      const wantMode = mode | 0o111;
      if (mode !== wantMode) {
        fs.chmodSync(helperPath, wantMode);
      }
      return helperPath;
    } catch {}
  }

  return null;
}

ensureNodePtySpawnHelperExecutable();

const pty = require('node-pty');

module.exports = pty;
module.exports.ensureNodePtySpawnHelperExecutable = ensureNodePtySpawnHelperExecutable;
