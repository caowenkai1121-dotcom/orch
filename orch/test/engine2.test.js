const { test } = require('node:test');
const assert = require('node:assert');
const { runPlan } = require('../engine');

function ctx(adapters, extra) {
  return Object.assign({ adapters, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {} }, extra || {});
}

test('并发不超过上限', async () => {
  process.env.ORCH_CONCURRENCY = '2';
  let cur = 0, peak = 0;
  const slow = { async run() { cur++; peak = Math.max(peak, cur); await new Promise((r) => setTimeout(r, 30)); cur--; return { output: '', success: true }; } };
  const steps = Array.from({ length: 6 }, (_, i) => ({ id: 's' + i, agent: 'a', prompt: 'p', deps: [] }));
  await runPlan({ steps }, ctx({ a: slow }));
  assert.ok(peak <= 2, 'peak=' + peak);
  delete process.env.ORCH_CONCURRENCY;
});

test('取消后不再起新 step', async () => {
  let ran = 0;
  const a = { async run() { ran++; return { output: '', success: true }; } };
  let cancelled = false;
  const c = ctx({ a }, { isCancelled: () => cancelled });
  // a 依赖链:s0 -> s1;在 s0 后置取消
  const a2 = { async run() { ran++; cancelled = true; return { output: '', success: true }; } };
  const done = await runPlan({ steps: [{ id: 's0', agent: 'b', prompt: 'p', deps: [] }, { id: 's1', agent: 'a', prompt: 'p', deps: ['s0'] }] }, ctx({ a, b: a2 }, { isCancelled: () => cancelled }));
  assert.equal(ran, 1); // 只有 s0(b)跑了,取消后 s1 不跑
});

test('onUsage 透传', async () => {
  const got = [];
  const a = { async run({ onUsage }) { onUsage && onUsage({ input: 5, output: 3, cost: 0.001 }); return { output: '', success: true }; } };
  await runPlan({ steps: [{ id: 's', agent: 'a', prompt: 'p', deps: [] }] }, ctx({ a }, { onUsage: (sid, ag, u) => got.push([sid, ag, u.input]) }));
  assert.deepEqual(got, [['s', 'a', 5]]);
});
