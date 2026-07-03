const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../store');

test('events 追加与读取', () => {
  const s = open(':memory:'); s.seed();
  const id = s.createTask('x', 'p', 'o');
  s.addEvent(id, 'status', { step: 'dev', v: 'running' });
  const ev = s.getEvents(id);
  assert.equal(ev.length, 1);
  assert.equal(JSON.parse(ev[0].data).step, 'dev');
});
test('usage 累计', () => {
  const s = open(':memory:'); s.seed();
  const id = s.createTask('x', 'p', 'o');
  s.addUsage(id, 'dev', 'claude', { input: 100, output: 50, cost: 0.01 });
  s.addUsage(id, 'test', 'codex', { input: 20, output: 10, cost: 0.002 });
  const u = s.taskUsage(id);
  assert.equal(u.input, 120); assert.equal(u.output, 60);
  assert.ok(Math.abs(u.cost - 0.012) < 1e-9);
});
test('createTask 接受 opts', () => {
  const s = open(':memory:'); s.seed();
  const id = s.createTask('x', 'p', 'o', { budget: 5000, approve: 1, isolate: 'worktree' });
  const t = s.listTasks().find((t) => t.id === id);
  assert.equal(t.budget, 5000); assert.equal(t.approve, 1); assert.equal(t.isolate, 'worktree');
});

test('剧本与定时任务 CRUD', () => {
  const { open } = require('../store');
  const s = open(':memory:'); s.seed();
  const pid = s.addPlaybook({ name: '建站', description: 'd', plan: { steps: [{ id: 'a', prompt: '做 {task}', deps: [] }] } });
  assert.ok(s.getPlaybook(pid));
  assert.equal(s.listPlaybooks().length, 1);
  s.deletePlaybook(pid); assert.equal(s.listPlaybooks().length, 0);
  const sid = s.addSchedule({ text: '日报', owner: 'admin', spec: { kind: 'daily', at: '09:00' } });
  assert.equal(s.listSchedules().length, 1);
  s.setScheduleEnabled(sid, false);
  assert.equal(s.listSchedules()[0].enabled, 0);
  s.setScheduleRun(sid); assert.ok(s.listSchedules()[0].last_run);
  s.deleteSchedule(sid); assert.equal(s.listSchedules().length, 0);
  // hook token
  const tok = s.ensureHookToken('admin');
  assert.ok(tok && tok.length >= 32);
  assert.equal(s.ensureHookToken('admin'), tok);          // 幂等
  assert.equal(s.personByHookToken(tok).id, 'admin');
  assert.notEqual(s.resetHookToken('admin'), tok);        // 重置换新
});

test('员工经验去重:高度相似不重复记', () => {
  const { open } = require('../store');
  const s = open(':memory:'); s.seed();
  const rid = 'engineering-frontend-developer';
  s.appendRoleMemo(rid, 'file://被封时改用本地http服务');
  s.appendRoleMemo(rid, 'file 协议被封,起本地 http 服务解决');  // 高度相似→跳过
  s.appendRoleMemo(rid, '移动端要做汉堡菜单适配');                // 不同→记
  const memo = s.getRole(rid).memo.split('\n').filter(Boolean);
  assert.equal(memo.length, 2);
});

test('删除任务:级联清 steps/logs/events/usage/msgs/apps', () => {
  const { open } = require('../store');
  const s = open(':memory:'); s.seed();
  const id = s.createTask('删我', '默认项目', 'admin', {});
  s.setStep(id, 'a', 'claude', 'done', 'x'); s.addLog(id, 'a', 'log'); s.addEvent(id, 'status', {});
  s.addUsage(id, 'a', 'claude', { input: 1, output: 1, cost: 0 }); s.addTaskMsg(id, 'user', 'hi');
  s.setTaskDir(id, '/x'); s.addApp({ name: 'app', taskId: id, dir: '/x', entry: 'i.html' });
  s.deleteTask(id);
  assert.equal(s.getTask(id), null);
  assert.equal(s.getLogs(id).length, 0);
  assert.equal(s.getEvents(id).length, 0);
  assert.equal(s.getTaskMsgs(id).length, 0);
  assert.equal(s.listApps().filter((a) => a.task_id === id).length, 0);
});

test('步骤产出核验:commitStep返回改动文件数,relay标注', () => {
  const { open } = require('../store');
  const { relay } = require('../api');
  const s = open(':memory:'); s.seed();
  const id = s.createTask('活', '默认项目', 'admin', {});
  s.setStep(id, 'a', 'claude', 'done', '做完了');
  s.setStep(id, 'b', 'claude', 'done', '声称做了但没产出');
  s.addEvent(id, 'files', { step: 'a', n: 3 });
  s.addEvent(id, 'files', { step: 'b', n: 0 });
  const r = relay(s, id);
  assert.equal(r.find((x) => x.title === 'a').filesLabel, '📄 3 文件');
  assert.equal(r.find((x) => x.title === 'b').filesLabel, '⚠ 无产出');
});

