const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { fromTemplate, makePlan } = require('../planner');

const TPL = path.join(__dirname, '..', 'templates');

test('模板匹配并把 {task} 填进 plan', () => {
  const plan = fromTemplate('做个登录', TPL);
  assert.ok(plan);
  assert.equal(plan.task, '做个登录');
  assert.match(plan.steps[0].prompt, /做个登录/);
  assert.equal(plan.steps[2].type, 'loop');
});

test('无模板时调 LLM 出 plan', async () => {
  const fakeClaude = { async run() {
    return { output: '```json\n{"steps":[{"id":"x","agent":"claude","prompt":"p","deps":[]}]}\n```', success: true };
  } };
  // 多 agent 才走 LLM 拆解(单 agent 会短路成单步直做)
  const plan = await makePlan('任意', { mode: 'llm', agents: ['claude', 'codex'], templatesDir: __dirname, claude: fakeClaude });
  assert.equal(plan.steps[0].id, 'x');
});
