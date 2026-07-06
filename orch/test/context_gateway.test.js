const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ctx = require('../context_gateway');

function tmpDir(name) {
  const dir = path.join(os.tmpdir(), name + '-' + process.pid + '-' + Date.now());
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('上下文网关:task scope 只检索指定任务子目录', () => {
  const dir = tmpDir('orch-context-scope');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'hit.md'), '# 命中\n\nUNIQUE_SCOPE_HIT SQLite 约定', 'utf8');
  fs.writeFileSync(path.join(dir, 'root.md'), '# 根目录\n\nUNIQUE_SCOPE_ROOT SQLite 约定', 'utf8');

  const hits = ctx.search({ taskDir: dir, query: 'SQLite', scopes: ['task://docs'], limit: 5 });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].rel, 'docs/hit.md');
  assert.match(hits[0].snip, /UNIQUE_SCOPE_HIT/);
  assert.doesNotMatch(JSON.stringify(hits), /UNIQUE_SCOPE_ROOT/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('上下文网关:拒绝越过任务目录的 file scope', async () => {
  const dir = tmpDir('orch-context-deny');
  const outside = tmpDir('orch-context-outside');
  fs.writeFileSync(path.join(outside, 'secret.md'), '# 外部\n\nUNIQUE_OUTSIDE_CONTEXT', 'utf8');

  const pre = await ctx.preflight({ taskDir: dir, scopes: ['file://' + outside] });
  const hits = ctx.search({ taskDir: dir, query: 'UNIQUE_OUTSIDE_CONTEXT', scopes: ['file://' + outside], limit: 5 });

  assert.equal(pre.ok, false);
  assert.equal(pre.scopes[0].ok, false);
  assert.match(pre.scopes[0].reason, /outside/);
  assert.deepEqual(hits, []);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('上下文网关:写入外部线程上下文并可被默认任务 scope 检索', () => {
  const dir = tmpDir('orch-context-thread');
  const rel = ctx.writeExternalContext(dir, { source: 'webhook', thread: '用户: 需要遵守 UNIQUE_THREAD_CONTEXT 约定', context: '额外背景: SQLite' });

  const hits = ctx.search({ taskDir: dir, query: 'UNIQUE_THREAD_CONTEXT SQLite', limit: 5 });

  assert.equal(rel, '上下文/外部入口.md');
  assert.ok(fs.existsSync(path.join(dir, rel)));
  assert.ok(hits.some((h) => h.rel === rel && /UNIQUE_THREAD_CONTEXT/.test(h.snip)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('上下文网关:MFS scope 无本地服务时只预检提示,不影响本地检索', async () => {
  const dir = tmpDir('orch-context-mfs');
  fs.writeFileSync(path.join(dir, 'local.md'), '# 本地\n\nUNIQUE_LOCAL_CONTEXT', 'utf8');

  const pre = await ctx.preflight({ taskDir: dir, scopes: ['task://', 'mfs://team-memory'], checkMfs: async () => false });
  const hits = ctx.search({ taskDir: dir, query: 'UNIQUE_LOCAL_CONTEXT', scopes: ['task://', 'mfs://team-memory'], limit: 5 });

  assert.equal(pre.ok, false);
  assert.equal(pre.mfs.available, false);
  assert.ok(hits.some((h) => h.rel === 'local.md'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('上下文网关:跳过会议纪要避免上一轮会议污染检索', () => {
  const dir = tmpDir('orch-context-meeting-minutes');
  fs.writeFileSync(path.join(dir, '会议纪要.md'), '# 会议纪要\n\nUNIQUE_OLD_MEETING_CONTEXT 旧结论', 'utf8');
  fs.writeFileSync(path.join(dir, '项目知识.md'), '# 项目知识\n\nUNIQUE_REAL_KNOWLEDGE 新约定', 'utf8');

  const oldHits = ctx.search({ taskDir: dir, query: 'UNIQUE_OLD_MEETING_CONTEXT', limit: 5 });
  const realHits = ctx.search({ taskDir: dir, query: 'UNIQUE_REAL_KNOWLEDGE', limit: 5 });

  assert.ok(!oldHits.some((h) => h.rel === '会议纪要.md'));
  assert.doesNotMatch(JSON.stringify(oldHits), /UNIQUE_OLD_MEETING_CONTEXT/);
  assert.ok(realHits.some((h) => h.rel === '项目知识.md'));
  fs.rmSync(dir, { recursive: true, force: true });
});
