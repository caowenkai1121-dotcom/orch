const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { fromTemplate, makePlan, validateCrewPlan } = require('../planner');

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

test('员工模式:总调度目录包含员工能力摘要并要求先分析任务', async () => {
  const roles = [
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '建前端', prompt: '【身份】前端\n【交付物标准】必须交付可运行页面、样式文件和自测记录。\n【工作流程】先读现状再实现。', executor: 'claude' },
    { id: 'testing-reality-checker', dept: 'testing', name: '真实验收', description: '验收', prompt: '【身份】验收\n【判定】必须输出 PASS/FAIL 和可复现问题清单。', executor: 'codex' },
  ];
  const depts = [{ id: 'engineering', name: '工程部' }, { id: 'testing', name: '测试部' }];
  let rolePrompt = '';
  const fakeClaude = { async run({ prompt }) {
    if (/任务分派专家/.test(prompt)) return { output: 'engineering', success: true };
    rolePrompt = prompt;
    return { output: '{"steps":[{"id":"build","role":"engineering-frontend-developer","prompt":"做页面","deps":[]},{"id":"verify","role":"testing-reality-checker","prompt":"验收","deps":["build"]}]}', success: true };
  } };
  const plan = await makePlan('开发可运行首页并验收', { mode: 'llm', agents: ['claude', 'codex'], roles, depts, refine: false, templatesDir: __dirname, claude: fakeClaude });
  assert.match(rolePrompt, /交付:必须交付可运行页面/);
  assert.match(rolePrompt, /testing-reality-checker\(真实验收:验收\)/); // 分层目录:非主部门员工一句话简介(完整卡执行时注入)
  assert.match(rolePrompt, /先在心中完成任务分析/);
  assert.match(rolePrompt, /主产物/);
  assert.equal(plan.steps[0].role, 'engineering-frontend-developer');
  assert.equal(plan.steps[1].role, 'testing-reality-checker');
});

test('员工模式:缺验收契约时自动补 expected_outcome', async () => {
  const roles = [
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '建前端页面', prompt: '【身份】前端', executor: 'claude' },
    { id: 'testing-reality-checker', dept: 'testing', name: '真实验收', description: '质量验收与核查', prompt: '【身份】验收\n【判定】输出 PASS/FAIL。', executor: 'codex' },
  ];
  const fakeClaude = { async run({ prompt }) {
    if (/任务分派专家/.test(prompt)) return { output: 'engineering', success: true };
    return { output: '{"steps":[{"id":"build","role":"engineering-frontend-developer","prompt":"实现页面","deps":[]},{"id":"verify","role":"testing-reality-checker","prompt":"验证页面","deps":["build"]}]}', success: true };
  } };
  const plan = await makePlan('做一个可运行页面并验收', { mode: 'llm', agents: ['claude', 'codex'], roles, depts: [{ id: 'engineering', name: '工程部' }, { id: 'testing', name: '测试部' }], refine: false, templatesDir: __dirname, claude: fakeClaude });
  assert.match(plan.steps[0].expected_outcome, /真实完成本步要求/);
  assert.match(plan.steps[1].expected_outcome, /PASS\/FAIL/);
});

