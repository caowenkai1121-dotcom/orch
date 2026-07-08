// 轮211:①会议参会人智能挑选 ②执行顺序=确认顺序 ③API 大模型三项接入 ④定向质询轮 ⑤日志裁剪
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { open } = require('../store');
const { prependMeeting, sequentializeSteps } = require('../planner');
const { endpointOf } = require('../adapters/openai');
const { runTask } = require('../runner');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ROLES = {
  pm: { name: '产品经理', description: '需求梳理与产品规划', dept: 'product', executor: 'claude' },
  be: { name: '后端架构师', description: '后端架构与接口设计', dept: 'engineering', executor: 'claude' },
  fe: { name: '前端工程师', description: '前端页面与交互实现', dept: 'engineering', executor: 'claude' },
  sec: { name: '安全风控专家', description: '应用安全与风控合规', dept: 'security', executor: 'claude' },
  qa: { name: '测试员', description: '功能验证与验收测试', dept: 'testing', executor: 'codex' },
  mkt: { name: '内容营销', description: '公众号文章与内容策划', dept: 'marketing', executor: 'claude' },
  mkt2: { name: '发布运营', description: '发布计划与渠道投放', dept: 'marketing', executor: 'claude' },
};

test('参会人挑选:金融任务必拉安全风控,计划内执行角色入会', () => {
  const plan = {
    task: '开发股票交易网站,含行情、下单、持仓',
    steps: [
      { id: 'a', role: 'be', prompt: 'x', deps: [] },
      { id: 'b', role: 'fe', prompt: 'x', deps: [] },
      { id: 'c', role: 'be', prompt: 'x', deps: [] },
      { id: 'd', role: 'qa', prompt: 'x', deps: [] },
    ],
  };
  prependMeeting(plan, ROLES, 'engineering', []);
  const att = plan.meeting.attendees;
  assert.ok(att.includes('sec'), '涉金融/交易必须拉安全风控, 实际=' + att);
  ['be', 'fe', 'qa'].forEach((r) => assert.ok(att.includes(r), '计划内执行角色 ' + r + ' 应入会, 实际=' + att));
});

test('参会人挑选:纯文案任务不硬拉前端/安全,执行角色优先', () => {
  const plan = {
    task: '写一篇产品发布公众号文章并给出发布计划',
    steps: [
      { id: 'a', role: 'mkt', prompt: 'x', deps: [] },
      { id: 'b', role: 'mkt2', prompt: 'x', deps: [] },
      { id: 'c', role: 'mkt', prompt: 'x', deps: [] },
      { id: 'd', role: 'mkt2', prompt: 'x', deps: [] },
    ],
  };
  prependMeeting(plan, ROLES, 'marketing', []);
  const att = plan.meeting.attendees;
  assert.ok(!att.includes('fe'), '无界面任务不该硬拉前端, 实际=' + att);
  assert.ok(!att.includes('sec'), '无风险任务不该硬拉安全, 实际=' + att);
  assert.ok(att.includes('mkt') && att.includes('mkt2'), '执行角色应入会, 实际=' + att);
});

test('执行顺序=确认顺序:拓扑重排 + 实现步链式依赖,会议步不入链', () => {
  const plan = {
    task: 't',
    steps: [
      { id: 'meet_a', role: 'be', prompt: 'x', deps: [] },
      { id: 'meet_b', role: 'fe', prompt: 'x', deps: [] },
      { id: 'decide_plan', role: 'be', prompt: 'x', deps: ['meet_a', 'meet_b'] },
      { id: 's_ui', role: 'fe', prompt: 'x', deps: ['decide_plan'] },
      { id: 's_api', role: 'be', prompt: 'x', deps: ['decide_plan'] }, // 原本与 s_ui 并行
      { id: 's_test', role: 'qa', prompt: 'x', deps: ['decide_plan'] },
    ],
    meeting: { attendees: ['be', 'fe'], meetIds: ['meet_a', 'meet_b'], decideId: 'decide_plan' },
  };
  sequentializeSteps(plan);
  const ids = plan.steps.map((s) => s.id);
  assert.deepEqual(ids, ['meet_a', 'meet_b', 'decide_plan', 's_ui', 's_api', 's_test'], '数组顺序应=拓扑执行顺序');
  const byId = {}; plan.steps.forEach((s) => { byId[s.id] = s; });
  assert.ok(byId.s_api.deps.includes('s_ui'), 's_api 应链到前一实现步 s_ui(不再并行)');
  assert.ok(byId.s_test.deps.includes('s_api'), 's_test 应链到 s_api');
  assert.ok(!byId.meet_b.deps.includes('meet_a'), '会议发言步保持并行,不入链');
});

test('员工能力档案纳入本地匹配:description 无关但角色卡含"接口"→接口任务的会议选人命中它', () => {
  const planner = require('../planner');
  const beHidden = { id: 'be-x', name: '实现者A', description: '内容产出', dept: 'eng', prompt: '【身份】资深后端\n【关键规则】接口设计先行,数据库事务保障' };
  const writer = { id: 'w-y', name: '实现者B', description: '内容产出', dept: 'mkt', prompt: '【身份】资深写手\n【关键规则】文风统一' };
  const qa = { id: 'qa-z', name: '测试员', description: '功能验证与验收测试', dept: 'testing', prompt: '' };
  const mplan = { task: '修复接口报错并优化接口逻辑', steps: [
    { id: 'a', role: 'be-x', prompt: 'x', deps: [] }, { id: 'b', role: 'be-x', prompt: 'x', deps: [] },
    { id: 'c', role: 'be-x', prompt: 'x', deps: [] }, { id: 'd', role: 'qa-z', prompt: 'x', deps: [] }] };
  planner.prependMeeting(mplan, { 'be-x': beHidden, 'w-y': writer, 'qa-z': qa, pm: { id: 'pm', name: '产品经理', description: '需求梳理', dept: 'product', prompt: '' } }, 'eng', []);
  assert.ok(mplan.meeting && mplan.meeting.attendees.includes('be-x'), '角色卡含"接口"的员工应因能力档案匹配入会');
  assert.ok(!mplan.meeting.attendees.includes('w-y'), '能力无关的写手不应入会, 实际=' + (mplan.meeting && mplan.meeting.attendees));
});

