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
  assert.equal(all.counts.pendingRetry, 0); // 失败任务无 auto_retry 事件 → 不算待自动重试

  // 排定过自动重试(次数未用完)的失败任务 → 计入 pendingRetry
  const limitId = Number(store.createTask('限额任务', 'BI'));
  store.setTaskStatus(limitId, 'failed');
  store.addEvent(limitId, 'auto_retry', { inMin: 30 });
  assert.equal(api.buildAll(store).counts.pendingRetry, 1);

  // 成本上限透传到任务 VM(供详情显示"上限 $X")
  const budId = Number(store.createTask('带预算任务', 'BI', 'admin', { budget: 0.5 }));
  const bt = api.buildAll(store).tasks.find((x) => x.id === budId);
  assert.equal(bt.budget, 0.5);

  // 「再来一个」配置克隆:任务VM透出 approve/ask/isolate/models
  const cfgId = Number(store.createTask('配置任务', 'BI', 'admin', { approve: 1, ask: 1, isolate: 'worktree', models: { claude: { model: 'x', effort: 'high' } } }));
  const cvm = api.buildAll(store).tasks.find((x) => x.id === cfgId);
  assert.equal(cvm.approve, true); assert.equal(cvm.ask, true); assert.equal(cvm.isolate, 'worktree');
  assert.deepEqual(cvm.models, { claude: { model: 'x', effort: 'high' } });

  // 全局日成本上限透传(env→counts.dailyBudget),供仪表盘显示
  process.env.ORCH_DAILY_BUDGET = '2.5';
  assert.equal(api.buildAll(store).counts.dailyBudget, 2.5);
  delete process.env.ORCH_DAILY_BUDGET;
  assert.equal(api.buildAll(store).counts.dailyBudget, 0);

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
  assert.deepEqual([...crm.depts].sort(), ['engineering', 'testing']);
  assert.deepEqual(crm.tasks, [taskId]);

  const tasks = Object.fromEntries(all.tasks.map((t) => [t.id, t]));
  assert.equal(tasks[taskId].sk, 'working');
  assert.deepEqual(tasks[taskId].agents.sort(), ['claude', 'codex']);
  assert.equal(tasks[failedId].sk, 'failed');

  assert.equal(all.boards.engineering.done.length, 1);
  assert.equal(all.boards.testing.doing.length, 1);
});

test('relay 返回步骤最新日志和失败回退状态', () => {
  const { store, taskId, failedId } = makeStore();

  const relay = api.relay(store, taskId);
  const dev = relay.find((r) => r.title === 'dev');
  const qa = relay.find((r) => r.title === 'qa');

  assert.equal(dev.who, 'Claude');
  assert.equal(dev.desc, 'dev output'); // desc 优先用步骤产出摘要(step.output)
  assert.equal(dev.sk, 'done');
  assert.equal(dev.back, false);

  assert.equal(qa.who, 'Codex');
  assert.equal(qa.desc, 'qa started'); // qa 无 output → 回退最新日志
  assert.equal(qa.sk, 'working');

  const failed = api.relay(store, failedId).find((r) => r.title === 'fix');
  assert.equal(failed.sk, 'failed');
  assert.equal(failed.back, true);
  assert.equal(failed.desc, 'boom'); // 有 output 用 output
});