test('员工模式:总调度目录包含关键规则流程与交接摘要', async () => {
  const roles = [
    { id: 'engineering-minimal-change-engineer', dept: 'engineering', name: '最小变更', description: '精准小改', prompt: '【身份】最小变更工程师\n【关键规则】只修被要求内容,拒绝范围蔓延。\n【工作流程】先定位最小影响面,再写最小差异。\n【交接】输出改动文件、默认假设和后续事项。', executor: 'claude' },
    { id: 'testing-reality-checker', dept: 'testing', name: '真实验收', description: '验收', prompt: '【身份】验收\n【判定】输出 PASS/FAIL。', executor: 'codex' },
  ];
  let rolePrompt = '';
  const fakeClaude = { async run({ prompt }) {
    if (/任务分派专家/.test(prompt)) return { output: 'engineering', success: true };
    rolePrompt = prompt;
    return { output: '{"steps":[{"id":"fix","role":"engineering-minimal-change-engineer","prompt":"修复问题","deps":[]},{"id":"verify","role":"testing-reality-checker","prompt":"验收","deps":["fix"]}]}', success: true };
  } };
  await makePlan('修复一个页面按钮错误并验收', { mode: 'llm', agents: ['claude', 'codex'], roles, depts: [{ id: 'engineering', name: '工程部' }, { id: 'testing', name: '测试部' }], refine: false, templatesDir: __dirname, claude: fakeClaude });
  // 分层目录:主负责部门(工程部)员工带完整能力档案;其他部门(测试部)只给一句话简介
  assert.match(rolePrompt, /规则:只修被要求内容/);
  assert.match(rolePrompt, /流程:先定位最小影响面/);
  assert.match(rolePrompt, /交接:输出改动文件/);
  const testingSeg = rolePrompt.split('\n').find((l) => l.startsWith('测试部:')) || '';
  assert.ok(!/判定:/.test(testingSeg), '非主部门员工应为一句话简介(无档案段), 实际=' + testingSeg.slice(0, 80));
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

test('员工模式规划失败回退→plan 标记 degraded', async () => {
  const roles = [{ id: 'engineering-frontend-developer', dept: 'engineering', name: 'x', description: '', prompt: '你是X', memo: '', executor: 'claude' }];
  // LLM 总返回无法纠正的非法 role → 员工模式失败 → 回退执行器/单步模式
  const fakeClaude = { async run() { return { output: '{"steps":[{"id":"a","role":"完全不存在的岗位xyz","prompt":"p","deps":[]}]}', success: true }; } };
  const plan = await makePlan('做个页面', { agents: ['claude', 'codex'], roles, depts: [], refine: false, templatesDir: __dirname, claude: fakeClaude });
  assert.equal(plan.degraded, true);           // 回退被标记
  assert.ok(Array.isArray(plan.steps) && plan.steps.length); // 仍给出可执行兜底计划
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
  // 提速:短但已列多个需求点(≥2分隔符) → 也跳过细化(本就够具体)
  refineCalled = 0;
  await makePlan('记账应用:收支记录、分类、月度统计、预算提醒', { agents: ['claude', 'codex'], roles: [], depts: [], refine: true, templatesDir: __dirname, claude: fakeClaude });
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

test('调度提示含复杂度路由(简单直接/复杂开需求会议)+细粒度拆解', async () => {
  const roles = [{ id: 'engineering-rapid-prototyper', dept: 'engineering', name: '快速原型', description: '', prompt: 'p', executor: 'claude' }];
  let seen = '';
  const fakeClaude = { async run({ prompt }) { seen = prompt; return { output: '{"steps":[{"id":"a","role":"engineering-rapid-prototyper","prompt":"x","deps":[]}]}', success: true }; } };
  await makePlan('活', { agents: ['claude'], roles, depts: [], refine: false, templatesDir: __dirname, claude: fakeClaude });
  assert.match(seen, /先判复杂度/);          // 复杂度路由
  assert.match(seen, /简单任务.*1-2步/);     // 简单任务直接做
  assert.match(seen, /方案会议/);            // 复杂任务提示会自动插入方案会议阶段
  assert.match(seen, /细分成多步/);          // 细粒度拆解
  seen = '';
  await makePlan('前端使用 vue 后端使用 java springboot 开发一个 天气小工具网站', { agents: ['claude'], roles, depts: [], refine: false, templatesDir: __dirname, claude: fakeClaude });
  assert.match(seen, /不要把需求范围、技术架构、交互设计拆成独立空转节点/);
});

test('新功能:复杂计划(≥4步≥2角色)前置代码强制方案会议', () => {
  const { prependMeeting } = require('../planner');
  const roleMap = { arch: { label: '架构师' }, fe: { label: '前端' }, qa: { label: '测试' } };
  const plan = { steps: [
    { id: 'a', role: 'arch', deps: [] }, { id: 'b', role: 'fe', deps: ['a'] },
    { id: 'c', role: 'fe', deps: ['a'] }, { id: 'd', role: 'qa', deps: ['b', 'c'] },
  ] };
  prependMeeting(plan, roleMap);
  const ids = plan.steps.map((s) => s.id);
  assert.ok(ids.includes('decide_plan'));                              // 方案综合步
  assert.ok(ids.filter((i) => i.startsWith('meet_')).length >= 2);     // ≥2 讨论步
  assert.deepEqual(plan.steps.find((s) => s.id === 'a').deps, ['decide_plan']); // 原根步改依赖会议
  const simple = { steps: [{ id: 'x', role: 'arch', deps: [] }, { id: 'y', role: 'fe', deps: ['x'] }] };
  prependMeeting(simple, roleMap);
  assert.equal(simple.steps.length, 2);                                // <4步:不开会
});

test('明确简单员工任务走快速规划,不调用LLM深度拆分', async () => {
  let calls = 0;
  const roles = [
    { id: 'engineering-minimal-change-engineer', dept: 'engineering', name: '最小变更', description: '修复按钮、文案和小范围代码变更', prompt: 'p', executor: 'claude' },
    { id: 'testing-reality-checker', dept: 'testing', name: '真实验收', description: '验收测试', prompt: 'p', executor: 'codex' },
  ];
  const claude = { async run() { calls++; throw new Error('简单任务不应调用LLM'); } };
  const plan = await makePlan('修复登录按钮文案', { agents: ['claude', 'codex'], roles, depts: [{ id: 'engineering', name: '工程部' }, { id: 'testing', name: '测试部' }], refine: true, templatesDir: __dirname, claude });
  assert.equal(calls, 0);
  assert.equal(plan.planning_stats.route, 'fast-simple');
  assert.equal(plan.planning_stats.llm_calls, 0);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].role, 'engineering-minimal-change-engineer');
  assert.equal(plan.steps[0].agent, 'claude');
});

test('短但明确的任务不做需求细化,只保留一次规划调用', async () => {
  let calls = 0;
  const claude = { async run() {
    calls++;
    return { output: '{"steps":[{"id":"fix_copy","agent":"claude","prompt":"修复按钮文案","deps":[]}]}', success: true };
  } };
  const plan = await makePlan('修复登录按钮文案', { agents: ['claude', 'codex'], roles: [], depts: [], refine: true, templatesDir: __dirname, claude });
  assert.equal(calls, 1);
  assert.equal(plan.steps[0].id, 'fix_copy');
});

test('复杂员工规划用本地主部门判断,不额外调用任务分派LLM', async () => {
  let calls = 0;
  const roles = [
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '页面、组件、交互实现', prompt: 'p', executor: 'claude' },
    { id: 'testing-reality-checker', dept: 'testing', name: '真实验收', description: '验收测试', prompt: 'p', executor: 'codex' },
  ];
  const claude = { async run() {
    calls++;
    return { output: '{"steps":[{"id":"impl_frontend","role":"engineering-frontend-developer","prompt":"实现客户列表、编辑和权限校验页面","deps":[]},{"id":"verify","role":"testing-reality-checker","prompt":"验收客户管理后台","deps":["impl_frontend"]}]}', success: true };
  } };
  const plan = await makePlan('开发一个客户管理后台,包含列表、编辑、权限校验和验收', { agents: ['claude', 'codex'], roles, depts: [{ id: 'engineering', name: '工程部' }, { id: 'testing', name: '测试部' }], refine: false, templatesDir: __dirname, claude });
  assert.equal(calls, 1);
  assert.equal(plan.planning_stats.llm_calls, 1);
  assert.equal(plan.planning_stats.main_dept, 'engineering');
  assert.equal(plan.steps[0].role, 'engineering-frontend-developer');
});

test('高置信复杂业务不能降级成单步执行器,员工规划失败时走多角色会议保底', async () => {
  const roles = [
    { id: 'product-product-manager', dept: 'product', name: '产品经理', description: '需求拆解与产品范围', prompt: 'p', executor: 'claude' },
    { id: 'engineering-backend-architect', dept: 'engineering', name: '后端架构师', description: '架构、交易接口和数据模型', prompt: 'p', executor: 'claude' },
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '页面、行情看板、交易交互', prompt: 'p', executor: 'claude' },
    { id: 'security-risk-analyst', dept: 'security', name: '风控分析师', description: '交易安全、权限、风控', prompt: 'p', executor: 'codex' },
    { id: 'testing-reality-checker', dept: 'testing', name: '真实验收', description: '验收测试', prompt: 'p', executor: 'codex' },
  ];
  const depts = [
    { id: 'product', name: '产品部' },
    { id: 'engineering', name: '工程部' },
    { id: 'security', name: '安全部' },
    { id: 'testing', name: '测试部' },
  ];
  const claude = { async run() { throw new Error('模拟员工LLM规划失败'); } };
  const plan = await makePlan('股票交易网站', { agents: ['claude', 'codex'], roles, depts, refine: true, templatesDir: __dirname, claude });
  assert.notEqual(plan.planning_stats.route, 'fallback');
  assert.match(plan.planning_stats.route, /complex/);
  assert.ok(plan.meeting, '复杂任务应强制进入方案会议');
  assert.ok(plan.steps.length >= 5, '复杂任务不能压成单步');
  assert.ok(plan.steps.some((s) => s.role === 'engineering-backend-architect'));
  assert.ok(plan.steps.some((s) => s.role === 'engineering-frontend-developer'));
});

