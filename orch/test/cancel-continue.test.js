const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../store');
const { runTask } = require('../runner');

// #6 回归:任务被取消后残留 {cancelled:true} 的 rec,再次运行(继续/重跑)须清掉该标志,否则卡在 planning(前端显排队)不动
test('#6 残留 cancelled 的 rec 复用时被清除,任务不再卡在排队', async () => {
  const store = open(':memory:');
  const id = store.createTask('随便');
  const echo = { async run({ prompt }) { return { output: prompt, success: true }; } };
  const runs = new Map();
  runs.set(id, { cancelled: true, paused: false, children: new Set(), skip: new Set(), notes: [] }); // 模拟取消后残留
  await runTask(id, {
    store, adapters: { claude: echo }, workspace: { make: () => '.' }, runs, onEvent: () => {},
    makePlan: async () => ({ task: 'x', steps: [{ id: 'build', agent: 'claude', prompt: 'p', deps: [] }] }),
  });
  assert.equal(store.getTask(id).status, 'done', '残留 cancelled 应被清除,任务应跑完而非卡住');
});
