const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
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

test('app runtime: falls back to free port when manifest port is occupied', async () => {
  const blocker = http.createServer((req, res) => res.end('busy'));
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const occupied = blocker.address().port;
  const dir = tmp('orch-app-occupied-port');
  fs.writeFileSync(path.join(dir, 'server.js'), [
    "const http = require('http');",
    "const port = Number(process.env.PORT);",
    "http.createServer((req, res) => res.end('ok:' + port)).listen(port, '127.0.0.1');",
  ].join('\n'), 'utf8');
  const app = { id: 100, dir, type: 'process', start_cmd: 'node server.js', port: occupied, health_path: '/' };

  try {
    await runtime.ensureStarted(app, { update: (patch) => Object.assign(app, patch), timeoutMs: 3000 });
    const text = await fetch('http://127.0.0.1:' + app.port + '/').then((r) => r.text());

    assert.notEqual(app.port, occupied);
    assert.match(text, /ok:/);
  } finally {
    runtime.stopApp(app.id);
    await new Promise((resolve) => blocker.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('app runtime: rewrites published Vue asset and API absolute paths', () => {
  const html = [
    '<script type="module" crossorigin src="/assets/index-CD2_olrR.js"></script>',
    '<link rel="modulepreload" crossorigin href="/assets/vue-vendor-Cj2UIMw7.js">',
    '<link rel="stylesheet" crossorigin href="/assets/index-BkOuRwwm.css">',
    '<script>fetch("/api/health")</script>',
  ].join('\n');
  const css = '.hero{background:url(/assets/bg.png)}';
  const js = 'const api="/api/weather/current";import("/assets/chunk.js");';

  assert.match(runtime.rewritePublishedText(html, 3), /src="\/apps\/3\/assets\/index-CD2_olrR\.js"/);
  assert.match(runtime.rewritePublishedText(html, 3), /href="\/apps\/3\/assets\/index-BkOuRwwm\.css"/);
  assert.match(runtime.rewritePublishedText(html, 3), /fetch\("\/apps\/3\/api\/health"\)/);
  assert.match(runtime.rewritePublishedText(css, 3), /url\(\/apps\/3\/assets\/bg\.png\)/);
  assert.match(runtime.rewritePublishedText(js, 3), /"\/apps\/3\/api\/weather\/current"/);
  assert.match(runtime.rewritePublishedText(js, 3), /"\/apps\/3\/assets\/chunk\.js"/);
});

test('app runtime: serves module scripts with JavaScript MIME', () => {
  assert.match(runtime.publishedTextContentType('.js'), /javascript/);
  assert.match(runtime.publishedTextContentType('.mjs'), /javascript/);
  assert.ok(!/octet-stream/.test(runtime.publishedTextContentType('.js')));
});

test('app runtime: gives Java and Spring apps longer startup timeout', () => {
  assert.ok(runtime.startupTimeoutMs({ start_cmd: 'cd backend && mvn spring-boot:run -DskipTests' }) >= 45000);
  assert.ok(runtime.startupTimeoutMs({ start_cmd: 'java -jar target/app.jar' }) >= 45000);
  assert.equal(runtime.startupTimeoutMs({ start_cmd: 'node server.js' }), 8000);
});

test('app runtime: prefers built Spring Boot jar over maven run command', () => {
  const dir = tmp('orch-app-spring-jar');
  fs.mkdirSync(path.join(dir, 'backend', 'target'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backend', 'target', 'weather-app-1.0.0-SNAPSHOT.jar'), 'jar', 'utf8');

  const cmd = runtime.optimizedStartCmd({ dir, start_cmd: 'cd backend && mvn spring-boot:run -DskipTests' });

  assert.match(cmd, /java -jar/);
  assert.match(cmd, /backend\/target\/weather-app-1\.0\.0-SNAPSHOT\.jar/);
  assert.ok(!/spring-boot:run/.test(cmd));
  fs.rmSync(dir, { recursive: true, force: true });
});