test('复杂股票交易网站保底编排优先派工程主责和关键专业员工', async () => {
  const roles = [
    { id: 'product-manager', dept: 'product', name: '产品经理', description: 'PRD与路线图', prompt: 'p', executor: 'claude' },
    { id: 'design-ux-architect', dept: 'design', name: 'UX架构师', description: '信息架构与交互', prompt: 'p', executor: 'claude' },
    { id: 'engineering-backend-architect', dept: 'engineering', name: '后端架构师', description: '后端架构、数据库与API', prompt: 'p', executor: 'claude' },
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发工程师', description: '前端界面与组件', prompt: 'p', executor: 'claude' },
    { id: 'security-appsec-engineer', dept: 'security', name: '应用安全工程师', description: '应用安全、权限与风控', prompt: 'p', executor: 'codex' },
    { id: 'testing-api-tester', dept: 'testing', name: 'API测试员', description: '接口测试与CI', prompt: 'p', executor: 'codex' },
    { id: 'finance-investment-researcher', dept: 'finance', name: '投资研究员', description: '金融与股票研究', prompt: 'p', executor: 'claude' },
  ];
  const depts = [
    { id: 'product', name: '产品部' },
    { id: 'design', name: '设计部' },
    { id: 'engineering', name: '工程部' },
    { id: 'security', name: '安全部' },
    { id: 'testing', name: '测试部' },
    { id: 'finance', name: '金融部' },
  ];
  const claude = { async run() { throw new Error('模拟规划失败'); } };
  const plan = await makePlan('开发一个复杂的股票交易网站（验证智能编排）', { mode: 'llm', agents: ['claude', 'codex'], roles, depts, refine: true, templatesDir: __dirname, claude });
  const used = new Set();
  const walk = (steps) => (steps || []).forEach((s) => { if (s.role) used.add(s.role); if (s.body) walk(s.body); });
  walk(plan.steps);
  assert.equal(plan.planning_stats.route, 'complex-fallback');
  assert.equal(plan.planning_stats.main_dept, 'engineering');
  assert.equal(plan.meeting.mainDept, 'engineering');
  assert.ok(used.has('product-manager'));
  assert.ok(used.has('engineering-backend-architect'));
  assert.ok(used.has('engineering-frontend-developer'));
  assert.ok(used.has('security-appsec-engineer'));
  assert.ok(used.has('testing-api-tester'));
});

