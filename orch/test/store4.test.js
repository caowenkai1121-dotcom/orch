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
