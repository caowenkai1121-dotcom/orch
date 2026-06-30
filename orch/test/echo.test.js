const { test } = require('node:test');
const assert = require('node:assert');
const echo = require('../adapters/echo');

test('echo 回显 prompt 且默认成功', async () => {
  const lines = [];
  const r = await echo.run({ prompt: '你好', onLine: (l) => lines.push(l) });
  assert.equal(r.success, true);
  assert.match(r.output, /你好/);
  assert.deepEqual(lines, ['你好']);
});

test('prompt 含 FAIL 则失败', async () => {
  const r = await echo.run({ prompt: 'FAIL here', onLine: () => {} });
  assert.equal(r.success, false);
});
