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
