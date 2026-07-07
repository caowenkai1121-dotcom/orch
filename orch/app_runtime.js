const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { killTree } = require('./adapters/steptimeout');

const running = new Map();

function slash(s) { return String(s || '').replace(/\\/g, '/'); }
function safeRel(s) {
  const rel = slash(s || '').replace(/^\/+/, '');
  if (!rel || rel === '.') return '';
  if (rel.includes('..') || path.isAbsolute(rel)) return '';
  return rel;
}
function exists(dir, rel) { return rel && fs.existsSync(path.join(dir, rel)); }
function joinRel(a, b) {
  const x = safeRel(a), y = safeRel(b);
  return slash(x ? path.posix.join(x, y || '') : y);
}
function firstExisting(dir, list) { return list.find((rel) => exists(dir, rel)); }
function readJson(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; }
}

function manifestApp(dir, m) {
  const root = safeRel(m.root || '');
  const base = root ? path.join(dir, root) : dir;
  const backend = m.backend || {};
  const frontend = m.frontend || {};
  const staticDir = safeRel(m.staticDir || frontend.staticDir || '');
  const entryName = safeRel(m.entry || frontend.entry || 'index.html') || 'index.html';
  const entry = staticDir && !slash(entryName).startsWith(staticDir + '/') ? joinRel(staticDir, entryName) : entryName;
  const startCmd = String(m.start || backend.start || '').trim();
  const type = String(m.type || m.kind || (startCmd ? (staticDir ? 'fullstack' : 'process') : 'static')).toLowerCase();
  return {
    type, root, dir: base, entry,
    staticDir: staticDir || path.posix.dirname(entry),
    startCmd,
    apiPrefix: String(m.apiPrefix || backend.apiPrefix || '/api').trim() || '/api',
    healthPath: String(m.healthPath || backend.healthPath || '/').trim() || '/',
    port: Number(m.port || backend.port) || 0,
  };
}

function packageStart(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg || !pkg.scripts) return '';
  if (pkg.scripts.start) return 'npm start';
  if (pkg.scripts.dev) return 'npm run dev';
  return '';
}

