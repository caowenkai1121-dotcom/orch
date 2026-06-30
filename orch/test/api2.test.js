const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../store');
const api = require('../api');

test('buildAll 合并表项目(无任务也出现)', () => {
  const s = open(':memory:'); s.seed();
  s.addProject({ name: '空项目X' });
  s.createTask('做事', '有任务项目', '操作者');
  const names = api.buildAll(s).projects.map((p) => p.name);
  assert.ok(names.includes('空项目X'));
  assert.ok(names.includes('有任务项目'));
});
