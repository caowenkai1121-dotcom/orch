const { test } = require('node:test');
const assert = require('node:assert');
const { makeWorkspace } = require('../workspace');

test('共享工作区:所有步骤返回同一根目录', () => {
  const ws = makeWorkspace('/some/root');
  assert.equal(ws.make('dev'), '/some/root');
  assert.equal(ws.make('test'), '/some/root');
});