function detect(dir, opts) {
  const root = path.resolve(dir || '.');
  const manifest = readJson(path.join(root, 'orch.app.json'));
  if (manifest) return manifestApp(root, manifest);
  const preferred = opts && opts.entry ? safeRel(opts.entry) : '';
  if (preferred && exists(root, preferred)) return { type: 'static', dir: root, entry: preferred, staticDir: path.posix.dirname(preferred), startCmd: '', apiPrefix: '/api', healthPath: '/', port: 0 };
  const html = firstExisting(root, ['dist/index.html', 'frontend/dist/index.html', 'build/index.html', 'public/index.html', 'index.html']);
  if (html) return { type: 'static', dir: root, entry: html, staticDir: path.posix.dirname(html), startCmd: '', apiPrefix: '/api', healthPath: '/', port: 0 };
  const start = packageStart(root);
  if (start) return { type: 'process', dir: root, entry: '', staticDir: '', startCmd: start, apiPrefix: '/api', healthPath: '/', port: 0 };
  const jar = firstExisting(root, fs.existsSync(root) ? fs.readdirSync(root).filter((f) => /\.jar$/i.test(f)) : []);
  if (jar) return { type: 'process', dir: root, entry: '', staticDir: '', startCmd: 'java -jar ' + jar, apiPrefix: '/api', healthPath: '/', port: 0 };
  if (exists(root, 'app.py')) return { type: 'process', dir: root, entry: '', staticDir: '', startCmd: 'python app.py', apiPrefix: '/api', healthPath: '/', port: 0 };
  if (exists(root, 'main.py')) return { type: 'process', dir: root, entry: '', staticDir: '', startCmd: 'python main.py', apiPrefix: '/api', healthPath: '/', port: 0 };
  if (exists(root, 'go.mod')) return { type: 'process', dir: root, entry: '', staticDir: '', startCmd: 'go run .', apiPrefix: '/api', healthPath: '/', port: 0 };
  if (exists(root, 'Cargo.toml')) return { type: 'process', dir: root, entry: '', staticDir: '', startCmd: 'cargo run', apiPrefix: '/api', healthPath: '/', port: 0 };
  const any = firstExisting(root, fs.existsSync(root) ? fs.readdirSync(root).filter((f) => fs.statSync(path.join(root, f)).isFile()) : []);
  return { type: 'static', dir: root, entry: any || '', staticDir: '', startCmd: '', apiPrefix: '/api', healthPath: '/', port: 0 };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(Number(port), '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function waitHttp(port, healthPath, timeoutMs) {
  const until = Date.now() + (timeoutMs || 8000);
  const hp = healthPath && healthPath.startsWith('/') ? healthPath : '/' + (healthPath || '');
  while (Date.now() < until) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + hp, { signal: AbortSignal.timeout(800) });
      if (r.status < 500) return true;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function patch(update, data) { if (typeof update === 'function') update(data); }

function rewritePublishedText(text, appId) {
  const base = '/apps/' + encodeURIComponent(String(appId)) + '/';
  const apiBase = base.replace(/\/$/, '') + '/api';
  return String(text || '')
    .replace(/(["'=])\/assets\//g, '$1' + base + 'assets/')
    .replace(/url\((['"]?)\/assets\//g, 'url($1' + base + 'assets/')
    .replace(/(["'`])\/api(?=\/)/g, '$1' + apiBase);
}

function publishedTextContentType(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === '.html') return 'text/html; charset=utf-8';
  if (e === '.css') return 'text/css; charset=utf-8';
  if (e === '.js' || e === '.mjs') return 'application/javascript; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function startupTimeoutMs(app) {
  const cmd = String((app && (app.start_cmd || app.startCmd)) || '').toLowerCase();
  if (/mvn|gradle|spring-boot|java\s+-jar/.test(cmd)) return 60000;
  return 8000;
}

async function ensureStarted(app, opts) {
  const id = Number(app.id);
  const cur = running.get(id);
  if (cur && cur.child && !cur.child.killed) return app;
  const cmd = app.start_cmd || app.startCmd || '';
  if (!cmd) return app;
  const update = opts && opts.update;
  const preferred = Number(app.port) || 0;
  const port = preferred && await portAvailable(preferred) ? preferred : await freePort();
  patch(update, { port, status: 'starting', lastError: '' });
  const logs = [];
  const child = spawn(cmd, {
    cwd: app.dir,
    shell: true,
    windowsHide: true,
    env: Object.assign({}, process.env, { PORT: String(port), ORCH_APP_PORT: String(port) }),
  });
  child.unref();
  const push = (s) => {
    String(s || '').split(/\r?\n/).filter(Boolean).forEach((line) => logs.push(line.slice(0, 1000)));
    if (logs.length > 200) logs.splice(0, logs.length - 200);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (e) => { patch(update, { status: 'failed', lastError: e.message || String(e) }); });
  child.on('exit', (code) => {
    const failed = code && code !== 0;
    patch(update, { status: failed ? 'failed' : 'stopped', lastError: failed ? ('exit ' + code) : '' });
    running.delete(id);
  });
  running.set(id, { child, logs });
  const timeoutMs = Math.max(Number((opts && opts.timeoutMs) || 0), startupTimeoutMs(app));
  const ok = await waitHttp(port, app.health_path || app.healthPath || '/', timeoutMs);
  if (!ok) {
    stopApp(id);
    patch(update, { status: 'failed', lastError: 'health check timeout' });
    throw new Error('health check timeout');
  }
  patch(update, { port, status: 'running', lastError: '' });
  app.port = port;
  app.status = 'running';
  return app;
}

function stopApp(id) {
  const cur = running.get(Number(id));
  if (!cur) return false;
  try { killTree(cur.child); } catch (e) {}
  running.delete(Number(id));
  return true;
}

function logs(id) {
  const cur = running.get(Number(id));
  return cur ? cur.logs.slice() : [];
}

async function proxyRequest(app, req, res, rel) {
  await ensureStarted(app, { timeoutMs: 8000 });
  const target = 'http://127.0.0.1:' + Number(app.port) + '/' + slash(rel || '').replace(/^\/+/, '') + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers['content-length'];
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const body = hasBody && req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : undefined;
  if (body && !headers['content-type']) headers['content-type'] = 'application/json';
  const r = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
  res.status(r.status);
  r.headers.forEach((v, k) => {
    if (!['transfer-encoding', 'content-encoding', 'content-length'].includes(k.toLowerCase())) res.setHeader(k, v);
  });
  const buf = Buffer.from(await r.arrayBuffer());
  res.send(buf);
}

module.exports = { detect, ensureStarted, stopApp, logs, proxyRequest, freePort, rewritePublishedText, publishedTextContentType, startupTimeoutMs };
