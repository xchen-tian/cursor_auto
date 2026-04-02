#!/usr/bin/env node

/**
 * Claude Code PTY Auto-Clicker
 *
 * Wraps the Claude Code CLI in a pseudo-terminal, forwarding all I/O
 * transparently while monitoring for permission prompts and
 * automatically approving them.
 *
 * Usage:
 *   node src/claude_code_pty.js                        # interactive, auto-approve on
 *   node src/claude_code_pty.js --prompt "fix bug"     # start with initial prompt
 *   node src/claude_code_pty.js --no-auto              # proxy only, no auto-approve
 *   node src/claude_code_pty.js -- -c                  # pass flags to claude CLI
 *
 * Toggle auto-approve at runtime: press || (two pipes within 300ms)
 */

const fs = require('fs');
const { execFileSync } = require('child_process');
const pty = require('node-pty');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// ---------------------------------------------------------------------------
// ANSI stripping
// ---------------------------------------------------------------------------

function stripAnsi(str) {
  return str
    .replace(/\x1B\[\d+;\d+H/g, '\n')          // cursor position (row;col) → newline
    .replace(/\x1B\[\d+H/g, '\n')              // cursor to row → newline
    .replace(/\x1B\[(\d+)C/g, (_, n) => ' '.repeat(Number(n))) // cursor forward → spaces
    .replace(/\x1B\[(\d+)[ABD]/g, '')          // cursor up/down/back
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')    // remaining CSI sequences
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '') // OSC sequences
    .replace(/\x1B[\(\)][AB012]/g, '')          // charset switches
    .replace(/\x1B[>=<c78HDMZ]/g, '')           // misc single-char escapes
    .replace(/\x1B\[>[0-9;]*[a-z]/g, '')        // private mode sequences
    .replace(/\r/g, '');
}

// ---------------------------------------------------------------------------
// Ring buffer — last N lines of stripped text for prompt detection
// ---------------------------------------------------------------------------

class RingBuffer {
  constructor(maxLines = 100) {
    this._lines = [];
    this._maxLines = maxLines;
    this._partial = '';
  }

  push(text) {
    const combined = this._partial + text;
    const lines = combined.split('\n');
    this._partial = lines.pop() || '';
    for (const line of lines) {
      this._lines.push(line);
      if (this._lines.length > this._maxLines) this._lines.shift();
    }
  }

  snapshot(n) {
    const count = n || this._lines.length;
    const start = Math.max(0, this._lines.length - count);
    let text = this._lines.slice(start).join('\n');
    if (this._partial) text += '\n' + this._partial;
    return text;
  }

  clear() {
    this._lines = [];
    this._partial = '';
  }
}

// ---------------------------------------------------------------------------
// Permission-prompt detection
// ---------------------------------------------------------------------------

const PROMPT_PATTERNS = [
  /Do you want to\s+\w/i,
  /wants to\s+(create|run|execute|write|edit|read|delete|access|fetch|proceed)/i,
  /requires confirmation/i,
  /allow\s+(this|the|tool)/i,
  /\bYes\b[\s\S]{0,200}\bNo\b/,
  /❯\s*\d+\.\s*Yes/,
];

const DIALOG_COMPLETE_RE = /Esc to cancel|Tab to amend|ctrl\+e to explain/i;

function detectPrompt(screenText) {
  for (const re of PROMPT_PATTERNS) {
    if (re.test(screenText)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Resolve claude executable path (node-pty on Windows needs full path)
// ---------------------------------------------------------------------------

function resolveClaudePath() {
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

// ---------------------------------------------------------------------------
// Kitty keyboard protocol: '/' sends \x1B[...;47;...u/_ (47 = code point)
// ---------------------------------------------------------------------------

// '|' = Unicode code point 124 (0x7C)
const PIPE_KITTY_RE = /\x1B\[(?:\d+;)*124(?:;\d*)*[u_]/;

function isPipeKey(data) {
  return data === '|' || PIPE_KITTY_RE.test(data);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('prompt', {
      alias: 'p',
      type: 'string',
      describe: 'Initial prompt to send to Claude Code',
    })
    .option('auto', {
      type: 'boolean',
      default: true,
      describe: 'Auto-approve permission prompts (disable with --no-auto)',
    })
    .option('approve-key', {
      type: 'string',
      default: 'enter',
      describe: 'Key to send when approving: "enter" or a literal string',
    })
    .option('cooldown', {
      type: 'number',
      default: 3000,
      describe: 'Cooldown in ms between auto-approvals',
    })
    .option('verbose', {
      alias: 'v',
      type: 'boolean',
      default: false,
      describe: 'Print detection debug info to stderr',
    })
    .option('log-file', {
      type: 'string',
      describe: 'Write stripped clean text to this file (for debugging)',
    })
    .option('claude-path', {
      type: 'string',
      describe: 'Path to the Claude CLI executable',
    })
    .strict(false)
    .help()
    .parseSync();

  const claudeCmd = argv.claudePath || resolveClaudePath();
  const claudeArgs = buildClaudeArgs(argv);
  const verbose = argv.verbose;
  const cooldownMs = argv.cooldown;
  const approveSeq = argv.approveKey === 'enter' ? '\r' : argv.approveKey;
  const logFd = argv.logFile ? fs.openSync(argv.logFile, 'w') : null;

  if (verbose) {
    process.stderr.write(`[pty] command: ${claudeCmd}\n`);
    process.stderr.write(`[pty] args: ${JSON.stringify(claudeArgs)}\n`);
    process.stderr.write(`[pty] auto: ${argv.auto}, cooldown: ${cooldownMs}ms\n`);
  }

  // ---- Spawn PTY --------------------------------------------------------

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(claudeCmd, claudeArgs, {
      name: 'xterm-256color',
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 40,
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '1' },
    });
  } catch (err) {
    process.stderr.write(`[pty] Failed to spawn claude: ${err.message}\n`);
    process.exit(1);
  }

  if (verbose) process.stderr.write(`[pty] PID ${ptyProcess.pid}\n`);

  // ---- State ------------------------------------------------------------

  const ringBuf = new RingBuffer(100);
  let lastApproveTs = 0;
  let approveCount = 0;
  let exited = false;
  let quietTimer = null;
  let watchActive = argv.auto;

  // ---- PTY resize sync --------------------------------------------------

  process.stdout.on('resize', () => {
    if (exited) return;
    try {
      ptyProcess.resize(
        process.stdout.columns || 120,
        process.stdout.rows || 40,
      );
    } catch {}
  });

  // ---- Badge (piggybacks on every Claude output frame) ------------------

  let badgeTick = 0;

  function badgeSeq() {
    badgeTick++;
    const c = process.stdout.columns || 120;
    const col = Math.max(1, c - 4);
    if (!watchActive) {
      return `\x1B[s\x1B[1;${col}H\x1B[41m\x1B[97m AX\u25A0 \x1B[0m\x1B[u`;
    }
    const bg = (badgeTick >> 2) & 1 ? '\x1B[42m' : '\x1B[102m';
    return `\x1B[s\x1B[1;${col}H${bg}\x1B[30m AX\u25CF \x1B[0m\x1B[u`;
  }

  // ---- || toggle --------------------------------------------------------

  let slashTimer = null;
  let slashHeldData = null;

  function toggleWatch() {
    watchActive = !watchActive;
    const msg = watchActive ? '\u25CF auto-approve ON' : '\u25A0 auto-approve OFF';
    process.stdout.write(`\x1B]0;${msg}\x07`);
    process.stdout.write(badgeSeq());
    process.stderr.write(`[pty] ${msg}\n`);

    // Re-check current buffer immediately when toggling ON,
    // in case a prompt is already waiting with no new output coming.
    if (watchActive) {
      const screen = ringBuf.snapshot(30);
      if (detectPrompt(screen) && DIALOG_COMPLETE_RE.test(screen)) {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          quietTimer = null;
          if (!exited) approve();
        }, 150);
      }
    }
  }

  // ---- stdin handler (never split multi-byte chunks) --------------------

  function handleStdin(buf) {
    if (exited) return;
    const data = buf.toString();

    if (isPipeKey(data)) {
      if (slashTimer) {
        clearTimeout(slashTimer);
        slashTimer = null;
        slashHeldData = null;
        toggleWatch();
        return;
      }
      slashHeldData = data;
      slashTimer = setTimeout(() => {
        slashTimer = null;
        try { ptyProcess.write(slashHeldData); } catch {}
        slashHeldData = null;
      }, 300);
      return;
    }

    if (slashTimer) {
      clearTimeout(slashTimer);
      slashTimer = null;
      try { ptyProcess.write(slashHeldData); } catch {}
      slashHeldData = null;
    }
    try { ptyProcess.write(data); } catch {}
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleStdin);

  // ---- Auto-approve -----------------------------------------------------

  function approve() {
    approveCount++;
    if (verbose) {
      process.stderr.write(`\n[pty] >>> PROMPT DETECTED (#${approveCount}), approving <<<\n`);
    }
    process.stdout.write(`\x1B]0;\u26A1 APPROVED #${approveCount}\x07`);
    // Screen-wide reverse-video flash (no positioning needed)
    process.stdout.write('\x1B[?5h');
    setTimeout(() => {
      if (exited) return;
      process.stdout.write('\x1B[?5l');
      try { ptyProcess.write(approveSeq); } catch {}
      lastApproveTs = Date.now();
      ringBuf.clear();
    }, 150);
  }

  // ---- PTY output -------------------------------------------------------

  ptyProcess.onData((data) => {
    process.stdout.write(data + badgeSeq());

    const clean = stripAnsi(data);
    ringBuf.push(clean);
    if (logFd) fs.writeSync(logFd, clean);

    if (watchActive && !exited) {
      const now = Date.now();
      if (now - lastApproveTs >= cooldownMs) {
        const screen = ringBuf.snapshot(30);
        if (detectPrompt(screen) && DIALOG_COMPLETE_RE.test(screen)) {
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(() => {
            quietTimer = null;
            if (!exited) approve();
          }, 150);
        }
      }
    }
  });

  // ---- Exit handling ----------------------------------------------------

  ptyProcess.onExit(({ exitCode, signal }) => {
    exited = true;
    if (verbose) {
      process.stderr.write(`\n[pty] exited (code=${exitCode}, signal=${signal})\n`);
      process.stderr.write(`[pty] total approvals: ${approveCount}\n`);
    }
    cleanup(exitCode);
  });

  process.on('SIGINT', () => { if (exited) cleanup(130); });
  process.on('SIGHUP', () => { try { ptyProcess.kill(); } catch {} });

  function cleanup(code) {
    if (logFd) try { fs.closeSync(logFd); } catch {}
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
    process.exit(code ?? 0);
  }
}

// ---------------------------------------------------------------------------
// Build claude CLI args
// ---------------------------------------------------------------------------

function buildClaudeArgs(argv) {
  const args = [];
  if (argv.prompt) args.push(argv.prompt);
  const ddIdx = process.argv.indexOf('--');
  if (ddIdx !== -1) args.push(...process.argv.slice(ddIdx + 1));
  return args;
}

// ---------------------------------------------------------------------------
// Exports + CLI entry
// ---------------------------------------------------------------------------

module.exports = { stripAnsi, RingBuffer, detectPrompt, PROMPT_PATTERNS };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[pty] fatal: ${err.message}\n`);
    process.exit(1);
  });
}
