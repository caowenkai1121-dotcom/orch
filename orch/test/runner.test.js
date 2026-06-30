const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../store');
const { runTask } = require('../runner');

test('runTask 落库且 log 事件带 agent', async () => {
  const store = open(':memory:');
  const id = store.createTask('随便');
  const echo = { async run({ prompt, onLine }) { onLine(prompt); return { output: prompt, success: true }; } };
  const evs = [];
  await runTask(id, {
    store, adapters: { claude: echo, codex: echo },
    workspace: { make: () => '.', merge: () => {} },
    onEvent: (e) => evs.push(e),
    makePlan: async () => ({ task: 'x', steps: [{ id: 'dev', agent: 'claude', prompt: 'p', deps: [] }] }),
  });
  assert.equal(store.getTask(id).status, 'done');
  const log = evs.find((e) => e.type === 'log');
  assert.equal(log.agent, 'claude');
});
