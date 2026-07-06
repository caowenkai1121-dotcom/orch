const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const SKIP_DIR = new Set(['.git', 'node_modules', '.playwright-mcp', '交接']);
const SKIP_FILE = new Set(['方案.md', '会议记录.md', '会议纪要.md', 'task_plan.md', 'findings.md', 'CLAUDE.md', 'AGENTS.md']);

function normSlash(s) { return String(s || '').replace(/\\/g, '/'); }

function safeRel(rel) {
  const s = normSlash(rel).replace(/^\/+/, '');
  if (!s || s === '.' || s.includes('..')) return '';
  return s;
}

function parseScopes(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s || '').trim()).filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function inside(base, target) {
  const b = path.resolve(base);
  const t = path.resolve(target);
  return t === b || t.startsWith(b + path.sep);
}

function resolveLocalScope(scope, taskDir) {
  const raw = String(scope || '').trim();
  const dir = path.resolve(taskDir || '.');
  if (!raw || raw === 'task://' || raw === 'task:///' || raw === 'task') return { ok: true, scope: raw || 'task://', dir };
  if (/^mfs:\/\//i.test(raw)) return { ok: true, scope: raw, mfs: true };
  if (/^task:\/\//i.test(raw)) {
    const rel = safeRel(raw.replace(/^task:\/\//i, ''));
    const target = rel ? path.resolve(dir, rel) : dir;
    return inside(dir, target) ? { ok: true, scope: raw, dir: target } : { ok: false, scope: raw, reason: 'outside task dir' };
  }
  if (/^file:\/\//i.test(raw)) {
    let p = raw.replace(/^file:\/\//i, '');
    if (/^local\//i.test(p)) p = p.slice(6);
    const target = path.resolve(p);
    return inside(dir, target) ? { ok: true, scope: raw, dir: target } : { ok: false, scope: raw, reason: 'outside task dir' };
  }
  const rel = safeRel(raw);
  const target = rel ? path.resolve(dir, rel) : dir;
  return rel && inside(dir, target) ? { ok: true, scope: raw, dir: target } : { ok: false, scope: raw, reason: 'unsupported scope' };
}

function termsOf(query) {
  return (String(query || '').toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]/gi) || [])
    .filter((x) => x.length > 1 || /[\u4e00-\u9fff]/.test(x))
    .slice(0, 80);
}

function walkMarkdown(base, dir, out) {
  if (!dir || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { walkMarkdown(base, fp, out); continue; }
    if (!e.name.toLowerCase().endsWith('.md') || SKIP_FILE.has(e.name)) continue;
    out.push(fp);
  }
}

function search(opts) {
  const taskDir = path.resolve((opts && opts.taskDir) || '.');
  const limit = (opts && opts.limit) || 3;
  const scopes = parseScopes(opts && opts.scopes);
  const localScopes = (scopes.length ? scopes : ['task://'])
    .map((s) => resolveLocalScope(s, taskDir))
    .filter((s) => s.ok && s.dir && !s.mfs);
  const files = [];
  localScopes.forEach((s) => walkMarkdown(taskDir, s.dir, files));
  const seenFiles = Array.from(new Set(files.map((f) => path.resolve(f))));
  const terms = termsOf(opts && opts.query);
  const hits = [];
  seenFiles.forEach((fp) => {
    try {
      const rel = normSlash(path.relative(taskDir, fp));
      const raw = fs.readFileSync(fp, 'utf8').slice(0, 12000);
      const rawLow = raw.toLowerCase();
      const low = (rel + '\n' + raw).toLowerCase();
      let score = 0; terms.forEach((t) => { if (low.includes(t)) score++; });
      if (!score) return;
      const first = terms.find((t) => low.includes(t)) || '';
      const rawI = first ? rawLow.indexOf(first) : -1;
      const i = rawI >= 0 ? Math.max(0, rawI - 80) : 0;
      const snip = raw.slice(i, i + 360).replace(/\s+/g, ' ').trim();
      hits.push({ rel, file: rel, source: 'file://task/' + rel, score, snip, scope: scopes.length ? scopes.join(',') : 'task://' });
    } catch (e) {}
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function format(hits) {
  return (hits || []).map((h) => '- ' + h.rel + ': ' + h.snip).join('\n');
}

function writeExternalContext(taskDir, data) {
  const text = [
    '# 外部入口上下文',
    '',
    data && data.source ? ('来源: ' + data.source) : '',
    data && data.thread ? ('## Thread\n' + String(data.thread || '').slice(0, 12000)) : '',
    data && data.context ? ('## Context\n' + String(data.context || '').slice(0, 12000)) : '',
  ].filter(Boolean).join('\n\n') + '\n';
  const rel = '上下文/外部入口.md';
  const fp = path.join(taskDir, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, 'utf8');
  return rel;
}

function defaultMfsCheck() {
  const base = (process.env.MFS_URL || 'http://127.0.0.1:13619').replace(/\/+$/, '');
  const lib = base.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    const req = lib.get(base + '/healthz', { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function preflight(opts) {
  const taskDir = path.resolve((opts && opts.taskDir) || '.');
  const scopes = parseScopes(opts && opts.scopes);
  const rows = (scopes.length ? scopes : ['task://']).map((s) => {
    const r = resolveLocalScope(s, taskDir);
    if (r.mfs) return { scope: s, ok: true, type: 'mfs' };
    return { scope: s || 'task://', ok: !!(r.ok && r.dir && fs.existsSync(r.dir)), type: 'file', reason: r.ok ? (fs.existsSync(r.dir) ? '' : 'missing') : r.reason };
  });
  const hasMfs = rows.some((r) => r.type === 'mfs');
  const check = (opts && opts.checkMfs) || defaultMfsCheck;
  const mfsAvailable = hasMfs ? !!(await check()) : false;
  if (hasMfs && !mfsAvailable) rows.forEach((r) => { if (r.type === 'mfs') { r.ok = false; r.reason = 'mfs unavailable'; } });
  return { ok: rows.every((r) => r.ok), scopes: rows, mfs: { required: hasMfs, available: mfsAvailable } };
}

module.exports = { parseScopes, resolveLocalScope, search, format, writeExternalContext, preflight };
