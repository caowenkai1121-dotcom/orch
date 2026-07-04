const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { makePlan, validate } = require('../planner');

test('规划期 claude 调用受并发信号量约束(不再fork风暴)', async () => {
  process.env.ORCH_CONCURRENCY = '1';
  let cur = 0, peak = 0;
  const claude = { async run() { cur++; peak = Math.max(peak, cur); await new Promise((r) => setTimeout(r, 20)); cur--; return { output: '{"steps":[{"id":"a","agent":"claude","prompt":"p","deps":[]}]}', success: true }; } };
  const opts = { agents: ['claude', 'codex'], roles: [], depts: [], refine: false, templatesDir: __dirname, claude }; // 多执行器→fromLLM 用 claude
  await Promise.all([makePlan('t1', opts), makePlan('t2', opts), makePlan('t3', opts)]);
  assert.ok(peak <= 1, 'peak=' + peak); // sem(1) 下并发规划≤1
  delete process.env.ORCH_CONCURRENCY;
});
const TPL = path.join(__dirname, '..', 'templates');

test('合法 plan 校验通过', () => {
  const ok = validate({ steps: [{ id: 'a', agent: 'claude', prompt: 'p', deps: [] }] }, ['claude', 'codex']);
  assert.equal(ok, true);
});
test('agent 不在可用列表则不通过', () => {
  assert.equal(validate({ steps: [{ id: 'a', agent: 'ghost', prompt: 'p', deps: [] }] }, ['claude']), false);
});
test('LLM 模式:合法 JSON 直接用', async () => {
  const claude = { async run() { return { output: '```json\n{"steps":[{"id":"x","agent":"claude","prompt":"p","deps":[]}]}\n```', success: true }; } };
  const plan = await makePlan('做事', { mode: 'llm', agents: ['claude', 'codex'], templatesDir: TPL, claude });
  assert.equal(plan.steps[0].id, 'x');
});
test('LLM 模式:非法(未知agent)回退模板', async () => {
  const claude = { async run() { return { output: '{"steps":[{"id":"x","agent":"ghost","prompt":"p","deps":[]}]}', success: true }; } };
  const plan = await makePlan('做事', { mode: 'llm', agents: ['claude', 'codex'], templatesDir: TPL, claude });
  assert.equal(plan.steps[0].id, 'dev'); // 兜底模板首步
});
