const { test } = require('node:test');
const assert = require('node:assert');
const { runPlan } = require('../engine');

function mkCtx(adapters) {
  return {
    adapters,
    workspace: { async make() { return '.'; } },
    onLog: () => {},
    onStatus: () => {},
  };
}
const echo = { async run({ prompt, onLine }) {
  onLine(prompt);
  return { output: prompt, success: !prompt.includes('FAIL') };
} };

test('无依赖的步骤都会跑', async () => {
  const plan = { steps: [
    { id: 'a', agent: 'echo', prompt: 'A', deps: [] },
    { id: 'b', agent: 'echo', prompt: 'B', deps: [] },
  ] };
  const done = await runPlan(plan, mkCtx({ echo }));
  assert.equal(done.a.output, 'A');
  assert.equal(done.b.output, 'B');
});

test('{prev} 注入上游输出', async () => {
  const plan = { steps: [
    { id: 'a', agent: 'echo', prompt: 'hello', deps: [] },
    { id: 'b', agent: 'echo', prompt: 'got {prev}', deps: ['a'] },
  ] };
  const done = await runPlan(plan, mkCtx({ echo }));
  assert.equal(done.b.output, 'got hello');
});

test('loop 重试到 pass', async () => {
  let n = 0;
  const counter = { async run({ prompt, onLine }) {
    onLine(prompt);
    return { output: prompt, success: n++ > 0 }; // 第一次失败,之后成功
  } };
  const plan = { steps: [
    { id: 'loop', type: 'loop', until: 'pass', max: 3, deps: [], body: [
      { id: 't', agent: 'c', prompt: 'test' },
    ] },
  ] };
  const done = await runPlan(plan, mkCtx({ c: counter }));
  assert.equal(done.loop.success, true);
  assert.equal(n, 2); // 跑了两轮
});

test('上游通过则 loop 被跳过(没坏不修)', async () => {
  let ran = 0;
  const a = { async run({ prompt, onLine }) { onLine(prompt); return { output: 'ok', success: true }; } };
  const body = { async run({ prompt, onLine }) { ran++; onLine(prompt); return { output: prompt, success: true }; } };
  const plan = { steps: [
    { id: 'test', agent: 'a', prompt: 'test', deps: [] },
    { id: 'loop', type: 'loop', until: 'pass', max: 3, deps: ['test'], body: [
      { id: 'fix', agent: 'b', prompt: 'fix' },
    ] },
  ] };
  const done = await runPlan(plan, mkCtx({ a, b: body }));
  assert.equal(done.loop.success, true);
  assert.equal(ran, 0); // test 通过,loop body 一次没跑
});