test('分层员工目录:主部门全能力档案,其他部门仅一句话简介', async () => {
  const planner = require('../planner');
  let seen = '';
  const claude = { async run({ prompt }) { seen = prompt; return { output: '{"steps":[{"id":"a","role":"eng1","prompt":"做","deps":[],"why":"后端能力对口"}]}', success: true }; } };
  const roles = [
    { id: 'eng1', dept: 'eng', name: '后端工程师', description: '接口与数据', prompt: '【身份】资深后端\n【关键规则】接口先行\n【交付物标准】可运行服务', done_count: 0, empty_count: 0 },
    { id: 'mkt1', dept: 'mkt', name: '文案', description: '公众号内容创作与投放', prompt: '【身份】资深文案\n【关键规则】文风统一\n【交付物标准】成稿', done_count: 0, empty_count: 0 },
  ];
  const depts = [{ id: 'eng', name: '工程部' }, { id: 'mkt', name: '营销部' }];
  const p = await planner.fromLLMRoles('做一个接口服务', claude, roles, depts, '', null, '', undefined, 'eng');
  assert.ok(seen.includes('目录说明'), '应说明分层目录规则');
  const engSeg = seen.split('\n').find((l) => l.startsWith('工程部:')) || '';
  const mktSeg = seen.split('\n').find((l) => l.startsWith('营销部:')) || '';
  assert.ok(/身份:|规则:/.test(engSeg), '主部门员工应带完整能力档案, 实际=' + engSeg.slice(0, 120));
  assert.ok(!/身份:|规则:/.test(mktSeg) && mktSeg.includes('公众号内容创作'), '其他部门只给一句话简介, 实际=' + mktSeg.slice(0, 120));
  assert.equal(p.steps[0].why, '后端能力对口', 'why 字段应被解析保留');
});

test('指派理由 why 全链透传:sanitize/顺序化/resolveRoles 不丢,api.plan 输出 assignWhy', () => {
  const planner = require('../planner');
  const api = require('../api');
  const plan = { task: 't', steps: [
    { id: 's1', role: 'be', agent: 'claude', prompt: '实现', deps: [], why: '能力对口MARKER' },
    { id: 's2', role: 'be', agent: 'claude', prompt: '测试', deps: ['s1'], why: '验收专长MARKER' },
  ] };
  planner.sanitizeDeps(plan);
  planner.sequentializeSteps(plan);
  planner.resolveRoles(plan.steps, { be: { id: 'be', name: '后端', dept: 'eng', executor: 'claude', prompt: '你是后端' } }, ['claude'], {}, 't', []);
  assert.equal(plan.steps[0].why, '能力对口MARKER');
  const s = open(':memory:');
  const id = s.createTask('t');
  s.setPlan(id, plan);
  const rows = api.plan(s, id);
  assert.equal(rows[0].assignWhy, '能力对口MARKER');
  assert.equal(rows[1].assignWhy, '验收专长MARKER');
});

test('openai 适配器:三项接入(地址/Key/模型)真实调用与用量', async () => {
  let seen = null;
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '你好,方案要点如下' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  const store = open(':memory:');
  store.addAgent({ id: 'ds', name: 'DeepSeek', kind: 'llm', base_url: 'http://127.0.0.1:' + port + '/v1', api_key: 'sk-test', model: 'deepseek-chat' });
  const adapters = require('../bootstrap').buildAdapters(store);
  let usage = null;
  const r = await adapters.ds.run({ prompt: '就本任务给出方案要点', onLine: () => {}, onUsage: (u) => { usage = u; } });
  srv.close();
  assert.equal(r.success, true);
  assert.ok(r.output.includes('方案要点'));
  assert.equal(seen.url, '/v1/chat/completions');
  assert.equal(seen.auth, 'Bearer sk-test');
  assert.equal(seen.body.model, 'deepseek-chat');
  assert.equal(usage.input, 10); assert.equal(usage.output, 5);
});

