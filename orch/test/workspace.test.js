const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeWorkspace, metaDir } = require('../workspace');

test('metaDir:中性 scratch 目录,存在且不在 orch 源码目录内', () => {
  const d = metaDir();
  assert.ok(fs.existsSync(d));                                   // 已建好,可用作 cwd
  assert.ok(!path.resolve(d).startsWith(path.resolve(__dirname, '..'))); // 不在 orch 仓内 → 误写不污染源码
  assert.equal(metaDir(), d);                                    // 幂等
});

test('共享工作区:所有步骤返回同一根目录', () => {
  const ws = makeWorkspace('/some/root');
  assert.equal(ws.make('dev'), '/some/root');
  assert.equal(ws.make('test'), '/some/root');
});