test('复杂股票交易网站LLM多步但错派角色时仍启用保底编排', async () => {
  const roles = [
    { id: 'product-manager', dept: 'product', name: '产品经理', description: 'PRD与路线图', prompt: 'p', executor: 'claude' },
    { id: 'design-ux-architect', dept: 'design', name: 'UX架构师', description: '信息架构与交互', prompt: 'p', executor: 'claude' },
    { id: 'engineering-backend-architect', dept: 'engineering', name: '后端架构师', description: '后端架构、数据库与API', prompt: 'p', executor: 'claude' },
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发工程师', description: '前端界面与组件', prompt: 'p', executor: 'claude' },
    { id: 'security-appsec-engineer', dept: 'security', name: '应用安全工程师', description: '应用安全、权限与风控', prompt: 'p', executor: 'codex' },
    { id: 'testing-api-tester', dept: 'testing', name: 'API测试员', description: '接口测试与CI', prompt: 'p', executor: 'codex' },
    { id: 'level-designer', dept: 'game-development', name: '关卡设计师', description: '关卡与遭遇设计', prompt: 'p', executor: 'claude' },
    { id: 'legal-policy-writer', dept: 'legal', name: '制度文件撰写专家', description: '隐私政策与合规制度', prompt: 'p', executor: 'claude' },
    { id: 'academic-historian', dept: 'academic', name: '历史学家', description: '历史一致性质量门', prompt: 'p', executor: 'claude' },
  ];
  const depts = [
    { id: 'product', name: '产品部' },
    { id: 'design', name: '设计部' },
    { id: 'engineering', name: '工程部' },
    { id: 'security', name: '安全部' },
    { id: 'testing', name: '测试部' },
    { id: 'game-development', name: '游戏开发部' },
    { id: 'legal', name: '法务部' },
    { id: 'academic', name: '学术部' },
  ];
  const claude = { async run() { return { output: JSON.stringify({ steps: [
    { id: 'scope_requirements', role: 'product-manager', prompt: '需求范围', deps: [] },
    { id: 'system_architecture', role: 'engineering-backend-architect', prompt: '技术架构', deps: ['scope_requirements'] },
    { id: 'ux_interaction', role: 'design-ux-architect', prompt: '交互设计', deps: ['scope_requirements'] },
    { id: 'backend_domain', role: 'level-designer', prompt: '业务域设计', deps: ['system_architecture'] },
    { id: 'risk_review', role: 'legal-policy-writer', prompt: '风险复核', deps: ['backend_domain'] },
    { id: 'acceptance_test', role: 'academic-historian', prompt: '验收', deps: ['risk_review'] },
  ] }), success: true }; } };
  const plan = await makePlan('开发一个复杂的股票交易网站', { mode: 'llm', agents: ['claude', 'codex'], roles, depts, refine: true, templatesDir: __dirname, claude });
  const used = new Set();
  const walk = (steps) => (steps || []).forEach((s) => { if (s.role) used.add(s.role); if (s.body) walk(s.body); });
  walk(plan.steps);
  assert.equal(plan.planning_stats.route, 'complex-fallback');
  assert.ok(used.has('engineering-frontend-developer'));
  assert.ok(used.has('security-appsec-engineer'));
  assert.ok(used.has('testing-api-tester'));
  assert.ok(!used.has('level-designer'));
  assert.ok(!used.has('academic-historian'));
});

