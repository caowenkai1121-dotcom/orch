const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../store');

test('审查修复:auto-id 防碰撞——删中间记录后新增同名不静默覆盖', () => {
  const s = open(':memory:');
  const a = s.addAgent({ name: 'Foo' }); // foo-1
  const b = s.addAgent({ name: 'Foo' }); // foo-2
  assert.notEqual(a, b);
  s.deleteAgent(a);                       // 删 foo-1(COUNT 回退)
  const c = s.addAgent({ name: 'Foo' }); // 旧逻辑 COUNT+1=foo-2 覆盖 b;新逻辑 bump 到空闲
  assert.notEqual(c, b);                                       // c 不覆盖现存的 b
  assert.ok(s.listAgents().find((x) => x.id === b), 'b 应仍在'); // b 未被覆盖
});

test('审查修复:deletedDirs 记录删除目录墓碑(防 reap 因锁失败后重启复活)', () => {
  const s = open(':memory:');
  s.addEvent(0, 'deleted_dir', 'D:/x/task-5');
  s.addEvent(0, 'deleted_dir', 'D:/x/task-7');
  assert.deepEqual(s.deletedDirs().sort(), ['D:/x/task-5', 'D:/x/task-7']);
});

test('建任务并取回', () => {
  const s = open(':memory:');
  const id = s.createTask('做登录');
  const t = s.getTask(id);
  assert.equal(t.text, '做登录');
  assert.equal(t.status, 'pending');
});

test('setStep 为同一步骤做 upsert', () => {
  const s = open(':memory:');
  const id = s.createTask('x');
  s.setStep(id, 'dev', 'claude', 'running', null);
  s.setStep(id, 'dev', 'claude', 'done', 'ok');
  const t = s.getTask(id);
  assert.equal(t.steps.length, 1);
  assert.equal(t.steps[0].status, 'done');
  assert.equal(t.steps[0].output, 'ok');
});