test('endpointOf:裸域名/带 v1/带完整路径都归一到 chat/completions', () => {
  assert.equal(endpointOf('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
  assert.equal(endpointOf('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(endpointOf('https://x.com/v1/chat/completions'), 'https://x.com/v1/chat/completions');
});

test('会议定向质询轮:judge 判 continue 点名员工 → 补充发言 → 再判定 consensus 收束', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-r211-followup-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('开发复杂应用');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  store.addRole({ id: 'fe2', dept: 'eng', name: '前端', prompt: '负责前端', executor: 'claude' });
  const plan = {
    task: '开发复杂应用',
    steps: [
      { id: 'meet_arch', role: 'arch', agent: 'claude', prompt: '开场', deps: [] },
      { id: 'meet_fe2', role: 'fe2', agent: 'claude', prompt: '开场', deps: [] },
      { id: 'decide_plan', role: 'arch', agent: 'claude', prompt: '综合', deps: ['meet_arch', 'meet_fe2'] },
      { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { attendees: ['arch', 'fe2'], meetIds: ['meet_arch', 'meet_fe2'], decideId: 'decide_plan', hostRole: 'arch' },
  };
  let judgeN = 0;
  const echo = { async run({ prompt }) {
    if (/会议共识判定/.test(prompt)) {
      judgeN++;
      return { output: judgeN === 1 ? '{"status":"continue","reason":"存储方案有分歧","speakers":["fe2"]}' : '{"status":"consensus","reason":"分歧已解决"}', success: true };
    }
    return { output: '发言:观点无、风险无、建议无、待确认无', success: true };
  } };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };
  await runTask(id, deps);
  await wait(400); // 开场发言 + judge1 + 质询发言 + judge2 + endMeeting + execute(全 echo,快)
  assert.equal(store.getEvents(id).filter((e) => e.type === 'meeting_followup').length, 1, '应发生且仅一轮定向质询');
  const msgs = store.listMeetingMsgs(id).map((m) => m.text).join('\n');
  assert.ok(msgs.includes('定向质询'), '应有主持人点名质询消息');
  assert.equal(judgeN, 2, '质询后应再判定一次, 实际=' + judgeN);
  assert.equal(store.getMeeting(id).status, 'closed', '第二次 consensus 应自动收束');
  assert.equal(store.getTask(id).status, 'done', '收束后应执行实现步至完成');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('交接全文落盘:长产出写 交接/<步骤id>.md,下游 prompt 注入摘要+全文指针;短产出不落盘', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-r211-handoff-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('两步任务');
  store.setTaskDir(id, dir);
  const plan = {
    task: '两步任务',
    steps: [
      { id: 'a', agent: 'claude', prompt: '第一步:出接口约定', deps: [] },
      { id: 'b', agent: 'claude', prompt: '第二步:按约定实现', deps: ['a'] },
      { id: 'c', agent: 'claude', prompt: '第三步:短产出', deps: ['b'] },
    ],
  };
  const prompts = {};
  const echo = { async run({ prompt }) {
    if (prompt.includes('第一步')) { prompts.a = prompt; return { output: '细节'.repeat(1500) + '\n【交接备忘】接口约定MARKER', success: true }; } // >1200,落盘
    if (prompt.includes('第二步')) { prompts.b = prompt; return { output: '短结果', success: true } } // ≤1200,不落盘
    prompts.c = prompt; return { output: 'ok', success: true };
  } };
  await runTask(id, { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan });
  assert.equal(store.getTask(id).status, 'done');
  const fp = path.join(dir, '交接', 'a.md');
  assert.ok(fs.existsSync(fp), '长产出应落盘 交接/a.md');
  assert.ok(fs.readFileSync(fp, 'utf8').includes('接口约定MARKER'), '落盘应含完整产出');
  assert.ok(prompts.b.includes('交接/a.md'), 'b 的 prompt 应含上游全文指针, 实际无');
  assert.ok(prompts.b.includes('【交接备忘】'), 'b 仍应有摘要注入(下限保障)');
  assert.ok(!fs.existsSync(path.join(dir, '交接', 'b.md')), '短产出不落盘');
  assert.ok(!prompts.c.includes('交接/b.md'), '无落盘则不注指针');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('终验闭环:FAIL→自动派修复步→复验 PASS,事件与消息齐全且只修一轮', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-r211-final-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('做一个计算器页面');
  store.setTaskDir(id, dir);
  const plan = {
    task: '做一个计算器页面',
    steps: [
      { id: 'impl', agent: 'claude', prompt: '实现页面', deps: [] },
      { id: 'style', agent: 'claude', prompt: '美化样式', deps: ['impl'] },
    ],
  };
  let reviewN = 0; const fixPrompts = [];
  const echo = { async run({ prompt }) {
    if (prompt.includes('任务终验')) {
      reviewN++;
      return { output: reviewN === 1
        ? '{"verdict":"FAIL","summary":"按钮缺失","issues":[{"problem":"缺少等号按钮MARKER","fix":"补上"}]}'
        : '{"verdict":"PASS","summary":"目标达成"}', success: true };
    }
    if (prompt.includes('终验修复')) fixPrompts.push(prompt);
    return { output: 'ok', success: true };
  } };
  await runTask(id, { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan });
  for (let i = 0; i < 40 && store.getEvents(id).filter((e) => e.type === 'final_review').length < 2; i++) await wait(50); // 终验异步
  const reviews = store.getEvents(id).filter((e) => e.type === 'final_review').map((e) => JSON.parse(e.data).verdict);
  assert.deepEqual(reviews, ['FAIL', 'PASS'], '应先 FAIL 后复验 PASS, 实际=' + reviews);
  assert.equal(fixPrompts.length, 1, '应且仅派一轮修复');
  assert.ok(fixPrompts[0].includes('等号按钮MARKER'), '修复步应带具体问题');
  const st = {}; (store.getTask(id).steps || []).forEach((s) => { st[s.step_id] = s.status; });
  assert.equal(st.final_fix_1, 'done');
  const msgs = store.getTaskMsgs(id).map((m) => m.text).join('\n');
  assert.ok(msgs.includes('终验未通过') && msgs.includes('终验通过'), '消息流应含未通过与最终通过');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('瞬时故障原地重试一次:ECONNRESET 重试后成功;普通失败不重试', async () => {
  const { runPlan } = require('../engine');
  let calls = 0;
  const flaky = { async run() { calls++; return calls === 1 ? { output: 'Error: read ECONNRESET', success: false } : { output: 'ok', success: true }; } };
  const ctx = { adapters: { claude: flaky }, workspace: { make: async () => process.cwd() }, onStatus: () => {}, onLog: () => {} };
  const done = await runPlan({ steps: [{ id: 's', agent: 'claude', prompt: 'x', deps: [] }] }, ctx);
  assert.equal(calls, 2, '瞬时故障应重试一次');
  assert.ok(done.s.success, '重试成功应记为 done');
  let calls2 = 0;
  const broken = { async run() { calls2++; return { output: '语法错误,任务失败', success: false }; } };
  const ctx2 = { adapters: { claude: broken }, workspace: { make: async () => process.cwd() }, onStatus: () => {}, onLog: () => {} };
  const done2 = await runPlan({ steps: [{ id: 's', agent: 'claude', prompt: 'x', deps: [] }] }, ctx2);
  assert.equal(calls2, 1, '非瞬时失败不应重试');
  assert.ok(!done2.s.success);
});

test('model/effort 白名单清洗:shell 元字符值被丢弃回退默认,合法模型 id 放行', async () => {
  const { runPlan } = require('../engine');
  const seen = [];
  const spy = { async run({ model, effort }) { seen.push({ model, effort }); return { output: 'ok', success: true }; } };
  const mk = (models) => ({ adapters: { claude: spy }, workspace: { make: async () => process.cwd() }, onStatus: () => {}, onLog: () => {}, models });
  await runPlan({ steps: [{ id: 'a', agent: 'claude', prompt: 'x', deps: [] }] }, mk({ claude: { model: 'x"; rm -rf ~; echo "', effort: 'high; calc' } }));
  assert.equal(seen[0].model, null, '注入型 model 应被丢弃');
  assert.equal(seen[0].effort, null, '注入型 effort 应被丢弃');
  await runPlan({ steps: [{ id: 'a', agent: 'claude', prompt: 'x', deps: [] }] }, mk({ claude: { model: 'claude-fable-5', effort: 'xhigh' } }));
  assert.equal(seen[1].model, 'claude-fable-5');
  assert.equal(seen[1].effort, 'xhigh');
});

test('pruneSteps:重规划后废弃步骤行被清理,保留仍在计划内的', () => {
  const s = open(':memory:');
  const id = s.createTask('t');
  s.setStep(id, 'keep_done', 'claude', 'done', 'ok');
  s.setStep(id, 'dead_fail', 'claude', 'failed', 'err');
  s.setStep(id, 'r1_new', 'claude', 'pending', null);
  s.pruneSteps(id, ['keep_done', 'r1_new']);
  const ids = (s.getTask(id).steps || []).map((x) => x.step_id).sort();
  assert.deepEqual(ids, ['keep_done', 'r1_new'], '废弃步应被清掉, 实际=' + ids);
});

test('LLM 拆解 JSON 语法坏:修复回喂一次而非整轮降级', async () => {
  const planner = require('../planner');
  let calls = 0;
  const claude = { async run({ prompt }) {
    calls++;
    if (prompt.includes('语法有误')) return { output: '{"steps":[{"id":"a","role":"eng1","prompt":"做","deps":[]}]}', success: true }; // 修复轮
    return { output: '{"steps":[{"id":"a","role":"eng1","prompt":"做","deps":[],]}', success: true }; // 坏 JSON(尾逗号+错括号)
  } };
  const roles = [{ id: 'eng1', dept: 'eng', name: '后端', description: '接口', prompt: '【身份】后端', done_count: 0, empty_count: 0 }];
  const p = await planner.fromLLMRoles('做接口', claude, roles, [{ id: 'eng', name: '工程部' }], '', null, '', undefined, null);
  assert.equal(p.steps[0].id, 'a', '修复后应拿到合法计划');
  assert.equal(calls, 2, '应恰好一次修复回喂, 实际=' + calls);
});

test('ensureOutputGit:自建产出仓写 .gitignore(node_modules 不进版本化)', () => {
  const { ensureOutputGit } = require('../runner');
  const dir = path.join(os.tmpdir(), 'orch-r212-git-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const ok = ensureOutputGit(dir);
  assert.ok(ok);
  const gi = path.join(dir, '.gitignore');
  assert.ok(fs.existsSync(gi), '应写 .gitignore');
  assert.ok(fs.readFileSync(gi, 'utf8').includes('node_modules'), '应忽略 node_modules');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('任务进度按计划顶层步骤统计:loop 子步不再双计分母', () => {
  const api = require('../api');
  const s = open(':memory:');
  s.seed();
  const id = s.createTask('t');
  s.setPlan(id, { task: 't', steps: [
    { id: 'top1', agent: 'claude', prompt: 'x', deps: [] },
    { id: 'qloop', type: 'loop', until: 'pass', deps: ['top1'], body: [{ id: 'impl_x', agent: 'claude', prompt: 'x' }, { id: 'gate_x', agent: 'claude', prompt: 'x' }] },
  ] });
  ['top1', 'impl_x', 'gate_x', 'qloop'].forEach((sid) => s.setStep(id, sid, 'claude', 'done', 'ok'));
  const t = api.buildAll(s, null).tasks.find((x) => x.id === id);
  assert.equal(t.progressLabel, '2/2 步', 'loop 子步不应计入分母, 实际=' + t.progressLabel);
  assert.equal(t.progress, 100);
});

test('僵尸恢复补状态事件:耗时统计不再永远显示运行中', () => {
  const boot = require('../bootstrap');
  const api = require('../api');
  const s = open(':memory:');
  const id = s.createTask('t');
  s.setPlan(id, { task: 't', steps: [{ id: 's1', agent: 'claude', prompt: 'x', deps: [] }] });
  s.setTaskStatus(id, 'running');
  s.setStep(id, 's1', 'claude', 'running', null);
  s.addEvent(id, 'status', { step: 's1', v: 'running' });
  boot.recoverZombies(s);
  const evs = s.getEvents(id).filter((e) => e.type === 'status').map((e) => JSON.parse(e.data).v);
  assert.ok(evs.includes('failed'), '恢复应补 failed 状态事件, 实际=' + evs);
  const rows = api.relay(s, id);
  assert.ok(!/^⏱ /.test(rows[0].dur || ''), '耗时不应仍显示运行中, 实际=' + rows[0].dur);
});

test('复盘吸收终验结果:harvest prompt 注入 final_review 判定与问题', async () => {
  const { harvestExperience } = require('../runner');
  const s = open(':memory:');
  s.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  s.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  const id = s.createTask('t');
  s.setPlan(id, { task: 't', steps: [{ id: 'impl', role: 'arch', agent: 'claude', prompt: 'x', deps: [] }] });
  s.setStep(id, 'impl', 'claude', 'done', 'ok');
  s.setTaskStatus(id, 'done');
  s.addEvent(id, 'final_review', { verdict: 'FAIL', summary: '按钮缺失', issues: [{ problem: '缺少等号按钮HARVEST_MARK' }] });
  let seen = '';
  const claude = { async run({ prompt }) { seen = prompt; return { output: '{"employees":{},"chief":""}', success: true }; } };
  await harvestExperience(id, { store: s, adapters: { claude } });
  assert.ok(seen.includes('HARVEST_MARK'), '复盘 prompt 应含终验问题, 实际含终验=' + seen.includes('终验'));
});

test('addRole upsert:种子升级/导入覆盖角色卡时保留 memo 与绩效(不再擦经验)', () => {
  const s = open(':memory:');
  s.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '旧卡', executor: 'claude' });
  s.appendRoleMemo('arch', '踩过的坑:先看现状再改');
  s.addRoleStat('arch', true); s.addRoleStat('arch', true); s.addRoleStat('arch', false);
  s.addRole({ id: 'arch', dept: 'eng', name: '架构师v2', prompt: '新卡内容', executor: 'codex' }); // 模拟 roles-seed 版本升级
  const r = s.getRole('arch');
  assert.equal(r.name, '架构师v2', '角色卡应更新');
  assert.equal(r.prompt, '新卡内容');
  assert.equal(r.executor, 'codex');
  assert.ok((r.memo || '').includes('踩过的坑'), '经验必须保留, 实际=' + r.memo);
  assert.equal(r.done_count, 2, '落盘绩效必须保留');
  assert.equal(r.empty_count, 1, '空转绩效必须保留');
});

test('addAgent upsert:覆盖时保留 enabled/默认模型/API Key(空传不擦 Key)', () => {
  const s = open(':memory:');
  s.addAgent({ id: 'ds', name: 'DeepSeek', kind: 'llm', base_url: 'https://a/v1', api_key: 'k1', model: 'deepseek-chat' });
  s.setAgentEnabled('ds', false);
  s.setAgentDefaults('ds', 'deepseek-chat', 'high');
  s.addAgent({ id: 'ds', name: 'DeepSeek改', kind: 'llm', base_url: 'https://b/v1', api_key: '', model: 'deepseek-chat' });
  const a = s.listAgents().find((x) => x.id === 'ds');
  assert.equal(a.name, 'DeepSeek改');
  assert.equal(a.base_url, 'https://b/v1');
  assert.equal(a.api_key, 'k1', '空传不得擦 Key');
  assert.equal(a.enabled, 0, '停用状态必须保留');
  assert.equal(a.default_model, 'deepseek-chat', '默认模型必须保留');
});

test('自定义 CLI 超长 prompt:明确报错而非神秘 spawn 失败(仅 Windows)', async (t) => {
  if (process.platform !== 'win32') return t.skip('仅 Windows 命令行上限');
  const generic = require('../adapters/generic');
  const a = generic.make({ id: 'g1', command: 'echo', args: '[]' });
  const lines = [];
  const r = await a.run({ prompt: 'X'.repeat(9000), workdir: process.cwd(), onLine: (l) => lines.push(l) });
  assert.equal(r.success, false);
  assert.ok(r.output.includes('命令行上限'), '应明确报错, 实际=' + r.output.slice(0, 80));
  assert.ok(lines.some((l) => l.includes('claude/codex')), '应给出改派建议');
});

test('buildAll 消除逐任务 getTask 的 N+1:多任务只批量取 plan,不再 N 次 getTask', () => {
  const api = require('../api');
  const s = open(':memory:');
  s.seed();
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const id = s.createTask('任务' + i);
    s.setPlan(id, { task: '任务' + i, steps: [{ id: 'a', role: 'chief-orchestrator', agent: 'claude', prompt: 'x', deps: [] }] });
    s.setStep(id, 'a', 'claude', i % 2 ? 'done' : 'running', 'ok');
    s.setTaskStatus(id, i % 2 ? 'done' : 'running');
    ids.push(id);
  }
  let getTaskCalls = 0;
  const orig = s.getTask.bind(s);
  s.getTask = (x) => { getTaskCalls++; return orig(x); };
  const built = api.buildAll(s, null);
  assert.equal(built.tasks.length, 6, '6 个任务都应出现');
  // 6 任务若走旧 N+1 路径至少 6+ 次 getTask;批量后 buildAll 主体应为 0 次(仅个别遗留调用允许 < 任务数)
  assert.ok(getTaskCalls < 6, 'getTask 调用应远少于任务数(N+1 已消除), 实际=' + getTaskCalls);
  // 进度仍按 plan 顶层步骤正确统计(done 任务 1/1,running 任务 0/1)
  assert.ok(built.tasks.every((t) => /^[01]\/1 步$/.test(t.progressLabel)), '进度应按批量取的 plan 正确统计, 实际=' + built.tasks.map((t) => t.progressLabel).join(','));
  assert.ok(built.tasks.some((t) => t.progressLabel === '1/1 步') && built.tasks.some((t) => t.progressLabel === '0/1 步'), '应同时有完成与进行中的进度');
});

test('agentAvgSecondsAll/agentTotalsAll 批量结果严格等价逐个算法', () => {
  const s = open(':memory:');
  s.seed();
  // 造两个执行器、多任务、带 running→done 时差事件
  const mk = (tid, agent, step, dRunning, dDone) => {
    s.setStep(tid, step, agent, 'done', 'ok');
    s.db.prepare('INSERT INTO events(task_id,ts,type,data) VALUES(?,?,?,?)').run(tid, new Date(dRunning).toISOString(), 'status', JSON.stringify({ step, v: 'running' }));
    s.db.prepare('INSERT INTO events(task_id,ts,type,data) VALUES(?,?,?,?)').run(tid, new Date(dDone).toISOString(), 'status', JSON.stringify({ step, v: 'done' }));
    s.addUsage(tid, step, agent, { input: 100, output: 50, cost: 0.01 });
  };
  const t1 = s.createTask('a'), t2 = s.createTask('b');
  const base = 1700000000000;
  mk(t1, 'claude', 's1', base, base + 30000);        // 30s
  mk(t1, 'codex', 's2', base + 5000, base + 5000 + 90000); // 90s
  mk(t2, 'claude', 's1', base, base + 10000);        // 10s → claude 平均 (30+10)/2=20s
  const avgAll = s.agentAvgSecondsAll();
  const totAll = s.agentTotalsAll();
  ['claude', 'codex'].forEach((ag) => {
    assert.equal(avgAll.get(ag) || 0, s.agentAvgSeconds(ag), '平均耗时批量应等价逐个: ' + ag);
    assert.equal((totAll.get(ag) || {}).cost || 0, s.agentTotals(ag).cost, '累计成本批量应等价逐个: ' + ag);
  });
  assert.equal(avgAll.get('claude'), 20, 'claude 平均应为 20s');
});

test('lastLogLine 命中某步最后一行,等价全量倒序找', () => {
  const s = open(':memory:');
  const id = s.createTask('t');
  s.addLog(id, 's1', 'a'); s.addLog(id, 's2', 'x'); s.addLog(id, 's1', 'b'); s.addLog(id, 's1', 'c');
  assert.equal(s.lastLogLine(id, 's1'), 'c');
  assert.equal(s.lastLogLine(id, 's2'), 'x');
  assert.equal(s.lastLogLine(id, 'none'), '');
});

test('buildAll 不再逐执行器调 agentAvgSeconds/agentTotals(批量一次)', () => {
  const api = require('../api');
  const s = open(':memory:');
  s.seed();
  const id = s.createTask('t'); s.setStep(id, 's1', 'claude', 'done', 'ok'); s.setTaskStatus(id, 'done');
  let avgCalls = 0, totCalls = 0;
  const oa = s.agentAvgSeconds.bind(s), ot = s.agentTotals.bind(s);
  s.agentAvgSeconds = (x) => { avgCalls++; return oa(x); };
  s.agentTotals = (x) => { totCalls++; return ot(x); };
  api.buildAll(s, null);
  assert.equal(avgCalls, 0, 'buildAll 不应再逐个调 agentAvgSeconds, 实际=' + avgCalls);
  assert.equal(totCalls, 0, 'buildAll 不应再逐个调 agentTotals, 实际=' + totCalls);
});

test('交接指针一致性:重跑后长产出变短,旧交接全文被清(下游不读到过时内容)', () => {
  const { writeHandoffFile, handoffFilePath } = require('../runner');
  const dir = path.join(os.tmpdir(), 'orch-r212-handoff-stale-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  writeHandoffFile(dir, 'scaffold', 'A'.repeat(2000)); // 首次长产出 → 落盘
  assert.ok(handoffFilePath(dir, 'scaffold'), '长产出应有交接指针');
  assert.ok(fs.readFileSync(path.join(dir, '交接', 'scaffold.md'), 'utf8').includes('AAA'));
  writeHandoffFile(dir, 'scaffold', '短结果'); // 重跑产出变短 → 应删旧文件
  assert.equal(handoffFilePath(dir, 'scaffold'), null, '短产出后旧交接全文应被清,指针失效');
  assert.ok(!fs.existsSync(path.join(dir, '交接', 'scaffold.md')), '旧全文文件应被删');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('终验修复:FAIL 但 issues 空时用 summary 兜底,修复步 prompt 不为空', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-r212-emptyissue-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('做计算器');
  store.setTaskDir(id, dir);
  const plan = { task: '做计算器', steps: [
    { id: 'impl', agent: 'claude', prompt: '实现', deps: [] },
    { id: 'style', agent: 'claude', prompt: '样式', deps: ['impl'] },
  ] };
  const fixPrompts = [];
  const echo = { async run({ prompt }) {
    if (prompt.includes('任务终验')) return { output: '{"verdict":"FAIL","summary":"缺少核心运算逻辑SUMMARY_MARK","issues":[]}', success: true };
    if (prompt.includes('终验修复')) fixPrompts.push(prompt);
    return { output: 'ok', success: true };
  } };
  await runTask(id, { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan });
  for (let i = 0; i < 40 && !fixPrompts.length; i++) await wait(50);
  assert.equal(fixPrompts.length, 1, '空 issues 的 FAIL 仍应派修复');
  assert.ok(fixPrompts[0].includes('SUMMARY_MARK'), '修复步 prompt 应用 summary 兜底, 实际=' + fixPrompts[0].slice(0, 120));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('finalAcceptance 终验预算按执行周期:continue 后重新终验(全局累积不再永久拦)+ fix id 跨周期唯一', async () => {
  const { finalAcceptance } = require('../runner');
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-r215-fa-cycle-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('做一个页面');
  store.setTaskDir(id, dir);
  store.setPlan(id, { task: '做一个页面', steps: [
    { id: 'impl1', agent: 'claude', prompt: '实现', deps: [] },
    { id: 'impl2', agent: 'claude', prompt: '样式', deps: ['impl1'] },
  ] });
  store.setStep(id, 'impl1', 'claude', 'done', 'ok');
  store.setStep(id, 'impl2', 'claude', 'done', 'ok');
  store.setTaskStatus(id, 'done');
  // 模拟上一轮已终验 2 次(全局累积=2:旧逻辑会永久 n>=2 return,新产出不再终验)
  store.addEvent(id, 'final_review', { verdict: 'PASS' });
  store.addEvent(id, 'final_review', { verdict: 'FAIL', issues: [{ problem: 'x' }] });
  store.addEvent(id, 'continue', { text: '加新功能' }); // 新一轮执行周期开始
  const echo = { async run({ prompt }) {
    if (prompt.includes('任务终验')) return { output: '{"verdict":"FAIL","summary":"缺功能CYCLE_MARK","issues":[{"problem":"缺按钮"}]}', success: true };
    return { output: 'ok', success: true };
  } };
  await finalAcceptance(id, { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {} });
  for (let i = 0; i < 40 && store.getEvents(id).filter((e) => e.type === 'final_review').length < 3; i++) await wait(50);
  const reviews = store.getEvents(id).filter((e) => e.type === 'final_review');
  assert.ok(reviews.length >= 3, 'continue 后应重新终验(全局累积不再永久拦), 实际 review 数=' + reviews.length);
  const st = {}; (store.getTask(id).steps || []).forEach((s) => { st[s.step_id] = s.status; });
  assert.ok(st['final_fix_3'], 'fix 步 id 应全局唯一递增(final_fix_3),不与历史撞车, 实际步=' + Object.keys(st).join(','));
  assert.ok(!st['final_fix_1'], '不应复用会撞车的 final_fix_1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会议 @多员工串行发言:后者的发言上下文包含前者的发言(真讨论,非并发各说各的)', async () => {
  const { meetingUserMsg } = require('../runner');
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-r215-meet-serial-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'a', dept: 'eng', name: '张三', prompt: '架构', executor: 'claude' });
  store.addRole({ id: 'b', dept: 'eng', name: '李四', prompt: '前端', executor: 'claude' });
  const id = store.createTask('复杂任务');
  store.setTaskDir(id, dir);
  store.setPlan(id, { task: '复杂任务', steps: [{ id: 'impl', role: 'a', agent: 'claude', prompt: 'x', deps: [] }], meeting: { attendees: ['a', 'b'], meetIds: [], decideId: '', hostRole: 'a' } });
  store.createMeeting(id, ['a', 'b']);
  store.setTaskStatus(id, 'meeting');
  const speakPrompts = []; let speakN = 0;
  const echo = { async run({ prompt }) {
    if (prompt.includes('会议共识判定')) return { output: '{"status":"needs_user_decision","reason":"stop"}', success: true };
    speakPrompts.push(prompt);
    return { output: 'SPEAK_' + (speakN++), success: true };
  } };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {} };
  meetingUserMsg(id, deps, '@张三 @李四 请讨论方案', '我');
  for (let i = 0; i < 60 && speakPrompts.length < 2; i++) await wait(50);
  assert.equal(speakPrompts.length, 2, '两名被@员工都应发言, 实际=' + speakPrompts.length);
  assert.ok(speakPrompts[1].includes('SPEAK_0'), '第二位员工的发言上下文应包含第一位的发言(串行可见), 前情=' + (speakPrompts[1].match(/SPEAK_\d/g) || []).join(','));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runLoop 冒泡 needReplan:同步 loop 包装步状态为 blocked(画布/进度不停在旧态)', async () => {
  const { runPlan } = require('../engine');
  const statuses = [];
  const echo = { async run() { return { output: 'NEED_REPLAN: 架构与计划不符', success: true }; } };
  const ctx = {
    adapters: { claude: echo }, workspace: { make: async () => process.cwd() },
    replanMode: true, onStatus: (id, v) => statuses.push(id + ':' + v), onLog: () => {},
  };
  await runPlan({ steps: [{ id: 'qloop', type: 'loop', until: 'pass', deps: [], body: [{ id: 'impl', agent: 'claude', prompt: 'x', deps: [] }] }] }, ctx);
  assert.ok(statuses.includes('qloop:blocked'), 'loop 包装步应被标 blocked, 实际=' + statuses.join(','));
});

test('数据完整性:deleteTask 级联清所有含 task_id 表(含 apps)+ usage(ts) 索引存在', () => {
  const s = open(':memory:');
  const id = s.createTask('t');
  s.setStep(id, 's1', 'claude', 'done', 'x');
  s.addLog(id, 's1', 'line');
  s.addEvent(id, 'status', { step: 's1', v: 'done' });
  s.addUsage(id, 's1', 'claude', { input: 1, output: 1, cost: 0.01 });
  s.addTaskMsg(id, 'user', 'hi');
  s.createMeeting(id, ['a']); s.addMeetingMsg(id, { role: 'a', name: 'A', text: 'm' });
  s.savePlanVersion(id, { steps: [] }, 'r');
  s.addApp({ name: 'app', taskId: id, dir: '/x', entry: 'index.html' });
  s.deleteTask(id);
  // 所有含 task_id 的表都应清空该任务
  assert.equal(s.getTask(id), null);
  assert.equal(s.allSteps().filter((x) => x.task_id === id).length, 0, 'steps 未清');
  assert.equal(s.getLogs(id).length, 0, 'logs 未清');
  assert.equal(s.getEvents(id).length, 0, 'events 未清');
  assert.equal(s.taskUsage(id).cost, 0, 'usage 未清');
  assert.equal(s.getTaskMsgs(id).length, 0, 'task_messages 未清');
  assert.equal(s.getMeeting(id), undefined, 'meetings 未清');
  assert.equal(s.listMeetingMsgs(id).length, 0, 'meeting_msgs 未清');
  assert.equal(s.listPlanVersions(id).length, 0, 'plan_versions 未清');
  assert.equal(s.listApps().filter((a) => a.task_id === id).length, 0, 'apps 未清');
  // usage(ts) 索引应已建(usageToday 全表扫的性能护栏)
  const idx = s.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_ts'").get();
  assert.ok(idx, 'usage(ts) 索引应存在');
});

test('autoRetryCounts 批量:pendingRetry 不再逐 failed 任务 getEvents(N+1),计数一致', () => {
  const api = require('../api');
  const s = open(':memory:');
  s.seed();
  const a = s.createTask('t1'); s.setTaskStatus(a, 'failed'); s.addEvent(a, 'auto_retry', { inMin: 5 }); // 1 次待重试
  const b = s.createTask('t2'); s.setTaskStatus(b, 'failed'); s.addEvent(b, 'auto_retry', {}); s.addEvent(b, 'auto_retry', {}); // 2 次=用完,不算待重试
  const c = s.createTask('t3'); s.setTaskStatus(c, 'failed'); // 无 auto_retry,不算
  const m = s.autoRetryCounts();
  assert.equal(m.get(a), 1); assert.equal(m.get(b), 2); assert.equal(m.get(c) || 0, 0);
  // buildAll 主体不再逐 failed 任务 getEvents
  let getEventsCalls = 0; const orig = s.getEvents.bind(s); s.getEvents = (x) => { getEventsCalls++; return orig(x); };
  const built = api.buildAll(s, null);
  assert.equal(built.counts.pendingRetry, 1, '只有 t1(1次<2)算待重试, 实际=' + built.counts.pendingRetry);
  assert.ok(getEventsCalls < 3, 'pendingRetry 不应逐 failed 任务 getEvents, 实际=' + getEventsCalls);
});

test('blocked 步状态准确:relay sk=blocked 且耗时算出终值(不再显 ⏱ 运行中)', () => {
  const api = require('../api');
  const s = open(':memory:');
  s.seed();
  const id = s.createTask('t');
  s.setPlan(id, { task: 't', steps: [{ id: 's1', agent: 'claude', prompt: 'x', deps: [] }] });
  s.setStep(id, 's1', 'claude', 'blocked', '待你决策');
  const base = 1700000000000;
  s.db.prepare('INSERT INTO events(task_id,ts,type,data) VALUES(?,?,?,?)').run(id, new Date(base).toISOString(), 'status', JSON.stringify({ step: 's1', v: 'running' }));
  s.db.prepare('INSERT INTO events(task_id,ts,type,data) VALUES(?,?,?,?)').run(id, new Date(base + 30000).toISOString(), 'status', JSON.stringify({ step: 's1', v: 'blocked' }));
  const row = api.relay(s, id)[0];
  assert.equal(row.sk, 'blocked', 'blocked 步 sk 应为 blocked(不误映射成 queued), 实际=' + row.sk);
  assert.ok(row.dur && row.dur.includes('30s'), 'blocked 应算出耗时终值 30s, 实际=' + row.dur);
  assert.ok(!String(row.dur).startsWith('⏱'), 'blocked 是终点,不该再显"⏱ 运行中", 实际=' + row.dur);
});

test('thinPrompts 拆解质量:过短 prompt 检出(含 loop body),完整的不误报', () => {
  const planner = require('../planner');
  const thin = planner.thinPrompts({ steps: [
    { id: 'a', prompt: '实现页面' }, // 4字 → 检出
    { id: 'b', prompt: '实现登录页:创建 login.html,含表单校验与错误提示,自测通过' }, // 完整 → 不报
    { id: 'q', type: 'loop', body: [{ id: 'c', prompt: '写测试' }] }, // body 内短 → 检出
  ] });
  assert.equal(thin.length, 2, '应检出 2 个过短步, 实际=' + thin.length);
  assert.ok(thin[0].includes('a') && thin[1].includes('c'));
});

test('flowGaps 流程对齐:必选环节漏拆 warn(质量门标注),可选漏不报,会议步不算覆盖', () => {
  const planner = require('../planner');
  const flow = [
    { role: 'eng-dev', optional: false, gate: false },
    { role: 'eng-reviewer', optional: false, gate: true },
    { role: 'eng-ai', optional: true, gate: false },
  ];
  // 漏了必选质量门 eng-reviewer + 可选 eng-ai:只报前者且标质量门
  const gaps1 = planner.flowGaps({ steps: [{ id: 'impl', role: 'eng-dev', prompt: 'x' }] }, flow);
  assert.equal(gaps1.length, 1, '只报必选缺失, 实际=' + JSON.stringify(gaps1.map((g) => g.code)));
  assert.equal(gaps1[0].code, 'missing_flow_gate');
  // 全覆盖 → 无 warn
  const gaps2 = planner.flowGaps({ steps: [{ id: 'impl', role: 'eng-dev', prompt: 'x' }, { id: 'rev', role: 'eng-reviewer', prompt: 'y' }] }, flow);
  assert.equal(gaps2.length, 0);
  // reviewer 只出现在会议步(参会≠走质量门环节)→ 仍报缺
  const gaps3 = planner.flowGaps({ steps: [
    { id: 'meet_r', role: 'eng-reviewer', prompt: '发言' },
    { id: 'decide_plan', role: 'eng-dev', prompt: '综合' },
    { id: 'impl', role: 'eng-dev', prompt: 'x' },
  ], meeting: { meetIds: ['meet_r'], decideId: 'decide_plan' } }, flow);
  assert.equal(gaps3.length, 1, '会议步不算流程覆盖, 实际=' + gaps3.length);
  // 非部门任务(无 flow)→ 不诊断
  assert.equal(planner.flowGaps({ steps: [] }, []).length, 0);
});

test('保底编排:员工目录贫乏(专职角色全匹配不上)不产出空计划,退化单员工直做', async () => {
  const planner = require('../planner');
  // 只有一个通用工程师,fallbackComplexRolePlan 的 product/architect/frontend 等模式全匹配不上
  const claude = { async run() { return { output: '坏输出不是JSON', success: true }; } };
  const roles = [{ id: 'eng1', dept: 'eng', name: '工程师', description: '修复', prompt: '【身份】工程师', done_count: 0, empty_count: 0 }];
  const p = await planner.makePlan('开发一个完整的股票交易系统平台,含实时行情、下单、持仓、结算', { mode: 'llm', agents: ['claude'], roles, depts: [{ id: 'eng', name: '工程部' }], refine: false, templatesDir: __dirname, claude });
  assert.ok(p.steps.length >= 1, '绝不产出空计划, 实际步数=' + p.steps.length);
  assert.ok(p.steps.every((s) => s.agent), '每步都有可执行 agent');
});

test('员工模式:首版 prompt 过短 → 回喂重拆一次,采用补全后的二版', async () => {
  const planner = require('../planner');
  let calls = 0;
  const claude = { async run({ prompt }) {
    calls++;
    if (prompt.includes('过于简略')) return { output: '{"steps":[{"id":"fix","role":"eng1","prompt":"修复登录页按钮错误:定位 login.html 中按钮事件绑定问题并修复,自测点击生效","deps":[]}]}', success: true };
    return { output: '{"steps":[{"id":"fix","role":"eng1","prompt":"修复问题","deps":[]}]}', success: true }; // 4字,过短
  } };
  const roles = [{ id: 'eng1', dept: 'eng', name: '工程师', description: '修复', prompt: '【身份】工程师', done_count: 0, empty_count: 0 }];
  const p = await planner.makePlan('调整商品详情页的价格展示格式并同步更新单元测试用例', { mode: 'llm', agents: ['claude'], roles, depts: [{ id: 'eng', name: '工程部' }], refine: false, templatesDir: __dirname, claude });
  assert.equal(calls, 2, '过短 prompt 应触发一次回喂, 实际调用=' + calls);
  assert.ok(p.steps[0].prompt.includes('login.html'), '应采用补全后的二版, 实际=' + p.steps[0].prompt.slice(0, 30));
});

test('会议方案贯穿:endMeeting 后每个实现步 brief 都含《方案.md》铁律', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-r216-blueprint-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('复杂应用');
  store.setTaskDir(id, dir);
  store.setPlan(id, { task: '复杂应用', steps: [
    { id: 'meet_a', agent: 'claude', prompt: '开场', deps: [] },
    { id: 'decide_plan', agent: 'claude', prompt: '综合', deps: ['meet_a'] },
    { id: 'impl1', agent: 'claude', prompt: '实现模块一:创建 index.html 完成主功能', deps: ['decide_plan'] },
    { id: 'impl2', agent: 'claude', prompt: '实现模块二:创建 app.js 完成交互逻辑', deps: ['impl1'] },
  ], meeting: { attendees: [], meetIds: ['meet_a'], decideId: 'decide_plan' } });
  store.createMeeting(id, []);
  store.setTaskStatus(id, 'meeting');
  const implPrompts = [];
  const echo = { async run({ prompt }) { if (prompt.includes('实现模块')) implPrompts.push(prompt); return { output: 'ok', success: true }; } };
  const { endMeeting } = require('../runner');
  await endMeeting(id, { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {} }, { status: 'user_forced' });
  assert.equal(implPrompts.length, 2, '两个实现步都应执行');
  implPrompts.forEach((p, i) => assert.ok(p.includes('方案铁律') && p.includes('方案.md'), '实现步' + (i + 1) + ' 的 brief 应含方案铁律(会议结论不随交接链稀释)'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recoverZombies:meeting 态任务重启后收到续会提示(不误标失败)', () => {
  const boot = require('../bootstrap');
  const s = open(':memory:');
  const id = s.createTask('会议中任务');
  s.createMeeting(id, ['a']);
  s.setTaskStatus(id, 'meeting');
  boot.recoverZombies(s);
  assert.equal(s.getTask(id).status, 'meeting', '会议数据没坏,不应标失败');
  const msgs = s.getTaskMsgs(id).map((m) => m.text).join('\n');
  assert.ok(msgs.includes('会议仍开着'), '应有续会提示, 实际=' + msgs.slice(0, 80));
});

test('stripMeeting:剥离会议步 + 清对会议结论的依赖 + 删 meeting 元数据', () => {
  const { stripMeeting } = require('../runner');
  const p = stripMeeting({
    steps: [
      { id: 'meet_a', deps: [] }, { id: 'meet_b', deps: [] },
      { id: 'decide_plan', deps: ['meet_a', 'meet_b'] },
      { id: 'impl1', deps: ['decide_plan'] },
      { id: 'impl2', deps: ['impl1'] },
    ],
    meeting: { meetIds: ['meet_a', 'meet_b'], decideId: 'decide_plan' },
  });
  assert.deepEqual(p.steps.map((s) => s.id), ['impl1', 'impl2'], '只留实现步');
  assert.deepEqual(p.steps[0].deps, [], 'impl1 对 decide_plan 的依赖应被清');
  assert.deepEqual(p.steps[1].deps, ['impl1'], '实现步之间链式依赖保留');
  assert.ok(!p.meeting, 'meeting 元数据应删除');
});

test('continueTask:复杂续跑不把会议步当实现步执行(画布不混入 meet_/decide_plan)', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-r215-cont-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('原任务');
  store.setTaskDir(id, dir);
  store.setPlan(id, { task: '原任务', steps: [{ id: 'orig', agent: 'claude', prompt: 'x', deps: [] }] });
  store.setStep(id, 'orig', 'claude', 'done', 'ok');
  store.setTaskStatus(id, 'done');
  const ran = [];
  const echo = { async run({ prompt }) { ran.push(prompt); return { output: 'ok', success: true }; } };
  // makePlan 模拟 prependMeeting 后的复杂计划(带会议步 + meeting 元数据)
  const makePlan = async () => ({
    task: '新需求',
    steps: [
      { id: 'meet_a', role: 'r', agent: 'claude', prompt: '方案会议·你的视角 写要点', deps: [] },
      { id: 'decide_plan', role: 'r', agent: 'claude', prompt: '方案综合', deps: ['meet_a'] },
      { id: 'build', role: 'r', agent: 'claude', prompt: '真正实现功能', deps: ['decide_plan'] },
    ],
    meeting: { meetIds: ['meet_a'], decideId: 'decide_plan', attendees: ['r'] },
  });
  const { continueTask } = require('../runner');
  await continueTask(id, { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan }, '加个复杂功能');
  const plan = JSON.parse(store.getTask(id).plan);
  const newIds = plan.steps.map((s) => s.id);
  assert.ok(!newIds.some((x) => /meet_a|decide_plan/.test(x)), '续跑计划不应含会议步, 实际=' + newIds.join(','));
  assert.ok(newIds.some((x) => /build/.test(x)), '实现步应保留');
  assert.ok(!ran.some((p) => /方案会议·你的视角|方案综合/.test(p)), '会议步不应被当实现步执行');
  assert.ok(ran.some((p) => /真正实现功能/.test(p)), '实现步应执行');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('trimLogs:终态裁剪只留最近 N 行', () => {
  const s = open(':memory:');
  const id = s.createTask('t');
  for (let i = 1; i <= 300; i++) s.addLog(id, 's1', 'line' + i);
  s.trimLogs(id, 100);
  const rows = s.getLogs(id);
  assert.equal(rows.length, 100);
  assert.equal(rows[0].line, 'line201', '应保留最新的 100 行');
  assert.equal(rows[99].line, 'line300');
});

test('store:API Agent 持久化 base_url/api_key,编辑留空保留旧 Key', () => {
  const s = open(':memory:');
  s.addAgent({ id: 'ds', name: 'DeepSeek', kind: 'llm', base_url: 'https://a/v1', api_key: 'k1', model: 'deepseek-chat' });
  s.updateAgent('ds', { name: 'DeepSeek', kind: 'llm', base_url: 'https://b/v1', api_key: '', model: 'deepseek-chat' });
  const row = s.listAgents().find((a) => a.id === 'ds');
  assert.equal(row.base_url, 'https://b/v1', 'base_url 应更新');
  assert.equal(row.api_key, 'k1', '留空提交应保留旧 Key');
  s.updateAgent('ds', { name: 'DeepSeek', kind: 'llm', base_url: 'https://b/v1', api_key: 'k2', model: 'deepseek-chat' });
  assert.equal(s.listAgents().find((a) => a.id === 'ds').api_key, 'k2', '填新值应覆盖');
});
