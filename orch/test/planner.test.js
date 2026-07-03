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

test('员工模式:按部门员工拆分,角色提示词注入,执行器解析', async () => {
  const roles = [
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '建前端', prompt: '你是前端开发工程师,规则…', executor: 'claude' },
    { id: 'testing-api-tester', dept: 'testing', name: 'API测试员', description: '测接口', prompt: '你是API测试员,规则…', executor: 'codex' },
  ];
  const depts = [{ id: 'engineering', name: '工程部' }, { id: 'testing', name: '测试部' }];
  const fakeClaude = { async run({ prompt }) {
    assert.match(prompt, /工程部/); // 目录注入
    return { output: '{"steps":[{"id":"build","role":"engineering-frontend-developer","prompt":"做页面","deps":[]},{"id":"verify","role":"testing-api-tester","prompt":"验证","deps":["build"]}]}', success: true };
  } };
  const plan = await makePlan('做个页面', { mode: 'llm', agents: ['claude', 'codex'], roles, depts, refine: false, templatesDir: __dirname, claude: fakeClaude });
  assert.equal(plan.steps[0].role, 'engineering-frontend-developer');
  assert.equal(plan.steps[0].agent, 'claude');            // 执行器解析
  assert.match(plan.steps[0].prompt, /你是前端开发工程师/); // 角色提示词注入
  assert.equal(plan.steps[1].agent, 'codex');
});

test('员工模式:执行器不在所选范围时回退到首个所选', async () => {
  const roles = [{ id: 'testing-api-tester', dept: 'testing', name: 'API测试员', description: '测', prompt: 'p', executor: 'codex' }];
  const fakeClaude = { async run() { return { output: '{"steps":[{"id":"t","role":"testing-api-tester","prompt":"x","deps":[]}]}', success: true }; } };
  const plan = await makePlan('测试', { agents: ['claude', 'gemini'], roles, depts: [], refine: false, templatesDir: __dirname, claude: fakeClaude });
  assert.equal(plan.steps[0].agent, 'claude'); // codex 不可用 → 回退
});

test('显式单执行器+无编排:仍单步直做(不走员工模式)', async () => {
  const roles = [{ id: 'r1', dept: 'engineering', name: 'x', description: '', prompt: '', executor: 'claude' }];
  const plan = await makePlan('写页面', { agents: ['claude'], explicit: true, roles, depts: [], refine: false, templatesDir: __dirname, claude: { async run() { throw new Error('不应调用'); } } });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].agent, 'claude');
  assert.equal(plan.steps[0].role, undefined);
});

test('部门任务:只用该部门员工,流程规范注入调度提示', async () => {
  const roles = [
    { id: 'engineering-rapid-prototyper', dept: 'engineering', name: '快速原型', description: '', prompt: 'p1', executor: 'claude' },
    { id: 'marketing-content-creator', dept: 'marketing', name: '内容创作', description: '', prompt: 'p2', executor: 'claude' },
  ];
  const depts = [{ id: 'engineering', name: '工程部', flow: JSON.stringify([{ role: 'engineering-rapid-prototyper', optional: false, gate: false }]) }];
  const fakeClaude = { async run({ prompt }) {
    assert.match(prompt, /部门任务/);        // 部门模式指令
    assert.match(prompt, /标准流程/);        // 流程规范注入
    assert.ok(!/marketing-content-creator/.test(prompt)); // 其它部门员工不在目录
    return { output: '{"steps":[{"id":"s1","role":"engineering-rapid-prototyper","prompt":"x","deps":[]}]}', success: true };
  } };
  const plan = await makePlan('做原型', { agents: ['claude'], dept: 'engineering', roles, depts, refine: false, templatesDir: __dirname, claude: fakeClaude });
  assert.equal(plan.steps[0].role, 'engineering-rapid-prototyper');
});

test('部门执行器池:员工执行器不在池内则用池内执行器', async () => {
  const roles = [{ id: 'r1', dept: 'engineering', name: 'x', description: '', prompt: 'p', executor: 'claude' }];
  const fakeClaude = { async run() { return { output: '{"steps":[{"id":"a","role":"r1","prompt":"x","deps":[]}]}', success: true }; } };
  const plan = await makePlan('活', { agents: ['claude', 'gemini'], roles, depts: [], deptPools: { engineering: ['gemini'] }, refine: false, templatesDir: __dirname, claude: fakeClaude });
  assert.equal(plan.steps[0].agent, 'gemini'); // 池限定 gemini → claude 被替换
});

test('经验注入:员工memo进角色卡,调度复盘进总调度提示', async () => {
  const roles = [
    { id: 'r1', dept: 'engineering', name: 'x', description: '', prompt: '你是X', memo: '上次坑:file://被封,起http服务', executor: 'claude' },
    { id: 'chief-orchestrator', dept: '__system', name: '总调度', description: '', prompt: '', memo: '上次复盘:质量门该放最后', executor: 'claude' },
  ];
  const fakeClaude = { async run({ prompt }) {
    assert.match(prompt, /过往调度复盘/);              // B2 调度复盘注入
    assert.match(prompt, /质量门该放最后/);
    assert.ok(!/chief-orchestrator\(/.test(prompt));   // __system 不进员工目录
    return { output: '{"steps":[{"id":"a","role":"r1","prompt":"干活","deps":[]}]}', success: true };
  } };
  const plan = await makePlan('活', { agents: ['claude'], roles, depts: [], refine: false, templatesDir: __dirname, claude: fakeClaude });
  assert.match(plan.steps[0].prompt, /过往经验/);       // B1 员工经验注入
  assert.match(plan.steps[0].prompt, /file:\/\/被封/);
});