test('高风险复杂任务会议:参会员工覆盖产品架构前端安全测试并带固定议程', async () => {
  const roles = [
    { id: 'product-manager', dept: 'product', name: '产品经理', description: '产品范围', prompt: 'p', executor: 'claude' },
    { id: 'design-ux-architect', dept: 'design', name: 'UX架构师', description: '交互', prompt: 'p', executor: 'claude' },
    { id: 'engineering-backend-architect', dept: 'engineering', name: '后端架构师', description: '交易接口', prompt: 'p', executor: 'claude' },
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '交易界面', prompt: 'p', executor: 'claude' },
    { id: 'security-appsec-engineer', dept: 'security', name: '应用安全工程师', description: '安全与风控', prompt: 'p', executor: 'codex' },
    { id: 'security-penetration-tester', dept: 'security', name: '渗透测试员', description: '安全测试与攻击面验证', prompt: 'p', executor: 'codex' },
    { id: 'testing-api-tester', dept: 'testing', name: 'API测试员', description: '测试验收', prompt: 'p', executor: 'codex' },
  ];
  const depts = [
    { id: 'product', name: '产品部' },
    { id: 'design', name: '设计部' },
    { id: 'engineering', name: '工程部' },
    { id: 'security', name: '安全部' },
    { id: 'testing', name: '测试部' },
  ];
  const claude = { async run() { throw new Error('触发本地复杂保底'); } };
  const plan = await makePlan('开发一个复杂的股票交易网站', { agents: ['claude', 'codex'], roles, depts, refine: true, templatesDir: __dirname, claude });

  assert.ok(plan.meeting.attendees.length >= 4);
  assert.ok(plan.meeting.attendees.length <= 5);
  assert.ok(plan.meeting.attendees.includes('product-manager') || plan.meeting.hostRole === 'product-manager');
  assert.ok(plan.meeting.attendees.includes('engineering-backend-architect'));
  assert.ok(plan.meeting.attendees.includes('engineering-frontend-developer'));
  assert.ok(plan.meeting.attendees.includes('security-appsec-engineer') || plan.meeting.attendees.includes('testing-api-tester'));
  assert.ok(plan.meeting.attendees.includes('testing-api-tester'), '测试席位应优先测试部员工,不能被安全渗透测试员抢占');
  assert.deepEqual(plan.meeting.agenda, ['目标澄清', '方案推进', '反方质询', '风险复核', '经理裁决']);
  assert.equal(plan.meeting.debateRounds, 1);
});

