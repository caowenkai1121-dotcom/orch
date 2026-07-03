const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../store');
const { runTask, runApproved } = require('../runner');

test('审批模式:出 plan 后暂停不执行', async () => {
  const store = open(':memory:'); store.seed();
  const id = store.createTask('x', 'p', 'o', { approve: 1 });
  let ran = 0;
  const a = { async run() { ran++; return { output: '', success: true }; } };
  await runTask(id, { store, adapters: { claude: a }, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {}, makePlan: async () => ({ steps: [{ id: 'a', agent: 'claude', prompt: 'p', deps: [] }] }) });
  assert.equal(ran, 0);
  assert.equal(store.getTask(id).status, 'awaiting');
});

test('批准后用给定 plan 执行', async () => {
  const store = open(':memory:'); store.seed();
  const id = store.createTask('x', 'p', 'o', { approve: 1 });
  let ran = 0;
  const a = { async run() { ran++; return { output: 'ok', success: true }; } };
  const deps = { store, adapters: { claude: a }, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {} };
  await runApproved(id, deps, { steps: [{ id: 'a', agent: 'claude', prompt: 'p', deps: [] }] });
  assert.equal(ran, 1);
  assert.equal(store.getTask(id).status, 'done');
});

test('重试失败步骤:已完成不重跑,只跑失败的', async () => {
  const { open } = require('../store');
  const { retryFailed } = require('../runner');
  const store = open(':memory:'); store.seed();
  const id = store.createTask('活', '默认项目', 'admin', {});
  store.setPlan(id, { steps: [
    { id: 'a', agent: 'ok', prompt: 'p', deps: [] },
    { id: 'b', agent: 'ok', prompt: 'p', deps: ['a'] },
  ] });
  store.setStep(id, 'a', 'ok', 'done', '产出A');   // a 已完成
  store.setStep(id, 'b', 'ok', 'failed', null);    // b 失败(如限额)
  store.setTaskStatus(id, 'failed');
  const ran = [];
  const ok = { async run({ prompt }) { ran.push(prompt.includes('产出A')); return { output: 'B完成', success: true }; } };
  await retryFailed(id, { store, adapters: { ok }, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {} });
  assert.equal(ran.length, 1);                      // 只重跑 b
  assert.equal(ran[0], true);                       // b 收到 a 的交接产出
  assert.equal(store.getTask(id).status, 'done');   // 任务转成功
});
