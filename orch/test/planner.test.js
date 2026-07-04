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

test('调度复盘按相关性优选(>6条时过滤无关)', async () => {
  const memo = ['ZZ1 无', 'ZZ2 无', 'ZZ3 无', 'ZZ4 无', 'ZZ5 无', 'ZZ6 无', 'ZZ7 无', '支付相关先做风控'].join('\n');
  const roles = [
    { id: 'r1', dept: 'engineering', name: 'x', description: '', prompt: '你是X', memo: '', executor: 'claude' },
    { id: 'chief-orchestrator', dept: '__system', name: '总调度', description: '', prompt: '', memo, executor: 'claude' },
  ];
  let seen = '';
  const fakeClaude = { async run({ prompt }) { seen = prompt; return { output: '{"steps":[{"id":"a","role":"r1","prompt":"p","deps":[]}]}', success: true }; } };
  await makePlan('做一个支付页面', { agents: ['claude'], roles, depts: [], refine: false, templatesDir: __dirname, claude: fakeClaude });
  assert.match(seen, /支付相关先做风控/);                 // 相关复盘保留
  const zc = (seen.match(/ZZ\d/g) || []).length;          // 8条 keep6 → relevant+5无关,故 ZZ≤5(旧行为全塞=7)
  assert.ok(zc <= 5, '应过滤部分无关调度复盘,实际保留 ZZ 条数=' + zc);
});

test('计划自愈:非法role就近纠正,仍非法带反馈重拆', async () => {
  const { coerceRoles, badRoles } = require('../planner');
  const ids = ['engineering-frontend-developer', 'testing-api-tester'];
  // 就近纠正:大小写/子串/词集
  const steps = [
    { id: 's1', role: 'Frontend-Developer', deps: [] },     // 词集重叠→前端
    { id: 's2', role: 'engineering-frontend-developer', deps: [] }, // 已合法
    { id: 's3', role: 'api-tester', deps: [] },              // 子串→测试
  ];
  coerceRoles(steps, ids);
  assert.equal(steps[0].role, 'engineering-frontend-developer');
  assert.equal(steps[2].role, 'testing-api-tester');
  assert.deepEqual(badRoles({ steps }, ids), []);
  // 完全无关→留原样,badRoles 报出
  const s2 = [{ id: 'x', role: 'marketing-seo-specialist', deps: [] }];
  coerceRoles(s2, ids);
  assert.deepEqual(badRoles({ steps: s2 }, ids), ['marketing-seo-specialist']);
});

test('计划自愈:makePlan LLM拼错role→重拆一次成功', async () => {
  const roles = [
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端', description: '', prompt: 'p', executor: 'claude' },
    { id: 'testing-api-tester', dept: 'testing', name: '测试', description: '', prompt: 'p', executor: 'codex' },
  ];
  let call = 0;
  const fakeClaude = { async run({ prompt }) {
    call++;
    if (call === 1) return { output: '{"steps":[{"id":"a","role":"完全瞎编的id","prompt":"x","deps":[]}]}', success: true };
    assert.match(prompt, /不在员工目录/); // 第二次带了反馈
    return { output: '{"steps":[{"id":"a","role":"engineering-frontend-developer","prompt":"x","deps":[]}]}', success: true };
  } };
  const plan = await makePlan('活', { agents: ['claude', 'codex'], roles, depts: [], refine: false, templatesDir: __dirname, claude: fakeClaude });
  assert.equal(plan.steps[0].role, 'engineering-frontend-developer');
  assert.equal(call, 2);
});

test('经验相关性注入:按任务文本优选相关经验', async () => {
  const roles = [{ id: 'r1', dept: 'engineering', name: 'x', description: '', prompt: '你是X',
    memo: '登录页要做记住密码\n图表用 canvas 手绘性能好\n表单校验前后端都要做\n深色模式用 CSS 变量\n移动端断点 375\n列表虚拟滚动防卡顿', executor: 'claude' }];
  let seen = '';
  const fakeClaude = { async run() { return { output: '{"steps":[{"id":"a","role":"r1","prompt":"做数据图表看板","deps":[]}]}', success: true }; } };
  const plan = await makePlan('做数据图表看板', { agents: ['claude'], roles, depts: [], refine: false, templatesDir: __dirname, claude: fakeClaude });
  const p = plan.steps[0].prompt;
  assert.match(p, /过往经验/);
  assert.match(p, /canvas 手绘/);        // "图表"相关经验入选
  assert.ok(!/深色模式/.test(p));        // 不相关经验被挤掉(6条优选5条)
  const body = p.split('【过往经验】')[1].split('【任务】')[0].split('\n').filter(Boolean);
  assert.equal(body.length - 1, 5);      // 去掉标题行=5条经验
});

