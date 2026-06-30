const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../store');

test('seed 后有 claude/codex 两个 agent', () => {
  const s = open(':memory:'); s.seed();
  const ids = s.listAgents().map((a) => a.id).sort();
  assert.deepEqual(ids, ['claude', 'codex']);
});

test('新建 agent 可查到', () => {
  const s = open(':memory:'); s.seed();
  const id = s.addAgent({ name: 'Gemini 开发', command: 'gemini', args: ['-p'], caps: ['代码'], dept: 'dev' });
  assert.ok(s.listAgents().some((a) => a.id === id));
});

test('人员与分配', () => {
  const s = open(':memory:'); s.seed();
  const pid = s.addPerson({ name: '李四', role: '开发' });
  s.setPersonAgents(pid, ['claude', 'codex']);
  assert.deepEqual(s.listPersonAgents(pid).sort(), ['claude', 'codex']);
});
