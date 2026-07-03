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

test('服务重启:running 僵尸任务标记失败可重试', () => {
  const { recoverZombies } = require('../bootstrap');
  const store = require('../store').open(':memory:'); store.seed();
  const id = store.createTask('活', '默认项目', 'admin', {});
  store.setTaskStatus(id, 'running');
  store.setStep(id, 'a', 'claude', 'done', 'ok');
  store.setStep(id, 'b', 'claude', 'running', null);
  recoverZombies(store);
  const t = store.getTask(id);
  assert.equal(t.status, 'failed');                                   // 任务可重试
  assert.equal(t.steps.find((s) => s.step_id === 'a').status, 'done');   // 已完成保留
  assert.equal(t.steps.find((s) => s.step_id === 'b').status, 'failed'); // 运行中转失败
});

test('限额自动重试:排定事件+提示日志,非限额失败不排', () => {
  const { open } = require('../store');
  const runner = require('../runner');
  // 通过 execute 私有入口不可达,直接测 scheduleAutoRetry 导出? 未导出——用 retryFailed 场景侧测:
  const store = open(':memory:'); store.seed();
  const id = store.createTask('活', '默认项目', 'admin', {});
  store.setPlan(id, { steps: [{ id: 'a', agent: 'x', prompt: 'p', deps: [] }] });
  store.setStep(id, 'a', 'x', 'failed', "You've hit your session limit · resets 1:50pm");
  store.setTaskStatus(id, 'failed');
  // 模拟 execute 尾部行为:直接 require 内部函数不可,改由 module 导出验证
  assert.ok(typeof runner.scheduleAutoRetry === 'function');
  runner.scheduleAutoRetry(id, { store, adapters: {}, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {} });
  const evs = store.getEvents(id).filter((e) => e.type === 'auto_retry');
  assert.equal(evs.length, 1);
  // 第3次不再排
  store.addEvent(id, 'auto_retry', {}); // 手动补到2
  runner.scheduleAutoRetry(id, { store, adapters: {}, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {} });
  assert.equal(store.getEvents(id).filter((e) => e.type === 'auto_retry').length, 2); // 不增
  // 非限额失败不排
  const id2 = store.createTask('活2', '默认项目', 'admin', {});
  store.setStep(id2, 'a', 'x', 'failed', '普通错误');
  store.setTaskStatus(id2, 'failed');
  runner.scheduleAutoRetry(id2, { store, adapters: {}, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {} });
  assert.equal(store.getEvents(id2).filter((e) => e.type === 'auto_retry').length, 0);
});

test('经验沉淀:复盘写入员工与总调度memo,每任务一次', async () => {
  const { open } = require('../store');
  const { harvestExperience } = require('../runner');
  const store = open(':memory:'); store.seed();
  const id = store.createTask('活', '默认项目', 'admin', {});
  store.setPlan(id, { steps: [{ id: 'a', agent: 'claude', role: 'engineering-frontend-developer', prompt: 'p', deps: [] }] });
  store.setStep(id, 'a', 'claude', 'done', '页面完成,踩坑:file://被封');
  store.setTaskStatus(id, 'done');
  const fakeClaude = { async run() { return { output: '{"employees":{"engineering-frontend-developer":"file://被封时起本地http服务"},"chief":"单步任务无需质量门"}', success: true }; } };
  await harvestExperience(id, { store, adapters: { claude: fakeClaude } });
  assert.match(store.getRole('engineering-frontend-developer').memo, /http服务/);
  assert.match(store.getRole('chief-orchestrator').memo, /质量门/);
  // 再跑一次:不重复复盘
  await harvestExperience(id, { store, adapters: { claude: { async run() { throw new Error('不应再调'); } } } });
});