test('plan 展开普通步骤和 loop body 并覆盖真实步骤状态', () => {
  const store = open(':memory:');
  store.seed();
  const id = Number(store.createTask('Ship feature', 'CRM'));
  store.setPlan(id, { steps: [
    { id: 'dev', agent: 'claude', deps: [] },
    { id: 'loop', type: 'loop', deps: ['dev'], body: [
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
  assert.deepEqual(fix.deps, ['dev']); // loop 展开:body[0] 继承 loop 的依赖(画布连线不断)
});

test('plan 暴露验收标准与知识引用标签', () => {
  const store = open(':memory:');
  store.seed();
  const id = Number(store.createTask('实现缓存', 'CRM'));
  store.setPlan(id, { diagnostics: { score: 82, issues: [{ level: 'warn', message: '复杂任务缺质量门' }] }, steps: [
    { id: 'impl_cache', agent: 'claude', prompt: '实现缓存', deps: [], expected_outcome: '缓存文件真实落盘' },
  ] });
  store.addEvent(id, 'knowledge', { step: 'impl_cache', hits: [{ file: '项目知识.md', score: 2, snippet: 'SQLite 回滚' }] });

  const row = api.plan(store, id)[0];
  assert.match(row.outcome, /真实落盘/);
  assert.match(row.knowledgeLabel, /项目知识\.md/);
  assert.match(row.healthLabel, /82/);
});

test('#8 why-not:未就绪步给出为何未推进(已完成/排队槽位/等上游)', () => {
  const store = open(':memory:');
  store.seed();
  const id = Number(store.createTask('Ship', 'CRM'));
  store.setPlan(id, { steps: [
    { id: 'a', agent: 'claude', deps: [] },
    { id: 'b', agent: 'claude', deps: ['a'] },
    { id: 'c', agent: 'claude', deps: ['b'] },
  ] });
  store.setStep(id, 'a', 'claude', 'done', 'ok');    // a 完成
  store.setStep(id, 'b', 'claude', 'waiting', null); // b 依赖已满足但在排队等槽位
  const plan = api.plan(store, id);
  const by = (x) => plan.find((p) => p.title === x);
  assert.equal(by('a').blockReason, '');                 // 已完成:无阻塞原因
  assert.match(by('b').blockReason, /排队等执行器槽位/);   // 依赖满足但并发满 → 排队
  assert.match(by('c').blockReason, /等待上游完成.*b/);    // 上游 b 未完成
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

test('plan 为画布节点返回中文标题、角色、耗时和日志详情', () => {
  const store = open(':memory:');
  store.seed();
  const id = Number(store.createTask('修复登录按钮文案', 'CRM'));
  store.setPlan(id, { steps: [
    { id: 'impl_frontend', agent: 'claude', role: 'engineering-frontend-developer', prompt: '修复登录按钮文案', deps: [], expected_outcome: '按钮文案已修复并可验收' },
  ] });
  store.addEvent(id, 'status', { step: 'impl_frontend', v: 'running' });
  store.addEvent(id, 'status', { step: 'impl_frontend', v: 'done' });
  store.setStep(id, 'impl_frontend', 'claude', 'done', 'done output');
  store.addLog(id, 'impl_frontend', '正在修改登录按钮文案');

  const row = api.plan(store, id)[0];
  assert.match(row.shortTitle, /前端|按钮|文案|实现|修复/);
  assert.match(row.roleLine, /工程部|前端开发/);
  assert.match(row.executorLabel, /Claude/);
  assert.match(row.durationLabel, /\d+s|⏱/);
  assert.match(row.logPreview, /按钮文案/);
  assert.match(row.logText, /按钮文案/);
  assert.equal(row.stepId, 'impl_frontend');
});

test('plan 无员工角色时画布显示未分配员工和执行器兜底', () => {
  const store = open(':memory:');
  store.seed();
  const id = Number(store.createTask('单执行器修复', 'CRM'));
  store.setPlan(id, { steps: [
    { id: 'build', agent: 'claude', prompt: '修复问题', deps: [] },
  ] });

  const row = api.plan(store, id)[0];
  assert.match(row.roleLine, /未分配员工/);
  assert.match(row.roleLine, /Claude/);
  assert.match(row.executorLabel, /Claude/);
  assert.match(row.metaLine, /未分配员工/);
  assert.doesNotMatch(row.metaLine, /Claude · Claude/);
});

test('plan 为画布节点返回流程类型和编排理由', () => {
  const store = open(':memory:');
  store.seed();
  const id = Number(store.createTask('开发股票交易网站', 'Trading'));
  store.setPlan(id, {
    process: { type: 'risk_review', reason: '交易任务需要风险复核', manager_role: 'engineering-backend-architect', debate_rounds: 1, risk_review: true },
    meeting: { agenda: ['目标澄清', '方案推进', '反方质询', '风险复核', '经理裁决'] },
    steps: [
      { id: 'risk_review', agent: 'codex', role: 'security-appsec-engineer', prompt: '风险复核', deps: [], expected_outcome: '风险复核完成' },
    ],
  });

  const row = api.plan(store, id)[0];
  assert.equal(row.processType, 'risk_review');
  assert.match(row.processLabel, /风险复核/);
  assert.match(row.orchestrationReason, /交易任务/);
  assert.match(row.meetingAgenda, /反方质询/);
});

test('meeting 返回显式主持人信息', () => {
  const store = open(':memory:');
  store.seed();
  const id = Number(store.createTask('开发复杂系统', 'CRM'));
  store.setPlan(id, { meeting: { hostRole: 'chief-orchestrator', attendees: ['engineering-backend-architect'], meetIds: ['meet_arch'], decideId: 'decide_plan' }, steps: [
    { id: 'meet_arch', role: 'engineering-backend-architect', agent: 'claude', deps: [] },
    { id: 'decide_plan', role: 'chief-orchestrator', agent: 'claude', deps: ['meet_arch'] },
  ] });
  store.createMeeting(id, ['engineering-backend-architect']);

  const mt = api.meeting(store, id);
  assert.equal(mt.host.id, 'chief-orchestrator');
  assert.match(mt.host.name, /总调度/);
  assert.ok(!mt.attendees.some((a) => a.id === 'chief-orchestrator'));
});

test('buildAll 为已结束会议保留任务入口摘要', () => {
  const store = open(':memory:');
  store.seed();
  const id = Number(store.createTask('开发ERP系统', 'ERP'));
  store.setTaskStatus(id, 'done');
  store.createMeeting(id, ['product-manager']);
  store.addMeetingMsg(id, { role: 'system', name: '会议室', text: '会议开始' });
  store.addMeetingMsg(id, { role: 'product-manager', name: '产品经理', text: '形成结论' });
  store.setMeetingStatus(id, 'closed', '会议结论');

  const row = api.buildAll(store).tasks.find((t) => t.id === id);

  assert.equal(row.hasMeeting, true);
  assert.equal(row.meetingStatus, 'closed');
  assert.equal(row.meetingMsgCount, 2);
});