test('复杂任务会议显式指定主持人且优先总调度', async () => {
  const roles = [
    { id: 'chief-orchestrator', dept: '__system', name: '总调度', description: '了解全部部门和员工能力,负责会议主持和最终裁决', prompt: 'p', executor: 'claude' },
    { id: 'product-manager', dept: 'product', name: '产品经理', description: '产品范围', prompt: 'p', executor: 'claude' },
    { id: 'engineering-backend-architect', dept: 'engineering', name: '后端架构师', description: '业务架构和接口', prompt: 'p', executor: 'claude' },
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '页面实现', prompt: 'p', executor: 'claude' },
    { id: 'security-appsec-engineer', dept: 'security', name: '应用安全工程师', description: '权限与安全', prompt: 'p', executor: 'codex' },
    { id: 'testing-api-tester', dept: 'testing', name: 'API测试员', description: '验收测试', prompt: 'p', executor: 'codex' },
  ];
  const depts = [
    { id: '__system', name: '系统' },
    { id: 'product', name: '产品部' },
    { id: 'engineering', name: '工程部' },
    { id: 'security', name: '安全部' },
    { id: 'testing', name: '测试部' },
  ];
  const claude = { async run() { throw new Error('触发本地复杂保底'); } };
  const plan = await makePlan('开发一个DMS 供应商管理系统', { agents: ['claude', 'codex'], roles, depts, refine: true, templatesDir: __dirname, claude });

  assert.equal(plan.meeting.hostRole, 'chief-orchestrator');
  assert.equal(plan.meeting.hostName, '总调度');
  assert.ok(plan.meeting.hostCatalog && /产品部/.test(plan.meeting.hostCatalog));
  assert.ok(plan.meeting.hostCatalog && /后端架构师/.test(plan.meeting.hostCatalog));
  assert.equal(plan.steps.find((s) => s.id === 'decide_plan').role, 'chief-orchestrator');
  assert.ok(!plan.meeting.attendees.includes('chief-orchestrator'), '主持人不应占用普通参会席位');
});

test('低置信歧义任务不擅自规划,返回A/B/C选择项', async () => {
  const roles = [
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '页面实现', prompt: 'p', executor: 'claude' },
    { id: 'testing-reality-checker', dept: 'testing', name: '真实验收', description: '验收测试', prompt: 'p', executor: 'codex' },
  ];
  let calls = 0;
  const claude = { async run() { calls++; throw new Error('歧义任务不应直接调LLM'); } };
  const plan = await makePlan('做一个网站', { agents: ['claude', 'codex'], roles, depts: [{ id: 'engineering', name: '工程部' }, { id: 'testing', name: '测试部' }], refine: true, templatesDir: __dirname, claude });
  assert.equal(calls, 0);
  assert.equal(plan.routing.lane, 'needs_choice');
  assert.equal(plan.planning_stats.route, 'awaiting-route-choice');
  assert.deepEqual(plan.routing.options.map((o) => o.id), ['A', 'B', 'C']);
  assert.equal(plan.steps.length, 0);
});

test('缩写系统需求拿不准时让用户选择,不擅自单步执行', async () => {
  const roles = [
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '页面实现', prompt: 'p', executor: 'claude' },
    { id: 'testing-reality-checker', dept: 'testing', name: '真实验收', description: '验收测试', prompt: 'p', executor: 'codex' },
  ];
  let calls = 0;
  const claude = { async run() { calls++; throw new Error('缩写歧义任务不应直接调LLM'); } };
  const plan = await makePlan('开发一个DMS系统', { agents: ['claude', 'codex'], roles, depts: [{ id: 'engineering', name: '工程部' }, { id: 'testing', name: '测试部' }], refine: true, templatesDir: __dirname, claude });

  assert.equal(calls, 0);
  assert.equal(plan.routing.lane, 'needs_choice');
  assert.equal(plan.planning_stats.route, 'awaiting-route-choice');
  assert.equal(plan.steps.length, 0);
});

