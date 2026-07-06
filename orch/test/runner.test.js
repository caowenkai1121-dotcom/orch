const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { open } = require('../store');
const { runTask, runApproved, countRecentFiles, searchTaskKnowledge, searchTaskKnowledgeHits } = require('../runner');

test('countRecentFiles 按mtime数本步产出,排除task_plan/findings', async () => {
  const dir = path.join(os.tmpdir(), 'orch-cnt-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old.txt'), 'x');
  await new Promise((r) => setTimeout(r, 25));
  const since = Date.now();
  await new Promise((r) => setTimeout(r, 25));
  fs.writeFileSync(path.join(dir, 'new.html'), 'y');     // 本步窗口内产出
  fs.writeFileSync(path.join(dir, 'task_plan.md'), 'z'); // 引擎共享文件 → 排除
  fs.writeFileSync(path.join(dir, 'findings.md'), 'z');  // 团队共享文件 → 排除
  fs.writeFileSync(path.join(dir, '会议纪要.md'), 'z');  // 会议产物 → 排除
  assert.equal(countRecentFiles(dir, since), 1);         // 只数 new.html(old.txt 早于 since;共享文件排除)
  assert.equal(countRecentFiles(dir, 0), 2);             // since=0 → old+new,仍不含共享文件
  fs.rmSync(dir, { recursive: true, force: true });
});

