const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { open } = require('../store');
const { runTask, countRecentFiles } = require('../runner');

test('countRecentFiles 按mtime数本步产出,排除task_plan/findings', async () => {
  const dir = path.join(os.tmpdir(), 'orch-cnt-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old.txt'), 'x');
  await new Promise((r) => setTimeout(r, 25));
  const since = Date.now();
  await new Promise((r) => setTimeout(r, 25));
  fs.writeFileSync(path.join(dir, 'new.html'), 'y');     // 本步窗口内产出
  fs.writeFileSync(path.join(dir, 'task_plan.md'), 'z'); // 引擎共享文件 → 排除
  fs.writeFileSync(path.join(dir, 'findings.md'), 'z');  // 团队共享文件 → 排除
  assert.equal(countRecentFiles(dir, since), 1);         // 只数 new.html(old.txt 早于 since;共享文件排除)
  assert.equal(countRecentFiles(dir, 0), 2);             // since=0 → old+new,仍不含共享文件
  fs.rmSync(dir, { recursive: true, force: true });
});

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
