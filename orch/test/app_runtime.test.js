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

test('app runtime: infers fullstack app from frontend dist and built backend jar', () => {
  const dir = tmp('orch-app-infer-fullstack');
  fs.mkdirSync(path.join(dir, 'frontend', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backend', 'target'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'frontend', 'dist', 'index.html'), '<h1>Weather</h1>', 'utf8');
  fs.writeFileSync(path.join(dir, 'backend', 'target', 'weather-tool-1.0.0.jar'), 'jar', 'utf8');

  const app = runtime.detect(dir);

  assert.equal(app.type, 'fullstack');
  assert.equal(app.entry, 'frontend/dist/index.html');
  assert.equal(app.staticDir, 'frontend/dist');
  assert.match(app.startCmd, /java -jar/);
  assert.match(app.startCmd, /backend\/target\/weather-tool-1\.0\.0\.jar/);
  assert.equal(app.apiPrefix, '/api');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('app runtime: keeps fullstack detection when publish entry is selected manually', () => {
  const dir = tmp('orch-app-selected-entry-fullstack');
  fs.mkdirSync(path.join(dir, 'frontend', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backend', 'target'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'frontend', 'dist', 'index.html'), '<h1>Weather</h1>', 'utf8');
  fs.writeFileSync(path.join(dir, 'backend', 'target', 'weather-tool-1.0.0.jar'), 'jar', 'utf8');

  const app = runtime.detect(dir, { entry: 'frontend/dist/index.html' });

  assert.equal(app.type, 'fullstack');
  assert.equal(app.entry, 'frontend/dist/index.html');
  assert.match(app.startCmd, /java -jar/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('app runtime: produces deployment diagnostics for publish readiness', () => {
  const dir = tmp('orch-app-diagnostics');
  fs.mkdirSync(path.join(dir, 'frontend', 'dist', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backend', 'target'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'frontend', 'dist', 'index.html'), '<script type="module" src="/assets/index.js"></script>', 'utf8');
  fs.writeFileSync(path.join(dir, 'frontend', 'dist', 'assets', 'index.js'), 'fetch("/api/health")', 'utf8');
  fs.writeFileSync(path.join(dir, 'backend', 'target', 'weather-tool-1.0.0.jar'), 'jar', 'utf8');

  const report = runtime.deploymentDiagnostics(dir);

  assert.equal(report.ok, true);
  assert.equal(report.app.type, 'fullstack');
  assert.equal(report.app.entry, 'frontend/dist/index.html');
  assert.ok(report.checks.some((x) => x.code === 'entry_exists' && x.ok));
  assert.ok(report.checks.some((x) => x.code === 'backend_start' && x.ok));
  assert.ok(report.warnings.some((x) => /orch\.app\.json/.test(x)));
  assert.ok(report.recommendations.some((x) => /应用广场|发布|部署/.test(x)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('app runtime: deployment diagnostics fails when published asset is missing', () => {
  const dir = tmp('orch-app-missing-asset');
  fs.mkdirSync(path.join(dir, 'frontend', 'dist', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backend', 'target'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'frontend', 'dist', 'index.html'), [
    '<script type="module" src="/assets/index.js"></script>',
    '<link rel="stylesheet" href="/assets/missing.css">',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, 'frontend', 'dist', 'assets', 'index.js'), 'console.log("ok")', 'utf8');
  fs.writeFileSync(path.join(dir, 'backend', 'target', 'weather-tool-1.0.0.jar'), 'jar', 'utf8');

  const report = runtime.deploymentDiagnostics(dir);

  assert.equal(report.ok, false);
  assert.ok(report.checks.some((x) => x.code === 'static_asset_refs' && !x.ok));
  assert.ok(report.errors.some((x) => /missing\.css/.test(x)));
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

test('app runtime: reuses live running backend after orchestrator restart', async () => {
  const live = http.createServer((req, res) => res.end('live'));
  await new Promise((resolve) => live.listen(0, '127.0.0.1', resolve));
  const port = live.address().port;
  const dir = tmp('orch-app-reuse-live');
  fs.writeFileSync(path.join(dir, 'spawned.js'), [
    "const fs = require('fs');",
    "fs.writeFileSync('spawned.txt', 'spawned');",
    "setInterval(() => {}, 1000);",
  ].join('\n'), 'utf8');
  const app = { id: 101, dir, status: 'running', start_cmd: 'node spawned.js', port, health_path: '/' };

  try {
    await runtime.ensureStarted(app, { update: (patch) => Object.assign(app, patch), timeoutMs: 1000 });

    assert.equal(app.port, port);
    assert.equal(app.status, 'running');
    assert.ok(!fs.existsSync(path.join(dir, 'spawned.txt')));
  } finally {
    await new Promise((resolve) => live.close(resolve));
    runtime.stopApp(app.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('app runtime: rewrites published Vue asset and API absolute paths', () => {
  const html = [
    '<script type="module" crossorigin src="/assets/index-CD2_olrR.js"></script>',
    '<link rel="modulepreload" crossorigin href="/assets/vue-vendor-Cj2UIMw7.js">',
    '<link rel="stylesheet" crossorigin href="/assets/index-BkOuRwwm.css">',
    '<link rel="icon" href="/favicon.svg">',
    '<img src="/logo.png">',
    '<a href="/docs">docs</a>',
    '<script>fetch("/api/health")</script>',
  ].join('\n');
  const css = '.hero{background:url(/assets/bg.png)}';
  const js = 'const api="/api/weather/current";import("/assets/chunk.js");';

  assert.match(runtime.rewritePublishedText(html, 3), /src="\/apps\/3\/assets\/index-CD2_olrR\.js"/);
  assert.match(runtime.rewritePublishedText(html, 3), /href="\/apps\/3\/assets\/index-BkOuRwwm\.css"/);
  assert.match(runtime.rewritePublishedText(html, 3), /href="\/apps\/3\/favicon\.svg"/);
  assert.match(runtime.rewritePublishedText(html, 3), /src="\/apps\/3\/logo\.png"/);
  assert.match(runtime.rewritePublishedText(html, 3), /href="\/docs"/);
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

test('app runtime: rewrites Vite dynamic preload asset paths', () => {
  const js = 'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/WeatherDashboard.js","assets/WeatherDashboard.css","./local.js"])))=>i.map(i=>d[i]);';

  const out = runtime.rewritePublishedText(js, 3);

  assert.match(out, /"apps\/3\/assets\/WeatherDashboard\.js"/);
  assert.match(out, /"apps\/3\/assets\/WeatherDashboard\.css"/);
  assert.match(out, /"\.\/local\.js"/);
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