test('业务对象管理系统属于复杂交付,员工规划失败也必须多员工会议保底', async () => {
  const roles = [
    { id: 'product-manager', dept: 'product', name: '产品经理', description: '需求范围与业务流程', prompt: 'p', executor: 'claude' },
    { id: 'design-ux-architect', dept: 'design', name: 'UX架构师', description: '信息架构与交互', prompt: 'p', executor: 'claude' },
    { id: 'engineering-backend-architect', dept: 'engineering', name: '后端架构师', description: '业务建模、接口和数据库', prompt: 'p', executor: 'claude' },
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '管理后台页面和组件', prompt: 'p', executor: 'claude' },
    { id: 'security-appsec-engineer', dept: 'security', name: '应用安全工程师', description: '权限、安全与审计', prompt: 'p', executor: 'codex' },
    { id: 'testing-api-tester', dept: 'testing', name: 'API测试员', description: '接口和验收测试', prompt: 'p', executor: 'codex' },
  ];
  const depts = [
    { id: 'product', name: '产品部' },
    { id: 'design', name: '设计部' },
    { id: 'engineering', name: '工程部' },
    { id: 'security', name: '安全部' },
    { id: 'testing', name: '测试部' },
  ];
  const claude = { async run() { throw new Error('模拟员工LLM规划失败'); } };
  const plan = await makePlan('开发一个DMS 供应商管理系统', { mode: 'llm', agents: ['claude', 'codex'], roles, depts, refine: true, templatesDir: __dirname, claude });
  const used = new Set();
  const walk = (steps) => (steps || []).forEach((s) => { if (s.role) used.add(s.role); if (s.body) walk(s.body); });
  walk(plan.steps);

  assert.equal(plan.routing.lane, 'complex');
  assert.match(plan.planning_stats.route, /complex/);
  assert.ok(plan.meeting, '复杂业务系统应先开方案会议');
  assert.ok(plan.steps.length >= 5, '复杂业务系统不能压成单步 build');
  assert.ok(plan.steps.length <= 9, '复杂业务系统保底编排应控制节点数量,避免无意义前置文档节点膨胀');
  assert.ok(used.has('product-manager'));
  assert.ok(used.has('engineering-backend-architect'));
  assert.ok(used.has('engineering-frontend-developer'));
  assert.ok(used.has('security-appsec-engineer') || used.has('testing-api-tester'));
  const ids = plan.steps.map((s) => s.id);
  assert.ok(!ids.includes('scope_requirements'), '明确开发类需求不应拆出独立需求范围节点');
  assert.ok(!ids.includes('system_architecture'), '明确开发类需求不应拆出独立架构文档节点');
  assert.ok(!ids.includes('ux_interaction'), '明确开发类需求不应拆出独立交互文档节点');
  const stepText = JSON.stringify(plan.steps);
  assert.match(stepText, /frontend\/dist\/index\.html/, '复杂业务系统应明确产出前端发布入口');
  assert.match(stepText, /backend\//, '复杂业务系统应明确产出后端服务目录');
  assert.match(stepText, /orch\.app\.json/, '复杂业务系统应明确产出应用广场发布清单');
  assert.match(stepText, /ORCH_APP_PORT|process\.env\.PORT|PORT/, '复杂业务系统后端应监听平台分配端口');
  assert.match(stepText, /\/api/, '复杂业务系统前后端应约定 /api 接口前缀');
  assert.ok(plan.steps.some((s) => s.id === 'publish_manifest'), '复杂业务系统应有发布清单步骤');
});

test('显式前后端技术栈的网站开发必须复杂编排并列清技术架构', async () => {
  const roles = [
    { id: 'product-manager', dept: 'product', name: '产品经理', description: '需求范围与业务流程', prompt: 'p', executor: 'claude' },
    { id: 'engineering-backend-architect', dept: 'engineering', name: '后端架构师', description: '业务建模、接口和数据库', prompt: 'p', executor: 'claude' },
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: 'Vue页面和组件', prompt: 'p', executor: 'claude' },
    { id: 'testing-api-tester', dept: 'testing', name: 'API测试员', description: '接口和验收测试', prompt: 'p', executor: 'codex' },
  ];
  const depts = [
    { id: 'product', name: '产品部' },
    { id: 'engineering', name: '工程部' },
    { id: 'testing', name: '测试部' },
  ];
  const claude = { async run() { throw new Error('模拟员工LLM规划失败'); } };
  const plan = await makePlan('前端使用 vue 后段使用 java springboot 开发一个 天气小工具网站', { mode: 'llm', agents: ['claude', 'codex'], roles, depts, refine: true, templatesDir: __dirname, claude });
  const stepText = JSON.stringify(plan.steps);

  assert.equal(plan.routing.lane, 'complex');
  assert.ok(plan.meeting, '显式前后端开发应进入方案会议');
  const ids = plan.steps.map((s) => s.id);
  const workIds = ids.filter((id) => !/^meet_/.test(id) && id !== 'decide_plan');
  assert.deepEqual(workIds, ['backend_impl', 'frontend_impl', 'publish_manifest', 'acceptance_test']);
  assert.ok(!ids.includes('scope_requirements'), '显式前后端开发不应拆出独立需求范围节点');
  assert.ok(!ids.includes('system_architecture'), '显式前后端开发不应拆出独立架构文档节点');
  assert.ok(!ids.includes('ux_interaction'), '显式前后端开发不应拆出独立交互文档节点');
  assert.match(stepText, /Vue|vue/);
  assert.match(stepText, /Java|JDK|jdk/);
  assert.match(stepText, /SpringBoot|Spring Boot|springboot/);
  assert.match(stepText, /技术架构|技术栈|架构清单/);
  assert.match(stepText, /frontend\/dist\/index\.html/);
  assert.match(stepText, /backend\//);
  assert.match(stepText, /orch\.app\.json/);
});

