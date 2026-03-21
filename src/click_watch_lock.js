const { execSync, execFileSync } = require('child_process');

function normalizeHost(host) {
  return String(host || '127.0.0.1').trim().toLowerCase() || '127.0.0.1';
}

function normalizePort(port) {
  const n = Number(port);
  return Number.isFinite(n) && n > 0 ? n : 9292;
}

function makeWatcherKey(host, port) {
  return `${normalizeHost(host)}:${normalizePort(port)}`;
}

function parseFlag(cmd, flag, fallback = '') {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const eq = new RegExp(`${escaped}=(?:"([^"]+)"|'([^']+)'|(\\S+))`);
  const spaced = new RegExp(`${escaped}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`);
  const match = cmd.match(eq) || cmd.match(spaced);
  return match ? (match[1] || match[2] || match[3] || fallback) : fallback;
}

function listNodeProcesses() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json'],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const parsed = JSON.parse(out);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list
        .filter(Boolean)
        .map(p => ({ pid: Number(p.ProcessId), cmd: String(p.CommandLine || '') }));
    }

    const out = execSync('ps -ax -o pid=,command=', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const m = line.match(/^(\d+)\s+(.+)$/);
        return m ? { pid: Number(m[1]), cmd: m[2] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function findRunningClickSupervisors({ host = '127.0.0.1', port = 9292, selfPid = process.pid } = {}) {
  const wantedKey = makeWatcherKey(host, port);
  return listNodeProcesses()
    .filter(p =>
      p.pid !== selfPid &&
      p.cmd &&
      /click_supervisor\.js/.test(p.cmd)
    )
    .map(p => {
      const procHost = parseFlag(p.cmd, '--host', '127.0.0.1');
      const procPort = parseFlag(p.cmd, '--port', '9292');
      const mode = /--scan-tabs\b/.test(p.cmd) ? 'scan' : 'watch';
      return {
        pid: p.pid,
        host: normalizeHost(procHost),
        port: normalizePort(procPort),
        mode,
        cmd: p.cmd.substring(0, 200),
      };
    })
    .filter(p => makeWatcherKey(p.host, p.port) === wantedKey);
}

module.exports = {
  makeWatcherKey,
  findRunningClickSupervisors,
};