test('知识检索:跳过未命中文件继续扫描后续Markdown', () => {
  const dir = path.join(os.tmpdir(), 'orch-knowledge-scan-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '00-无关.md'), '# 无关\n\n这里没有目标词。', 'utf8');
  fs.writeFileSync(path.join(dir, '99-项目知识.md'), '# 项目知识\n\nSQLite 写入必须带失败回滚说明。', 'utf8');
  const out = searchTaskKnowledge(dir, 'SQLite 回滚', 3);
  assert.match(out, /99-项目知识\.md/);
  assert.match(out, /SQLite/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('知识检索:结构化返回命中文件与分数', () => {
  const dir = path.join(os.tmpdir(), 'orch-knowledge-hits-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '99-项目知识.md'), '# 项目知识\n\nSQLite 写入必须带失败回滚说明。', 'utf8');
  const hits = searchTaskKnowledgeHits(dir, 'SQLite 回滚', 3);
  assert.equal(hits[0].rel, '99-项目知识.md');
  assert.ok(hits[0].score > 0);
  assert.match(hits[0].snip, /SQLite/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runTask 落库且 log 事件带 agent', async () => {
  const store = open(':memory:');
  const id = store.createTask('随便');
  const echo = { async run({ prompt, onLine }) { onLine(prompt); return { output: prompt, success: true }; } };
  const evs = [];
  await runTask(id, {
    store, adapters: { claude: echo, codex: echo },
    workspace: { make: () => '.', merge: () => {} },
    onEvent: (e) => evs.push(e),
    makePlan: async () => ({ task: 'x', steps: [{ id: 'dev', agent: 'claude', prompt: 'p', deps: [] }] }),
  });
  assert.equal(store.getTask(id).status, 'done');
const log = evs.find((e) => e.type === 'log');
  assert.equal(log.agent, 'claude');
});

test('runTask 记录规划耗时、路线和LLM调用次数', async () => {
  const store = open(':memory:');
  const id = store.createTask('修复按钮文案');
  const echo = { async run() { return { output: 'ok', success: true }; } };
  await runTask(id, {
    store, adapters: { claude: echo },
    workspace: { make: () => '.', merge: () => {} },
    onEvent: () => {},
    makePlan: async () => ({ task: 'x', planning_stats: { route: 'fast-simple', llm_calls: 0 }, steps: [{ id: 'fix_frontend', agent: 'claude', prompt: 'p', deps: [] }] }),
  });
  const ev = store.getEvents(id).find((e) => e.type === 'plan');
  const data = JSON.parse(ev.data);
  assert.equal(data.steps, 1);
  assert.equal(data.route, 'fast-simple');
  assert.equal(data.llmCalls, 0);
  assert.ok(data.ms >= 0);
});

test('runTask 遇到规划模式歧义时暂停等待用户选择,不执行步骤', async () => {
  const store = open(':memory:');
  const id = store.createTask('做一个网站');
  let ran = false;
  const bad = { async run() { ran = true; return { output: '不应执行', success: true }; } };
  await runTask(id, {
    store, adapters: { claude: bad },
    workspace: { make: () => '.', merge: () => {} },
    onEvent: () => {},
    makePlan: async () => ({
      task: '做一个网站',
      steps: [],
      routing: { lane: 'needs_choice', reason: '范围不明确', options: [{ id: 'A', title: '快速实现' }, { id: 'B', title: '标准编排' }, { id: 'C', title: '深度会议' }] },
      planning_stats: { route: 'awaiting-route-choice', llm_calls: 0 },
    }),
  });
  const t = store.getTask(id);
  assert.equal(t.status, 'awaiting_input');
  assert.equal(t.blocked_step, '__route_choice');
  assert.match(t.question, /A/);
  assert.match(t.question, /深度会议/);
  assert.equal(t.steps.length, 0);
  assert.equal(ran, false);
});

test('执行步骤:注入任务目录Markdown知识检索片段', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-run-knowledge-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '项目知识.md'), '# 项目知识\n\nSQLite 缓存必须记录回滚策略 UNIQUE_EXEC_KNOWLEDGE。\n', 'utf8');
  const id = store.createTask('实现 SQLite 缓存');
  store.setTaskDir(id, dir);
  let seen = '';
  const echo = { async run({ prompt }) { seen = prompt; return { output: 'ok', success: true }; } };
  await runTask(id, {
    store, adapters: { claude: echo },
    workspace: { make: () => dir, merge: () => {} },
    onEvent: () => {},
    makePlan: async () => ({ task: 'x', steps: [{ id: 'impl_cache', agent: 'claude', prompt: '实现缓存模块', deps: [], expected_outcome: '缓存模块真实落盘' }] }),
  });
  assert.match(seen, /【知识检索】/);
  assert.match(seen, /项目知识\.md/);
  assert.match(seen, /UNIQUE_EXEC_KNOWLEDGE/);
  const ev = store.getEvents(id).find((e) => e.type === 'knowledge');
  assert.ok(ev, '应记录知识引用事件');
  const data = JSON.parse(ev.data);
  assert.equal(data.step, 'impl_cache');
  assert.match(data.hits[0].file, /项目知识\.md/);
  const md = fs.readFileSync(path.join(dir, 'task_plan.md'), 'utf8');
  assert.match(md, /验收:/);
  assert.match(md, /知识引用:/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('执行步骤:按 Open Tag 式上下文 scope 限制知识检索', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-run-context-scope-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', '命中.md'), '# 命中\n\nUNIQUE_ALLOWED_SCOPE SQLite 约定。\n', 'utf8');
  fs.writeFileSync(path.join(dir, '未授权.md'), '# 未授权\n\nUNIQUE_DENIED_SCOPE SQLite 约定。\n', 'utf8');
  const id = store.createTask('实现 SQLite 缓存');
  store.setTaskDir(id, dir);
  store.addEvent(id, 'context', { scopes: ['task://docs'], source: 'test' });
  let seen = '';
  const echo = { async run({ prompt }) { seen = prompt; return { output: 'ok', success: true }; } };
  await runTask(id, {
    store, adapters: { claude: echo },
    workspace: { make: () => dir, merge: () => {} },
    onEvent: () => {},
    makePlan: async () => ({ task: 'x', steps: [{ id: 'impl_cache', agent: 'claude', prompt: '实现缓存模块', deps: [], expected_outcome: '缓存模块真实落盘' }] }),
  });
  assert.match(seen, /UNIQUE_ALLOWED_SCOPE/);
  assert.doesNotMatch(seen, /UNIQUE_DENIED_SCOPE/);
  const data = JSON.parse(store.getEvents(id).find((e) => e.type === 'knowledge').data);
  assert.equal(data.scopes[0], 'task://docs');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#12 动态重规划:diverge 步发 NEED_REPLAN → 快照旧计划、就剩余重拆、续跑至完成', async () => {
  const store = open(':memory:');
  const id = store.createTask('建站', 'proj', 'me', { replan: true });
  let calls = 0;
  const makePlan = async () => {
    calls++;
    return calls === 1
      ? { task: 'x', steps: [{ id: 'a', agent: 'claude', prompt: 'DIVERGE', deps: [] }] }   // 初拆:会偏离
      : { task: 'x', steps: [{ id: 'b', agent: 'claude', prompt: 'NORMAL', deps: [] }] };     // 重拆:剩余工作
  };
  const claude = { async run({ prompt }) {
    if (prompt.includes('DIVERGE')) return { output: '试了发现不行\nNEED_REPLAN: 架构需重来', success: true };
    return { output: 'ok done', success: true };
  } };
  await runTask(id, { store, adapters: { claude }, workspace: { make: () => '.' }, onEvent: () => {}, makePlan });
  assert.equal(store.getTask(id).status, 'done');                                   // 重规划后续跑成功
  assert.equal(calls, 2);                                                           // makePlan 调2次(初拆+重拆)
  assert.equal(store.listPlanVersions(id).length, 1);                               // 旧计划快照1份(#13)
  const plan = JSON.parse(store.getTask(id).plan);
  assert.ok(plan.steps.some((s) => s.id === 'r1_b'));                               // 新步前缀 r1_,不与旧步冲突
  assert.equal(store.getEvents(id).filter((e) => e.type === 'replan').length, 1);   // replan 事件记录
});

test('#12 replan 关闭(默认)时 NEED_REPLAN 不触发重规划,任务照常完成', async () => {
  const store = open(':memory:');
  const id = store.createTask('普通任务'); // 无 replan 标志
  let calls = 0;
  const makePlan = async () => { calls++; return { task: 'x', steps: [{ id: 'a', agent: 'claude', prompt: 'p', deps: [] }] }; };
  const claude = { async run() { return { output: 'NEED_REPLAN: 别触发', success: true }; } };
  await runTask(id, { store, adapters: { claude }, workspace: { make: () => '.' }, onEvent: () => {}, makePlan });
  assert.equal(store.getTask(id).status, 'done'); // 未开启 → 当普通输出,任务完成
  assert.equal(calls, 1);                         // makePlan 只调1次(无重拆)
  assert.equal(store.listPlanVersions(id).length, 0);
});

test('审查修复HIGH-3:runApproved 播种已完成步,批准后不重跑(approve+replan 场景)', async () => {
  const store = open(':memory:');
  const id = store.createTask('t');
  store.setStep(id, 'a', 'claude', 'done', 'A产出'); // a 已完成(模拟 replan 保留的 keep 步)
  const ran = [];
  const claude = { async run({ prompt }) { ran.push(prompt); return { output: 'ok', success: true }; } };
  const plan = { task: 't', steps: [{ id: 'a', agent: 'claude', prompt: 'A实现', deps: [] }, { id: 'b', agent: 'claude', prompt: 'B实现', deps: ['a'] }] };
  await runApproved(id, { store, adapters: { claude }, workspace: { make: () => '.' }, onEvent: () => {} }, plan);
  assert.equal(ran.length, 1);          // 只跑 b(a 已 seed,不重跑)
  assert.match(ran[0], /B实现/);        // 跑的是 b
  assert.equal(store.getTask(id).status, 'done');
});

test('审查修复HIGH-1:execute 不覆盖已存在的非 orch CLAUDE.md,AGENTS.md 缺则创建', async () => {
  const store = open(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ctx-'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# 用户自己的项目规范\n重要内容勿删', 'utf8'); // 用户/项目已有文件
  const id = store.createTask('做事'); store.setTaskDir(id, dir);
  const echo = { async run() { return { output: 'ok', success: true }; } };
  await runTask(id, { store, adapters: { claude: echo }, workspace: { make: () => dir }, onEvent: () => {}, makePlan: async () => ({ task: 'x', steps: [{ id: 'a', agent: 'claude', prompt: 'p', deps: [] }] }) });
  assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /用户自己的项目规范/); // 未被 orch 模板覆盖
  assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').startsWith('# 项目上下文(orch 自动注入')); // 不存在的 → orch 创建
  fs.rmSync(dir, { recursive: true, force: true });
});
test('编排决策:规划完成后写事件并沉淀到task_plan', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-orchestration-decision-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('开发股票交易网站');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'engineering', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'backend', dept: 'engineering', name: '后端架构师', prompt: 'p', executor: 'claude' });
  const plan = {
    task: '开发股票交易网站',
    process: { type: 'risk_review', reason: '交易任务需要风险复核', manager_role: 'backend', debate_rounds: 1, risk_review: true },
    validation: { ok: true, errors: ['缺少安全复核'], warnings: ['复杂计划角色较少'], repaired: false },
    steps: [{ id: 'build', role: 'backend', agent: 'claude', prompt: '实现', deps: [], expected_outcome: '完成实现' }],
  };
  const echo = { async run() { return { output: 'done', success: true }; } };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };

  await runTask(id, deps);

  const event = store.getEvents(id).find((e) => e.type === 'orchestration_decision');
  assert.ok(event, '应写入编排决策事件');
  const data = JSON.parse(event.data);
  assert.equal(data.process_type, 'risk_review');
  assert.match(data.reason, /风险复核/);
  assert.ok(Array.isArray(data.validation_warnings));
  assert.ok(data.validation_warnings.includes('复杂计划角色较少'));
  assert.ok(Array.isArray(data.validation_errors));
  assert.ok(data.validation_errors.includes('缺少安全复核'));
  assert.equal(data.step_count, 1);
  assert.ok(Array.isArray(data.skills));
  assert.ok(data.skills.includes('交易风控'));
  assert.match(data.trace_summary, /风险复核/);
  const text = fs.readFileSync(path.join(dir, 'task_plan.md'), 'utf8');
  assert.match(text, /## 编排决策/);
  assert.match(text, /risk_review/);
  assert.match(text, /交易任务需要风险复核/);
  assert.match(text, /复核错误/);
  assert.match(text, /缺少安全复核/);
  assert.match(text, /复核提醒[:：].*复杂计划角色较少/);

  fs.rmSync(dir, { recursive: true, force: true });
});