test('任务进度:顶层步骤完成比(loop子步不计)', () => {
  const { open } = require('../store');
  const { buildAll } = require('../api');
  const s = open(':memory:'); s.seed();
  const id = s.createTask('活', '默认项目', 'admin', {});
  s.setStep(id, 'a', 'claude', 'done', 'x');
  s.setStep(id, 'b', 'claude', 'running', '');
  s.setStep(id, 'c', 'claude', 'pending', '');
  s.setStep(id, 'b.0', 'claude', 'done', 'x'); // loop 子步不计
  const vm = buildAll(s, { name: 'admin', admin: 1 });
  const t = vm.tasks.find((x) => x.id === id);
  assert.equal(t.progressLabel, '1/3 步');
  assert.equal(t.progress, 33);
});

test('任务报告:MD含目标/步骤/员工/成本', () => {
  const { open } = require('../store');
  const { taskReport } = require('../api');
  const s = open(':memory:'); s.seed();
  const id = s.createTask('做个登录页', '默认项目', 'admin', {});
  s.setPlan(id, { steps: [{ id: 'build', role: 'engineering-frontend-developer', prompt: 'p', deps: [] }] });
  s.setStep(id, 'build', 'claude', 'done', '页面已建好');
  s.addEvent(id, 'files', { step: 'build', n: 2 });
  const md = taskReport(s, id);
  assert.match(md, /# 做个登录页/);
  assert.match(md, /执行接力/);
  assert.match(md, /build/);
  assert.match(md, /页面已建好/);
});

test('项目聚合:成本/完成数/失败数', () => {
  const { open } = require('../store');
  const { buildAll } = require('../api');
  const s = open(':memory:'); s.seed();
  const a = s.createTask('t1', 'P', 'admin', {}); s.setStep(a, 'x', 'claude', 'done', 'o'); s.setTaskStatus(a, 'done');
  const b = s.createTask('t2', 'P', 'admin', {}); s.setTaskStatus(b, 'failed');
  s.addUsage(a, 'x', 'claude', { input: 100, output: 50, cost: 0.02 });
  const vm = buildAll(s, { name: 'admin', admin: 1 });
  const p = vm.projects.find((x) => x.name === 'P');
  assert.equal(p.doneN, 1);
  assert.equal(p.failN, 1);
  assert.equal(p.cost, 0.02);
});

test('clearSteps 清空任务步骤', () => {
  const { open } = require('../store');
  const s = open(':memory:'); s.seed();
  const id = s.createTask('x', '默认项目', 'admin', {});
  s.setStep(id, 'a', 'claude', 'done', 'o'); s.setStep(id, 'b', 'claude', 'done', 'o');
  assert.equal(s.getTask(id).steps.length, 2);
  s.clearSteps(id);
  assert.equal(s.getTask(id).steps.length, 0);
});

test('步骤耗时:运行中显示实时⏱,完成显示固定时长', () => {
  const { open } = require('../store');
  const s = open(':memory:'); s.seed();
  const id = s.createTask('x', '默认项目', 'admin', {});
  s.addEvent(id, 'status', { step: 'a', v: 'running' });
  s.addEvent(id, 'status', { step: 'a', v: 'done' });
  s.addEvent(id, 'status', { step: 'b', v: 'running' }); // b 仍在跑
  // 直接调 stepDurations(内部函数经 relay 间接验证)
  const { relay } = require('../api');
  s.setStep(id, 'a', 'claude', 'done', 'o');
  s.setStep(id, 'b', 'claude', 'running', '');
  const r = relay(s, id);
  const ra = r.find((x) => x.title === 'a'); const rb = r.find((x) => x.title === 'b');
  assert.ok(!/⏱/.test(ra.dur));       // 完成步:固定时长,无 ⏱
  assert.match(rb.dur, /⏱/);           // 运行步:实时耗时
});

test('员工绩效:落盘/空转累计,catalog达阈值展示', async () => {
  const { open } = require('../store');
  const { makePlan } = require('../planner');
  const s = open(':memory:'); s.seed();
  const rid = 'engineering-frontend-developer';
  s.addRoleStat(rid, true); s.addRoleStat(rid, true); s.addRoleStat(rid, false); // 2落盘1空转
  const r = s.getRole(rid);
  assert.equal(r.done_count, 2); assert.equal(r.empty_count, 1);
  // catalog 注入(达 2 样本阈值)
  let seen = '';
  const fake = { async run({ prompt }) { seen = prompt; return { output: '{"steps":[{"id":"a","role":"' + rid + '","prompt":"x","deps":[]}]}', success: true }; } };
  await makePlan('活', { agents: ['claude'], roles: s.listRoles(), depts: s.listDepts(), refine: false, templatesDir: __dirname, claude: fake });
  assert.match(seen, /记录:2落盘\/1空转/);
});