test('流程类型:复杂股票交易网站标记为高风险复核流程', async () => {
  const roles = [
    { id: 'product-manager', dept: 'product', name: '产品经理', description: 'PRD与范围', prompt: 'p', executor: 'claude' },
    { id: 'engineering-backend-architect', dept: 'engineering', name: '后端架构师', description: '交易接口和数据库', prompt: 'p', executor: 'claude' },
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '交易页面和行情看板', prompt: 'p', executor: 'claude' },
    { id: 'security-appsec-engineer', dept: 'security', name: '应用安全工程师', description: '权限、安全、风控', prompt: 'p', executor: 'codex' },
    { id: 'testing-api-tester', dept: 'testing', name: 'API测试员', description: '接口和验收测试', prompt: 'p', executor: 'codex' },
  ];
  const depts = [
    { id: 'product', name: '产品部' },
    { id: 'engineering', name: '工程部' },
    { id: 'security', name: '安全部' },
    { id: 'testing', name: '测试部' },
  ];
  const claude = { async run() { throw new Error('触发本地复杂保底'); } };
  const plan = await makePlan('开发一个复杂的股票交易网站', { agents: ['claude', 'codex'], roles, depts, refine: true, templatesDir: __dirname, claude });

  assert.equal(plan.process.type, 'risk_review');
  assert.equal(plan.process.risk_review, true);
  assert.equal(plan.process.debate_rounds, 1);
  assert.match(plan.process.reason, /股票|交易|金融|风险|复杂/);
  assert.equal(plan.planning_stats.process_type, 'risk_review');
});

test('流程类型:低置信歧义任务标记为 ask_user', async () => {
  const roles = [
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '页面实现', prompt: 'p', executor: 'claude' },
    { id: 'testing-reality-checker', dept: 'testing', name: '真实验收', description: '验收测试', prompt: 'p', executor: 'codex' },
  ];
  const claude = { async run() { throw new Error('歧义任务不应调用模型'); } };
  const plan = await makePlan('做一个网站', { agents: ['claude', 'codex'], roles, depts: [{ id: 'engineering', name: '工程部' }, { id: 'testing', name: '测试部' }], refine: true, templatesDir: __dirname, claude });

  assert.equal(plan.process.type, 'ask_user');
  assert.equal(plan.planning_stats.process_type, 'ask_user');
  assert.equal(plan.routing.lane, 'needs_choice');
});

test('计划复核:发现非法依赖和缺失员工', () => {
  const roles = [
    { id: 'backend', dept: 'engineering', name: '后端', description: 'API', prompt: 'p', executor: 'claude' },
  ];
  const plan = { task: '开发交易系统', steps: [
    { id: 'build', role: 'missing-role', prompt: '实现', deps: ['future'] },
    { id: 'future', role: 'backend', prompt: '后续', deps: ['future'] },
  ] };

  const result = validateCrewPlan(plan, roles, '开发交易系统');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => /员工|role/.test(x)));
  assert.ok(result.errors.some((x) => /依赖|deps/.test(x)));
});

test('风险复核流程缺少安全/风险/测试角色时不通过', () => {
  const roles = [
    { id: 'product-manager', dept: 'product', name: '产品经理', description: '产品', prompt: 'p', executor: 'claude' },
    { id: 'engineering-backend-architect', dept: 'engineering', name: '后端架构师', description: '交易接口', prompt: 'p', executor: 'claude' },
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '页面', prompt: 'p', executor: 'claude' },
  ];
  const plan = { task: '开发企业门户', process: { type: 'risk_review' }, steps: [
    { id: 'scope', role: 'product-manager', prompt: '需求', deps: [] },
    { id: 'backend', role: 'engineering-backend-architect', prompt: '后端', deps: ['scope'] },
    { id: 'frontend', role: 'engineering-frontend-developer', prompt: '前端', deps: ['backend'] },
    { id: 'acceptance', role: 'engineering-frontend-developer', prompt: '验收', deps: ['frontend'] },
  ] };

  const result = validateCrewPlan(plan, roles, '开发企业门户');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => /安全|风险|测试/.test(x)));
});

test('makePlan 输出应带 validation', async () => {
  const roles = [{ id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '前端', prompt: 'p', executor: 'claude' }];
  const depts = [{ id: 'engineering', name: '工程' }];
  const fakeClaude = {
    async run() {
      return { output: '{"steps":[{"id":"build","role":"engineering-frontend-developer","prompt":"开发页面","deps":[]}]}', success: true };
    },
  };

  const plan = await makePlan('开发企业门户', { mode: 'llm', agents: ['claude'], roles, depts, refine: false, templatesDir: __dirname, claude: fakeClaude });
  assert.ok(plan.validation && typeof plan.validation === 'object');
  assert.equal(typeof plan.validation.ok, 'boolean');
});
