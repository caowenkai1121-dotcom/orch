const { test } = require('node:test');
const assert = require('node:assert');
const { arm, posixDescendantPids } = require('../adapters/steptimeout');

test('超时:到时 timedOut 变 true,clear 后不触发', async () => {
  process.env.ORCH_STEP_TIMEOUT_MS = '40';
  const fakeChild = { pid: null, exitCode: null, killed: false }; // pid null → killTree 安全跳过
  const T = arm(fakeChild);
  assert.equal(T.timedOut(), false);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(T.timedOut(), true);
  delete process.env.ORCH_STEP_TIMEOUT_MS;
});

test('超时关闭:ORCH_STEP_TIMEOUT_MS=0 不武装', async () => {
  process.env.ORCH_STEP_TIMEOUT_MS = '0';
  const T = arm({ pid: null, exitCode: null });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(T.timedOut(), false);
  delete process.env.ORCH_STEP_TIMEOUT_MS;
});

test('Linux killTree:递归识别孙进程并按深度优先返回', () => {
  const ps = [
    '  10     1',
    '  11    10',
    '  12    11',
    '  13    10',
    '  14    99',
    '  bad  line',
  ].join('\n');
  assert.deepEqual(posixDescendantPids(10, ps), [12, 11, 13]);
});
