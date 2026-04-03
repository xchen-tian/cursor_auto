/**
 * Claude Code PTY — WebSocket server module.
 *
 * Local sessions: node-pty spawns claude directly.
 * SSH sessions:   ssh2 library connects, requests PTY + shell, runs claude.
 *                 Stream pipes raw bytes to WebSocket binary frames — no
 *                 intermediate local PTY, no conpty, zero ANSI mangling.
 *
 * Session lifecycle is managed via client messages (start/attach/query).
 */

const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const { Client: SSHClient } = require('ssh2');
const SSHConfig = require('ssh-config');

const OUTPUT_BUFFER_MAX = 100000;
// No artificial timeout — rely on PTY onExit / SSH keepalive / stream close

function resolveLocalClaudePath() {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        '(Get-Command claude -ErrorAction Stop).Source',
      ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    }
    return execFileSync('which', ['claude'], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'claude';
  }
}

function sessionKey(opts) {
  const st = opts.sessionType || opts.type || 'local';
  return `${st}:${opts.host || ''}:${opts.cwd || process.cwd()}`;
}

function shellEscape(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

let _sshConfigCache = null;

function loadSshConfig() {
  if (_sshConfigCache) return _sshConfigCache;
  const configPath = path.join(os.homedir(), '.ssh', 'config');
  try {
    const text = fs.readFileSync(configPath, 'utf-8');
    _sshConfigCache = SSHConfig.parse(text);
  } catch {
    _sshConfigCache = SSHConfig.parse('');
  }
  return _sshConfigCache;
}

function resolveSshHost(alias) {
  const config = loadSshConfig();
  const resolved = config.compute(alias);
  return {
    host: resolved.HostName || alias,
    port: Number(resolved.Port) || 22,
    username: resolved.User || process.env.USER || process.env.USERNAME || os.userInfo().username,
    identityFile: resolved.IdentityFile ? resolved.IdentityFile[0]?.replace(/^~/, os.homedir()) : null,
    proxyJump: resolved.ProxyJump || null,
  };
}

function findSshKey() {
  const home = os.homedir();
  for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const p = path.join(home, '.ssh', name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

const sessions = new Map();

class PtySession {
  constructor(opts) {
    this.key = sessionKey(opts);
    this.type = opts.sessionType || opts.type || 'local';
    this.host = opts.host || null;
    this.cwd = opts.cwd || process.cwd();
    this.clients = new Set();
    this.outputBuf = Buffer.alloc(0);
    this.exited = false;
    this.exitCode = null;
    this._pty = null;
    this._sshConn = null;
    this._sshStream = null;

    const cols = opts.cols || 120;
    const rows = opts.rows || 40;
    const claudeArgs = opts.newSession
      ? '--model opus --effort max'
      : '--model opus --effort max --continue';

    if (this.type === 'ssh' && this.host) {
      this._startSSH(cols, rows, claudeArgs);
    } else {
      this._startLocal(cols, rows, claudeArgs);
    }

  }

  _startLocal(cols, rows, claudeArgs) {
    const claudeCmd = resolveLocalClaudePath();
    this._pty = pty.spawn(claudeCmd, claudeArgs.split(' '), {
      name: 'xterm-256color',
      cols, rows,
      cwd: this.cwd,
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    this._pty.onData((data) => {
      this._onOutput(Buffer.from(data, 'utf-8'));
    });

    this._pty.onExit(({ exitCode }) => {
      this._cleanup(exitCode);
    });
  }

  _startSSH(cols, rows, claudeArgs) {
    const resolved = resolveSshHost(this.host);
    const remoteCmd = `cd ${shellEscape(this.cwd)} && claude ${claudeArgs}`;

    const openShell = (conn) => {
      const execCmd = `bash -lc ${shellEscape('export TERM=xterm-256color FORCE_COLOR=1; ' + remoteCmd)}`;
      conn.exec(execCmd, { pty: { term: 'xterm-256color', cols, rows } }, (err, stream) => {
        if (err) {
          this._broadcastJson({ type: 'error', message: `SSH exec error: ${err.message}` });
          this._cleanup(-1);
          return;
        }
        this._sshStream = stream;

        stream.on('data', (data) => {
          this._onOutput(Buffer.isBuffer(data) ? data : Buffer.from(data));
        });
        stream.on('close', () => this._cleanup(0));
        stream.stderr.on('data', (data) => {
          this._onOutput(Buffer.isBuffer(data) ? data : Buffer.from(data));
        });
      });
    };

    const keyPath = resolved.identityFile || findSshKey();
    const baseOpts = {
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      agent: process.env.SSH_AUTH_SOCK || undefined,
    };
    if (keyPath && fs.existsSync(keyPath)) {
      baseOpts.privateKey = fs.readFileSync(keyPath);
    }

    if (resolved.proxyJump) {
      // Two-hop: connect to jump host first, then forward to target
      const jumpResolved = resolveSshHost(resolved.proxyJump);
      const jumpConn = new SSHClient();
      this._sshConn = jumpConn;

      jumpConn.on('ready', () => {
        jumpConn.forwardOut('127.0.0.1', 0, resolved.host, resolved.port, (err, channel) => {
          if (err) {
            this._broadcastJson({ type: 'error', message: `ProxyJump error: ${err.message}` });
            this._cleanup(-1);
            return;
          }
          const targetConn = new SSHClient();
          targetConn.on('ready', () => openShell(targetConn));
          targetConn.on('error', (e) => {
            this._broadcastJson({ type: 'error', message: `SSH target error: ${e.message}` });
            this._cleanup(-1);
          });
          targetConn.on('close', () => this._cleanup(-1));
          targetConn.connect({
            ...baseOpts,
            sock: channel,
            host: resolved.host,
            port: resolved.port,
            username: resolved.username,
          });
        });
      });

      jumpConn.on('error', (e) => {
        this._broadcastJson({ type: 'error', message: `SSH jump error: ${e.message}` });
        this._cleanup(-1);
      });
      jumpConn.on('close', () => this._cleanup(-1));

      const jumpKey = resolveSshHost(resolved.proxyJump).identityFile || findSshKey();
      jumpConn.connect({
        ...baseOpts,
        host: jumpResolved.host,
        port: jumpResolved.port,
        username: jumpResolved.username,
        privateKey: jumpKey && fs.existsSync(jumpKey) ? fs.readFileSync(jumpKey) : baseOpts.privateKey,
      });
    } else {
      // Direct connection
      const conn = new SSHClient();
      this._sshConn = conn;
      conn.on('ready', () => openShell(conn));
      conn.on('error', (e) => {
        this._broadcastJson({ type: 'error', message: `SSH error: ${e.message}` });
        this._cleanup(-1);
      });
      conn.on('close', () => this._cleanup(-1));
      conn.connect({
        ...baseOpts,
        host: resolved.host,
        port: resolved.port,
        username: resolved.username,
      });
    }
  }

  _onOutput(buf) {

    // Append to replay buffer
    this.outputBuf = Buffer.concat([this.outputBuf, buf]);
    if (this.outputBuf.length > OUTPUT_BUFFER_MAX) {
      this.outputBuf = this.outputBuf.subarray(-OUTPUT_BUFFER_MAX);
    }

    // Send as binary WebSocket frame to all clients
    for (const ws of this.clients) {
      if (ws.readyState === 1) try { ws.send(buf); } catch {}
    }
  }


  _cleanup(exitCode) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = exitCode;
    this._broadcastJson({ type: 'exit', code: exitCode });
    sessions.delete(this.key);
  }

  attach(ws, skipReplay) {
    this.clients.add(ws);

    const doReplay = !skipReplay && this.outputBuf.length > 0;

    this._sendJson(ws, {
      type: 'session',
      sessionType: this.type,
      host: this.host,
      cwd: this.cwd,
      alive: !this.exited,
      replay: doReplay,
    });

    if (doReplay && ws.readyState === 1) {
      try { ws.send(this.outputBuf); } catch {}
    }

    if (this.exited) {
      this._sendJson(ws, { type: 'exit', code: this.exitCode });
    }
  }

  detach(ws) {
    this.clients.delete(ws);
  }

  _handleMessage(msg) {
    if (this.exited) return;
    switch (msg.type) {
      case 'input':
        if (msg.data) this._write(msg.data);
        break;
      case 'resize':
        if (msg.cols && msg.rows) this._resize(msg.cols, msg.rows);
        break;
      case 'approve':
        this._write('\r');
        break;
    }
  }

  _write(data) {
    if (this._pty) {
      try { this._pty.write(data); } catch {}
    } else if (this._sshStream) {
      try { this._sshStream.write(data); } catch {}
    }
  }

  _resize(cols, rows) {
    if (this._pty) {
      try { this._pty.resize(cols, rows); } catch {}
    } else if (this._sshStream) {
      try { this._sshStream.setWindow(rows, cols, rows * 16, cols * 8); } catch {}
    }
  }

  _broadcastJson(msg) {
    const json = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === 1) try { ws.send(json); } catch {}
    }
  }

  _sendJson(ws, msg) {
    if (ws.readyState === 1) try { ws.send(JSON.stringify(msg)); } catch {}
  }

  kill() {
    this.exited = true;
    if (this._pty) try { this._pty.kill(); } catch {}
    if (this._sshStream) try { this._sshStream.close(); } catch {}
    if (this._sshConn) try { this._sshConn.end(); } catch {}
    sessions.delete(this.key);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function handleConnection(ws) {
  let currentSession = null;

  function detachCurrent() {
    if (currentSession) {
      currentSession.detach(ws);
      currentSession = null;
    }
  }

  ws.on('close', () => { detachCurrent(); });

  ws.on('message', (raw) => {
    const str = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
    let msg;
    try { msg = JSON.parse(str); } catch { return; }

    if (msg.type === 'detach') {
      detachCurrent();
      return;
    }

    if (msg.type === 'query') {
      const key = sessionKey(msg);
      const session = sessions.get(key);
      ws.send(JSON.stringify({
        type: 'query_result',
        exists: !!session && !session.exited,
        key,
      }));
      return;
    }

    if (msg.type === 'start') {
      detachCurrent();
      const key = sessionKey(msg);
      let session = sessions.get(key);
      if (session && !session.exited) session.kill();
      try {
        session = new PtySession(msg);
        sessions.set(key, session);
        currentSession = session;
        session.attach(ws);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: `Failed to spawn: ${err.message}` }));
      }
      return;
    }

    if (msg.type === 'attach') {
      detachCurrent();
      const key = sessionKey(msg);
      const session = sessions.get(key);
      if (session && !session.exited) {
        currentSession = session;
        session.attach(ws, msg.skipReplay);
      } else {
        ws.send(JSON.stringify({ type: 'no_session', key }));
      }
      return;
    }

    if (currentSession && !currentSession.exited) {
      currentSession._handleMessage(msg);
    }
  });
}

function listSessions() {
  return [...sessions.entries()].map(([key, s]) => ({
    key, type: s.type, host: s.host, cwd: s.cwd,
    alive: !s.exited, clients: s.clients.size,
  }));
}

module.exports = { handleConnection, listSessions, sessionKey, resolveLocalClaudePath };
