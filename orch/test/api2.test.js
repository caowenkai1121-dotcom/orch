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

test('buildAll 输出应用广场运行入口和运行态', () => {
  const s = open(':memory:'); s.seed();
  const tid = s.createTask('DMS supplier system', '默认项目', 'admin', {});
  s.setTaskDir(tid, '/dms');
  const appId = s.addApp({ name: 'DMS', taskId: tid, dir: '/dms', entry: 'frontend/dist/index.html', type: 'fullstack', staticDir: 'frontend/dist', startCmd: 'node api.js', status: 'stopped' });

  const app = api.buildAll(s).apps.find((a) => a.id === appId);

  assert.equal(app.url, '/apps/' + appId + '/');
  assert.equal(app.type, 'fullstack');
  assert.equal(app.status, 'stopped');
  assert.match(app.entry, /frontend\/dist\/index\.html/);
});

test('api.plan 输出编排回放摘要和技能标签', () => {
  const s = open(':memory:');
  s.addDept({ id: 'engineering', name: '工程部', color: '#7C6FD9' });
  s.addRole({ id: 'frontend', dept: 'engineering', name: '前端工程师', emoji: 'F', prompt: 'p', executor: 'claude' });
  s.addAgent({ id: 'claude', name: 'Claude', command: 'claude', args: [], model: 'm', caps: [] });
  const tid = s.createTask('前端使用 vue 后端使用 java springboot 开发天气小工具网站', '默认项目', 'admin', {});
  s.setPlan(tid, {
    task: '前端使用 vue 后端使用 java springboot 开发天气小工具网站',
    process: { type: 'risk_review', reason: '显式前后端分离且涉及接口联调', manager_role: 'frontend' },
    planning_stats: { route: 'complex-fullstack', llm_calls: 1 },
    meeting: { attendees: ['frontend'], agenda: ['目标澄清', '技术架构', '风险复核'] },
    steps: [
      { id: 'frontend_impl', role: 'frontend', agent: 'claude', prompt: 'Vue 3 前端实现并调用 Spring Boot API', deps: [], why: '前端技术栈对口', expected_outcome: '页面可用' },
    ],
  });

  const rows = api.plan(s, tid);

  assert.ok(rows[0].skillTags.includes('前端'));
  assert.ok(rows[0].skillTags.includes('Vue'));
  assert.ok(rows[0].skillTags.includes('后端'));
  assert.match(rows[0].traceSummary, /风险复核/);
  assert.match(rows[0].traceSummary, /complex-fullstack/);
  assert.match(rows[0].traceSummary, /会议/);
});
