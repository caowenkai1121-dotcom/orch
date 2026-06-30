const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../store');
const api = require('../api');

function makeStore() {
  const store = open(':memory:');
  store.seed(); // claude/codex agent 定义入库,api 的 roleMap 据此派生

  const taskId = Number(store.createTask('Build login', 'CRM'));
  store.setTaskStatus(taskId, 'running');
  store.setStep(taskId, 'dev', 'claude', 'done', 'dev output');
  store.setStep(taskId, 'qa', 'codex', 'running', null);
  store.addLog(taskId, 'dev', 'dev finished');
  store.addLog(taskId, 'qa', 'qa started');

  const failedId = Number(store.createTask('Fix report', 'BI'));
  store.setTaskStatus(failedId, 'failed');
  store.setStep(failedId, 'fix', 'claude', 'failed', 'boom');
  store.addLog(failedId, 'fix', 'failed line');

  return { store, taskId, failedId };
}

test('buildAll 从真实任务派生 Maestro 总览数据', () => {
  const { store, taskId, failedId } = makeStore();

  const all = api.buildAll(store);

  assert.equal(all.counts.totalTasks, 2);
  assert.equal(all.counts.totalAgents, 2);
  assert.equal(all.counts.runningTasks, 1);
  assert.equal(all.counts.failed, 1);

  const codex = all.agents.find((a) => a.id === 'codex');
  assert.equal(codex.status, 'working');
  assert.equal(codex.taskId, taskId);
  assert.equal(codex.progress, 50);
  assert.equal(codex.action, 'qa started');

  const claude = all.agents.find((a) => a.id === 'claude');
  assert.equal(claude.status, 'idle');
  assert.equal(claude.success, '50%');

  const crm = all.projects.find((p) => p.name === 'CRM');
  assert.equal(crm.progress, 50);
  assert.equal(crm.sk, 'working');
  assert.equal(crm.agentCount, 2);
  assert.deepEqual([...crm.depts].sort(), ['dev', 'qa']);
  assert.deepEqual(crm.tasks, [taskId]);

  const tasks = Object.fromEntries(all.tasks.map((t) => [t.id, t]));
  assert.equal(tasks[taskId].sk, 'working');
  assert.deepEqual(tasks[taskId].agents.sort(), ['claude', 'codex']);
  assert.equal(tasks[failedId].sk, 'failed');

  assert.equal(all.boards.dev.done.length, 1);
  assert.equal(all.boards.qa.doing.length, 1);
});

test('relay 返回步骤最新日志和失败回退状态', () => {
  const { store, taskId, failedId } = makeStore();

  const relay = api.relay(store, taskId);
  const dev = relay.find((r) => r.title === 'dev');
  const qa = relay.find((r) => r.title === 'qa');

  assert.equal(dev.who, 'Claude');
  assert.equal(dev.desc, 'dev finished');
  assert.equal(dev.sk, 'done');
  assert.equal(dev.back, false);

  assert.equal(qa.who, 'Codex');
  assert.equal(qa.desc, 'qa started');
  assert.equal(qa.sk, 'working');

  const failed = api.relay(store, failedId).find((r) => r.title === 'fix');
  assert.equal(failed.sk, 'failed');
  assert.equal(failed.back, true);
  assert.equal(failed.desc, 'failed line');
});

test('plan 展开普通步骤和 loop body 并覆盖真实步骤状态', () => {
  const store = open(':memory:');
  store.seed();
  const id = Number(store.createTask('Ship feature', 'CRM'));
  store.setPlan(id, { steps: [
    { id: 'dev', agent: 'claude', deps: [] },
    { id: 'loop', type: 'loop', body: [
      { id: 'fix', agent: 'codex' },
    ] },
  ] });
  store.setStep(id, 'fix', 'codex', 'done', 'ok');

  const plan = api.plan(store, id);
  const dev = plan.find((p) => p.title === 'dev');
  const fix = plan.find((p) => p.title === 'fix');

  assert.equal(plan.length, 2);
  assert.equal(dev.n, 1);
  assert.equal(dev.agent, 'Claude');
  assert.equal(dev.sk, 'queued');
  assert.equal(fix.n, 2);
  assert.equal(fix.agent, 'Codex');
  assert.equal(fix.sk, 'done');
  assert.ok(fix.dep);
});

test('agentLog 只返回指定 agent 的真实日志', () => {
  const { store } = makeStore();

  const logs = api.agentLog(store, 'claude', 10);
  const text = logs.join('\n');

  assert.equal(logs.length, 2);
  assert.match(text, /dev finished/);
  assert.match(text, /failed line/);
  assert.doesNotMatch(text, /qa started/);
});
