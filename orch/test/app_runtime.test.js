const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtime = require('../app_runtime');

function tmp(name) {
  const dir = path.join(os.tmpdir(), name + '-' + process.pid + '-' + Date.now());
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('app runtime: detects static dist app', () => {
  const dir = tmp('orch-app-static');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<h1>DMS</h1>', 'utf8');

  const app = runtime.detect(dir);

  assert.equal(app.type, 'static');
  assert.equal(app.entry, 'dist/index.html');
  assert.equal(app.staticDir, 'dist');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('app runtime: reads fullstack orch.app.json manifest', () => {
  const dir = tmp('orch-app-fullstack');
  fs.mkdirSync(path.join(dir, 'frontend', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'frontend', 'dist', 'index.html'), '<h1>DMS</h1>', 'utf8');
  fs.writeFileSync(path.join(dir, 'orch.app.json'), JSON.stringify({
    type: 'fullstack',
    staticDir: 'frontend/dist',
    entry: 'index.html',
    apiPrefix: '/api',
    backend: { start: 'node api.js', healthPath: '/health' },
  }), 'utf8');

  const app = runtime.detect(dir);

  assert.equal(app.type, 'fullstack');
  assert.equal(app.entry, 'frontend/dist/index.html');
  assert.equal(app.staticDir, 'frontend/dist');
  assert.equal(app.startCmd, 'node api.js');
  assert.equal(app.apiPrefix, '/api');
  assert.equal(app.healthPath, '/health');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('app runtime: reads UTF-8 BOM orch.app.json manifest', () => {
  const dir = tmp('orch-app-bom-manifest');
  fs.mkdirSync(path.join(dir, 'frontend', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'frontend', 'dist', 'index.html'), '<h1>DMS</h1>', 'utf8');
  fs.writeFileSync(path.join(dir, 'orch.app.json'), '\uFEFF' + JSON.stringify({
    type: 'fullstack',
    staticDir: 'frontend/dist',
    backend: { start: 'node api.js' },
  }), 'utf8');

  const app = runtime.detect(dir);

  assert.equal(app.type, 'fullstack');
  assert.equal(app.startCmd, 'node api.js');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('app runtime: starts process app on assigned local port', async () => {
  const dir = tmp('orch-app-process');
  fs.writeFileSync(path.join(dir, 'server.js'), [
    "const http = require('http');",
    "const port = Number(process.env.PORT);",
    "http.createServer((req, res) => res.end('ok:' + req.url)).listen(port);",
  ].join('\n'), 'utf8');
  const app = { id: 99, dir, type: 'process', start_cmd: 'node server.js', port: 0, health_path: '/' };
  const updates = [];

  await runtime.ensureStarted(app, { update: (patch) => { updates.push(patch); Object.assign(app, patch); }, timeoutMs: 3000 });
  const text = await fetch('http://127.0.0.1:' + app.port + '/ping').then((r) => r.text());

  assert.match(text, /ok:\/ping/);
  assert.ok(updates.some((u) => u.status === 'running'));
  runtime.stopApp(app.id);
  fs.rmSync(dir, { recursive: true, force: true });
});
