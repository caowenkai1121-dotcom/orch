const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../store');
const { runTask } = require('../runner');

test('runTask 用模板跑通并落库(全 echo 适配器)', async () => {
  const store = open(':memory:');
  const id = store.createTask('随便');
  const echo = { async run({ prompt, onLine }) { onLine(prompt); return { output: prompt, success: true }; } };
  await runTask(id, {
    store,
    adapters: { claude: echo, codex: echo },
    workspace: { make: () => '.', merge: () => {} },
    onEvent: () => {},
    makePlan: async () => ({ task: 'x', steps: [
      { id: 'dev', agent: 'claude', prompt: 'p', deps: [] },
    ] }),
  });
  const t = store.getTask(id);
  assert.equal(t.status, 'done');
  assert.equal(t.steps[0].status, 'done');
});
