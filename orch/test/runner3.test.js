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
