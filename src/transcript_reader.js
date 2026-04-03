'use strict';

const fs = require('fs');
const path = require('path');

function getCursorProjectsDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.cursor', 'projects');
}

function listProjects() {
  const dir = getCursorProjectsDir();
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const transcriptDir = path.join(dir, d.name, 'agent-transcripts');
    if (!fs.existsSync(transcriptDir)) continue;
    let sessionCount = 0;
    try {
      sessionCount = fs.readdirSync(transcriptDir, { withFileTypes: true })
        .filter(e => e.isDirectory()).length;
    } catch {}
    const nameParts = d.name.replace(/^c-/, '').split('-');
    results.push({
      key: d.name,
      name: nameParts[nameParts.length - 1] || d.name,
      sessionCount,
    });
  }
  return results;
}

function resolveProjectKey(projectNameOrTitle) {
  if (!projectNameOrTitle) return null;
  const dir = getCursorProjectsDir();
  if (!fs.existsSync(dir)) return null;

  const candidates = [projectNameOrTitle.toLowerCase()];
  const titleParts = projectNameOrTitle.split(/\s*[-\u2014]\s*/);
  for (const p of titleParts) {
    const t = p.trim().toLowerCase();
    if (t && t !== 'cursor' && t.length > 1) candidates.push(t);
  }

  const norm = s => s.replace(/[-_]/g, '').replace(/\s+/g, '').replace(/\.[a-z]+$/i, '');
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .sort((a, b) => b.name.length - a.name.length);
  for (const candidate of candidates) {
    const cn = norm(candidate);
    if (cn.length < 3) continue;
    for (const d of entries) {
      const dn = norm(d.name.replace(/^c-/, ''));
      if (dn.length < 3) continue;
      if (cn === dn || (dn.length >= 4 && cn.includes(dn)) || (cn.length >= 4 && dn.includes(cn))) {
        const transcriptDir = path.join(dir, d.name, 'agent-transcripts');
        if (fs.existsSync(transcriptDir)) return d.name;
      }
    }
  }
  return null;
}

function extractTitle(jsonlPath) {
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (bytesRead === 0) return '';
    const firstLine = buf.toString('utf8', 0, bytesRead).split(/\r?\n/)[0];
    const obj = JSON.parse(firstLine);
    if (obj.role !== 'user') return '';
    const content = obj.message?.content;
    if (!Array.isArray(content)) return '';
    for (const item of content) {
      if (item.type === 'text' && item.text) {
        let text = item.text
          .replace(/<user_query>\s*/g, '')
          .replace(/\s*<\/user_query>/g, '')
          .replace(/<attached_files>[\s\S]*?<\/attached_files>/g, '')
          .replace(/<[^>]+>/g, '')
          .trim();
        return text.substring(0, 80);
      }
    }
    return '';
  } catch {
    return '';
  }
}

function listSessions(projectKey) {
  const dir = path.join(getCursorProjectsDir(), projectKey, 'agent-transcripts');
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const jsonlPath = path.join(dir, d.name, d.name + '.jsonl');
    if (!fs.existsSync(jsonlPath)) continue;
    let mtime;
    try { mtime = fs.statSync(jsonlPath).mtimeMs; } catch { continue; }
    const title = extractTitle(jsonlPath);
    const hasSubagents = fs.existsSync(path.join(dir, d.name, 'subagents'));
    results.push({
      id: d.name,
      title: title || '(untitled)',
      updatedAt: mtime,
      hasSubagents,
    });
  }
  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results;
}

function matchTabsToSessions(tabs, sessions) {
  if (!tabs.length || !sessions.length) return tabs;
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const used = new Set();

  const result = tabs.map(tab => ({ ...tab, sessionId: null, matchScore: 0, matchMethod: 'none' }));

  const selectedIdx = result.findIndex(r => r.selected);
  if (selectedIdx >= 0 && sorted.length > 0) {
    result[selectedIdx].sessionId = sorted[0].id;
    result[selectedIdx].matchMethod = 'active';
    result[selectedIdx].matchScore = 0.9;
    used.add(sorted[0].id);
  }

  for (let i = 0; i < result.length; i++) {
    if (result[i].sessionId) continue;
    const tabNorm = normalizeTitle(result[i].title);
    if (!tabNorm) continue;
    let bestMatch = null;
    let bestScore = 0;
    for (const s of sorted) {
      if (used.has(s.id)) continue;
      const score = titleSimilarity(tabNorm, normalizeTitle(s.title));
      if (score > bestScore && score >= 0.4) {
        bestScore = score;
        bestMatch = s;
      }
    }
    if (bestMatch) {
      result[i].sessionId = bestMatch.id;
      result[i].matchMethod = 'title';
      result[i].matchScore = bestScore;
      used.add(bestMatch.id);
    }
  }

  let nextIdx = 0;
  for (let i = 0; i < result.length; i++) {
    if (result[i].sessionId) continue;
    while (nextIdx < sorted.length && used.has(sorted[nextIdx].id)) nextIdx++;
    if (nextIdx < sorted.length) {
      result[i].sessionId = sorted[nextIdx].id;
      result[i].matchMethod = 'position';
      result[i].matchScore = 0.1;
      used.add(sorted[nextIdx].id);
      nextIdx++;
    }
  }
  return result;
}

