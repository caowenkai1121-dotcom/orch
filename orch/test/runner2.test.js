const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../store');
const { runTask } = require('../runner');

test('usage 落库 + 事件记录', async () => {
  const store = open(':memory:'); store.seed();
  const id = store.createTask('x', 'p', 'o');
  const a = { async run({ onUsage }) { onUsage({ input: 10, output: 5, cost: 0.001 }); return { output: 'ok', success: true }; } };
  const runs = new Map();
  await runTask(id, { store, adapters: { claude: a }, workspace: { make: () => '.' }, runs, onEvent: () => {}, makePlan: async () => ({ steps: [{ id: 'dev', agent: 'claude', prompt: 'p', deps: [] }] }) });
  assert.equal(store.taskUsage(id).input, 10);
  assert.ok(store.getEvents(id).length >= 1);
});
