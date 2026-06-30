const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../store');

test('updateAgent 改字段', () => {
  const s = open(':memory:'); s.seed();
  s.updateAgent('claude', { name: 'Claude X', command: 'claude', args: ['-p'], model: 'm', caps: ['a'], color: '#111', avatar: 'C', dept: 'dev' });
  assert.equal(s.listAgents().find((a) => a.id === 'claude').name, 'Claude X');
});
test('deleteAgent 同时清分配', () => {
  const s = open(':memory:'); s.seed();
  const pid = s.addPerson({ name: '甲' }); s.setPersonAgents(pid, ['claude', 'codex']);
  s.deleteAgent('claude');
  assert.ok(!s.listAgents().some((a) => a.id === 'claude'));
  assert.deepEqual(s.listPersonAgents(pid), ['codex']);
});
test('项目新增与查', () => {
  const s = open(':memory:'); s.seed();
  const id = s.addProject({ name: '电商站', client: 'Acme' });
  assert.ok(s.listProjects().some((p) => p.id === id && p.name === '电商站'));
});
test('createTask 落 owner', () => {
  const s = open(':memory:'); s.seed();
  const id = s.createTask('做事', '项目A', '李四');
  assert.equal(s.listTasks().find((t) => t.id === id).owner, '李四');
});
