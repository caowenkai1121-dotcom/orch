// 轮213 智能部署:根级全栈识别 / 需构建判定 / 自动构建
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const rt = require('../app_runtime');

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }
function w(dir, rel, content) { mkdir(path.dirname(path.join(dir, rel))); fs.writeFileSync(path.join(dir, rel), content, 'utf8'); }

test('detect:根级 scripts.api + server/ + dist → fullstack(DMS 布局不再误判 static)', () => {
  const dir = path.join(os.tmpdir(), 'orch-dep-fs-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); mkdir(dir);
  w(dir, 'package.json', JSON.stringify({ name: 'x', scripts: { dev: 'vite', api: 'node server/index.mjs', build: 'vite build' } }));
  w(dir, 'server/index.mjs', 'console.log(1)');
  w(dir, 'dist/index.html', '<html></html>');
  const d = rt.detect(dir, {});
  assert.equal(d.type, 'fullstack', '应判为全栈, 实际=' + d.type);
  assert.equal(d.entry, 'dist/index.html');
  assert.equal(d.startCmd, 'npm run api');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('detect:根级 server/index.mjs 无 api 脚本也识别为后端;纯 dist 无后端仍是 static', () => {
  const dir = path.join(os.tmpdir(), 'orch-dep-srv-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); mkdir(dir);
  w(dir, 'package.json', JSON.stringify({ name: 'x', scripts: {} }));
  w(dir, 'server/index.mjs', 'console.log(1)');
  w(dir, 'dist/index.html', '<html></html>');
  const d = rt.detect(dir, {});
  assert.equal(d.type, 'fullstack');
  assert.ok(/node .*server[\\/]index\.mjs/.test(d.startCmd.replace(/"/g, '')), '应推导 node server/index.mjs, 实际=' + d.startCmd);
  const dir2 = path.join(os.tmpdir(), 'orch-dep-static-' + process.pid);
  fs.rmSync(dir2, { recursive: true, force: true }); mkdir(dir2);
  w(dir2, 'dist/index.html', '<html></html>');
  assert.equal(rt.detect(dir2, {}).type, 'static');
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true });
});

test('buildNeeded:有 build 脚本无产物=true;有 dist=false;无 build 脚本=false', () => {
  const dir = path.join(os.tmpdir(), 'orch-dep-bn-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); mkdir(dir);
  w(dir, 'package.json', JSON.stringify({ scripts: { build: 'vite build' } }));
  w(dir, 'index.html', '<script type="module" src="/src/main.tsx"></script>');
  assert.equal(rt.buildNeeded(dir), true, '有 build 无 dist 应需构建');
  w(dir, 'dist/index.html', '<html></html>');
  assert.equal(rt.buildNeeded(dir), false, '有产物不再需构建');
  const dir2 = path.join(os.tmpdir(), 'orch-dep-bn2-' + process.pid);
  fs.rmSync(dir2, { recursive: true, force: true }); mkdir(dir2);
  w(dir2, 'index.html', '<html></html>');
  assert.equal(rt.buildNeeded(dir2), false, '无 package.json 纯静态不需构建');
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true });
});

test('runBuild:执行项目 build 脚本产出 dist;失败返回 stage 与日志尾', async () => {
  const dir = path.join(os.tmpdir(), 'orch-dep-rb-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); mkdir(dir);
  mkdir(path.join(dir, 'node_modules')); // 骗过 install 检查(不真装依赖)
  w(dir, 'package.json', JSON.stringify({ scripts: { build: 'node build.js' } }));
  w(dir, 'build.js', "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<html>BUILT</html>');");
  const r = await rt.runBuild(dir, () => {});
  assert.equal(r.ok, true, '构建应成功: ' + JSON.stringify(r));
  assert.ok(fs.readFileSync(path.join(dir, 'dist', 'index.html'), 'utf8').includes('BUILT'));
  w(dir, 'build.js', 'console.error("boom");process.exit(1);');
  const r2 = await rt.runBuild(dir, () => {});
  assert.equal(r2.ok, false);
  assert.equal(r2.stage, 'build');
  assert.ok(String(r2.detail).includes('boom'), '失败应带日志尾');
  fs.rmSync(dir, { recursive: true, force: true });
});