test('依赖健全化:剔除自依赖/不存在依赖,断环', () => {
  const { sanitizeDeps } = require('../planner');
  // 自依赖 + 指向不存在
  const p1 = sanitizeDeps({ steps: [{ id: 'a', deps: ['a', 'ghost', 'b'] }, { id: 'b', deps: [] }] });
  assert.deepEqual(p1.steps[0].deps, ['b']);
  // 环 a↔b:拓扑排不动 → 解依赖至少能跑
  const p2 = sanitizeDeps({ steps: [{ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }] });
  const stuck = p2.steps.filter((s) => s.deps.length);
  assert.equal(stuck.length, 0); // 环被打断
  // 正常链不动
  const p3 = sanitizeDeps({ steps: [{ id: 'a', deps: [] }, { id: 'b', deps: ['a'] }, { id: 'c', deps: ['b'] }] });
  assert.deepEqual(p3.steps[2].deps, ['b']);
});

test('流程位置注入:员工获知上游/下游/质量门', async () => {
  const roles = [
    { id: 'engineering-rapid-prototyper', dept: 'engineering', name: '快速原型', description: '', prompt: '你是原型工程师', executor: 'claude' },
    { id: 'engineering-code-reviewer', dept: 'engineering', name: '代码评审', description: '', prompt: '你是评审', executor: 'claude' },
  ];
  const depts = [{ id: 'engineering', name: '工程部', flow: JSON.stringify([
    { role: 'engineering-rapid-prototyper', optional: false, gate: false },
    { role: 'engineering-code-reviewer', optional: false, gate: true },
  ]) }];
  const fakeClaude = { async run() { return { output: '{"steps":[{"id":"a","role":"engineering-rapid-prototyper","prompt":"做原型","deps":[]},{"id":"b","role":"engineering-code-reviewer","prompt":"评审","deps":["a"]}]}', success: true }; } };
  const plan = await makePlan('活', { agents: ['claude'], roles, depts, refine: false, templatesDir: __dirname, claude: fakeClaude });
  assert.match(plan.steps[0].prompt, /本部门流程位置/);
  assert.match(plan.steps[0].prompt, /下游:代码评审/);
  assert.match(plan.steps[1].prompt, /你\(质量门\)/); // 评审是质量门
});

test('规划可取消:makePlan 把 onChild 透传给 LLM 调用', async () => {
  let gotOnChild = null;
  const fakeClaude = { async run(o) { gotOnChild = o.onChild; return { output: '{"steps":[{"id":"a","agent":"claude","prompt":"x","deps":[]}]}', success: true }; } };
  const cb = () => {};
  await makePlan('活', { agents: ['claude', 'codex'], roles: [], depts: [], refine: false, templatesDir: __dirname, claude: fakeClaude, onChild: cb });
  assert.equal(typeof gotOnChild, 'function'); // 规划子进程回调被透传
});

test('需求细化启发式:长需求跳过refine,短需求细化', async () => {
  let refineCalled = 0;
  const fakeClaude = { async run({ prompt }) {
    if (/资深产品经理/.test(prompt)) { refineCalled++; return { output: '细化后', success: true }; }
    return { output: '{"steps":[{"id":"a","agent":"claude","prompt":"x","deps":[]}]}', success: true };
  } };
  // 短需求(<160) → 应细化
  await makePlan('做个登录页', { agents: ['claude', 'codex'], roles: [], depts: [], refine: true, templatesDir: __dirname, claude: fakeClaude });
  assert.equal(refineCalled, 1);
  // 长需求(>=160) → 跳过细化
  refineCalled = 0;
  const longText = '开发一个电商后台管理系统'.repeat(15); // 180 字 >160
  await makePlan(longText, { agents: ['claude', 'codex'], roles: [], depts: [], refine: true, templatesDir: __dirname, claude: fakeClaude });
  assert.equal(refineCalled, 0);
});

test('sanitizeDeps 归一化畸形 steps(防execute崩)', () => {
  const { sanitizeDeps } = require('../planner');
  // steps 非数组
  assert.deepEqual(sanitizeDeps({ steps: 'foo' }).steps, []);
  // steps 缺失
  assert.deepEqual(sanitizeDeps({}).steps, []);
  // plan 非对象
  assert.deepEqual(sanitizeDeps(null).steps, []);
  // 含非法项(null/无id)被剔除,合法保留
  const p = sanitizeDeps({ steps: [null, { foo: 1 }, { id: 'a', deps: [] }, 'x'] });
  assert.equal(p.steps.length, 1);
  assert.equal(p.steps[0].id, 'a');
});

test('调度提示含粒度匹配(避免过度拆分)', async () => {
  const roles = [{ id: 'engineering-rapid-prototyper', dept: 'engineering', name: '快速原型', description: '', prompt: 'p', executor: 'claude' }];
  let seen = '';
  const fakeClaude = { async run({ prompt }) { seen = prompt; return { output: '{"steps":[{"id":"a","role":"engineering-rapid-prototyper","prompt":"x","deps":[]}]}', success: true }; } };
  await makePlan('活', { agents: ['claude'], roles, depts: [], refine: false, templatesDir: __dirname, claude: fakeClaude });
  assert.match(seen, /拆分粒度匹配任务复杂度/);
  assert.match(seen, /简单任务.*1-2步/);
});