function normalizeTitle(raw) {
  return (raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/@[\w./\\-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80)
    .toLowerCase();
}

function titleSimilarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (longer.startsWith(shorter)) return 0.95;
  if (longer.includes(shorter) && shorter.length >= 6) return 0.85;
  if (shorter.length >= 8) {
    const prefix = shorter.substring(0, Math.min(shorter.length, 30));
    if (longer.includes(prefix)) return 0.8;
  }
  const aWords = a.split(/[\s,;.!?@]+/).filter(w => w.length >= 2);
  const bWords = b.split(/[\s,;.!?@]+/).filter(w => w.length >= 2);
  if (!aWords.length || !bWords.length) return 0;
  const bSet = new Set(bWords);
  let overlap = 0;
  for (const w of aWords) {
    if (bSet.has(w)) overlap++;
  }
  return overlap / Math.max(aWords.length, bWords.length);
}

const THINKING_PATTERNS = [
  /^The user (?:wants|is asking|said|asked|provided)/i,
  /^Let me (?:search|read|check|look|find|analyze|think|also|re-read|now|verify)/i,
  /^I (?:need to|should|think|notice|see|can see|'m (?:noticing|seeing|realizing))/i,
  /^Now (?:I|let me|that)/i,
  /^(?:Looking|Searching|Checking|Reading|Analyzing|Examining|Hmm|OK|Actually|Wait)/i,
  /^(?:Good|So|This|From what|Based on)/i,
];

function isThinkingParagraph(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 20) return false;
  for (const pat of THINKING_PATTERNS) {
    if (pat.test(trimmed)) return true;
  }
  return false;
}

function splitThinking(text) {
  const paragraphs = text.split(/\n{2,}/);
  const visible = [];
  const thinking = [];

  for (const p of paragraphs) {
    if (isThinkingParagraph(p)) {
      thinking.push(p);
    } else {
      visible.push(p);
    }
  }
  return {
    visibleText: visible.join('\n\n'),
    thinkingText: thinking.join('\n\n'),
    thinkingCount: thinking.length,
  };
}

function parseMessages(projectKey, sessionId, opts = {}) {
  const doThinking = opts.parseThinking !== false;
  const jsonlPath = path.join(
    getCursorProjectsDir(), projectKey,
    'agent-transcripts', sessionId, sessionId + '.jsonl'
  );
  if (!fs.existsSync(jsonlPath)) return { messages: [], error: 'not_found' };

  let mtime;
  try { mtime = fs.statSync(jsonlPath).mtimeMs; } catch { mtime = 0; }

  const raw = fs.readFileSync(jsonlPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const messages = [];

  for (let i = 0; i < lines.length; i++) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    const role = obj.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;

    let text = '';
    for (const item of content) {
      if (item.type === 'text' && item.text) text += item.text;
    }
    if (!text) continue;

    const msg = { role, text, index: i };

    if (role === 'user') {
      msg.cleanText = text
        .replace(/<user_query>\s*/g, '')
        .replace(/\s*<\/user_query>/g, '')
        .replace(/<attached_files>[\s\S]*?<\/attached_files>/g, '')
        .replace(/<open_and_recently_viewed_files>[\s\S]*?<\/open_and_recently_viewed_files>/g, '')
        .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/g, '')
        .replace(/<[^>]+>/g, '')
        .trim();
    }

    if (role === 'assistant' && doThinking) {
      const split = splitThinking(text);
      msg.visibleText = split.visibleText;
      msg.thinkingText = split.thinkingText;
      msg.thinkingCount = split.thinkingCount;
    }

    messages.push(msg);
  }

  return { messages, mtime, sessionId, lineCount: lines.length };
}

function getSessionMtime(projectKey, sessionId) {
  const jsonlPath = path.join(
    getCursorProjectsDir(), projectKey,
    'agent-transcripts', sessionId, sessionId + '.jsonl'
  );
  try { return fs.statSync(jsonlPath).mtimeMs; } catch { return 0; }
}

module.exports = {
  getCursorProjectsDir,
  listProjects,
  resolveProjectKey,
  listSessions,
  matchTabsToSessions,
  parseMessages,
  extractTitle,
  getSessionMtime,
  splitThinking,
};
