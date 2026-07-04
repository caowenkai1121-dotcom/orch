const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../store');
const { runTask, runApproved } = require('../runner');

test('retryFailed 对无plan的失败任务不崩(JSON.parse(null) 兜底)', async () => {
  const runner = require('../runner');
  const store = open(':memory:'); store.seed();
  const id = store.createTask('无plan失败任务', '默认项目', 'admin', {}); // 从不规划(如日预算拦截)
  store.setStep(id, 'blocked', '', 'failed', '预算拦截'); store.setTaskStatus(id, 'failed');
  await assert.doesNotReject(() => runner.retryFailed(id, { store, adapters: {}, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {} }));
});

test('无plan任务重试不假判done(空计划 noWork 守卫)', async () => {
  const runner = require('../runner');
  const store = open(':memory:'); store.seed();
  const id = store.createTask('无plan失败任务', '默认项目', 'admin', {});
  store.setStep(id, 'blocked', '', 'failed', '预算拦截'); store.setTaskStatus(id, 'failed');
  await runner.retryFailed(id, { store, adapters: {}, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {} });
  const t = store.getTask(id);
  assert.equal(t.status, 'failed');           // 空计划不被 [].every() 假判 done
  assert.ok(store.getTaskMsgs(id).some((m) => /从未成功规划/.test(m.text)));
});

test('全局日成本上限也覆盖执行路径(retry),消息为全局', async () => {
  const store = open(':memory:'); store.seed();
  const id = store.createTask('活', '默认项目', 'admin', {});
  store.setPlan(id, { steps: [{ id: 's1', agent: 'echo', prompt: 'p', deps: [] }] });
  store.setStep(id, 's1', 'echo', 'failed', 'x'); store.setTaskStatus(id, 'failed');
  store.addUsage(id, 'prev', 'claude', { input: 0, output: 0, cost: 5 }); // 今日已花 $5
  process.env.ORCH_DAILY_BUDGET = '1';
  let ran = 0;
  const echo = { async run() { ran++; return { output: '', success: true }; } };
  await require('../runner').retryFailed(id, { store, adapters: { echo }, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {} });
  delete process.env.ORCH_DAILY_BUDGET;
  assert.equal(ran, 0);                                   // 超全局上限,步骤不执行(非仅新建task才拦)
  assert.equal(store.getTask(id).status, 'paused');
  assert.ok(store.getTaskMsgs(id).some((m) => /全局日成本上限/.test(m.text)));
});

test('复盘:失败复盘过后升级到done允许补一次(学修复经验)', async () => {
  const store = open(':memory:'); store.seed();
  const rid = store.listRoles().find((r) => r.dept !== '__system').id;
  const id = store.createTask('活', '默认项目', 'admin', {});
  store.setPlan(id, { steps: [{ id: 's1', role: rid, agent: 'claude', prompt: 'p', deps: [] }] });
  store.setStep(id, 's1', 'claude', 'done', 'ok');
  let calls = 0;
  const claude = { async run() { calls++; return { output: '{"employees":{}}' }; } };
  const deps = { store, adapters: { claude } };
  store.setTaskStatus(id, 'failed');
  await require('../runner').harvestExperience(id, deps); assert.equal(calls, 1); // 失败态复盘
  await require('../runner').harvestExperience(id, deps); assert.equal(calls, 1); // 失败已复盘,不重复
  store.setTaskStatus(id, 'done');
  await require('../runner').harvestExperience(id, deps); assert.equal(calls, 2); // 升级done补一次
  await require('../runner').harvestExperience(id, deps); assert.equal(calls, 2); // done已复盘,不重复
});

test('复盘注入员工已有经验(避免生成重复)', async () => {
  const store = open(':memory:'); store.seed();
  const rid = store.listRoles().find((r) => r.dept !== '__system').id;
  store.appendRoleMemo(rid, '旧经验先建mock数据');
  const id = store.createTask('活', '默认项目', 'admin', {});
  store.setPlan(id, { steps: [{ id: 's1', role: rid, agent: 'claude', prompt: 'p', deps: [] }] });
  store.setStep(id, 's1', 'claude', 'done', '做完了'); store.setTaskStatus(id, 'done');
  let seen = '';
  const claude = { async run({ prompt }) { seen = prompt; return { output: '{"employees":{}}' }; } };
  await require('../runner').harvestExperience(id, { store, adapters: { claude } });
  assert.match(seen, /旧经验先建mock数据/);   // 已有经验被注入复盘 prompt
  assert.match(seen, /避免与之语义重复/);       // 去重指令在
});

test('审批模式:出 plan 后暂停不执行', async () => {
  const store = open(':memory:'); store.seed();
  const id = store.createTask('x', 'p', 'o', { approve: 1 });
  let ran = 0;
  const a = { async run() { ran++; return { output: '', success: true }; } };
  await runTask(id, { store, adapters: { claude: a }, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {}, makePlan: async () => ({ steps: [{ id: 'a', agent: 'claude', prompt: 'p', deps: [] }] }) });
  assert.equal(ran, 0);
  assert.equal(store.getTask(id).status, 'awaiting');
});

test('批准后用给定 plan 执行', async () => {
  const store = open(':memory:'); store.seed();
  const id = store.createTask('x', 'p', 'o', { approve: 1 });
  let ran = 0;
  const a = { async run() { ran++; return { output: 'ok', success: true }; } };
  const deps = { store, adapters: { claude: a }, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {} };
  await runApproved(id, deps, { steps: [{ id: 'a', agent: 'claude', prompt: 'p', deps: [] }] });
  assert.equal(ran, 1);
  assert.equal(store.getTask(id).status, 'done');
});

test('重试失败步骤:已完成不重跑,只跑失败的', async () => {
  const { open } = require('../store');
  const { retryFailed } = require('../runner');
  const store = open(':memory:'); store.seed();
  const id = store.createTask('活', '默认项目', 'admin', {});
  store.setPlan(id, { steps: [
    { id: 'a', agent: 'ok', prompt: 'p', deps: [] },
    { id: 'b', agent: 'ok', prompt: 'p', deps: ['a'] },
  ] });
  store.setStep(id, 'a', 'ok', 'done', '产出A');   // a 已完成
  store.setStep(id, 'b', 'ok', 'failed', null);    // b 失败(如限额)
  store.setTaskStatus(id, 'failed');
  const ran = [];
  const ok = { async run({ prompt }) { ran.push(prompt.includes('产出A')); return { output: 'B完成', success: true }; } };
  await retryFailed(id, { store, adapters: { ok }, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {} });
  assert.equal(ran.length, 1);                      // 只重跑 b
  assert.equal(ran[0], true);                       // b 收到 a 的交接产出
  assert.equal(store.getTask(id).status, 'done');   // 任务转成功
});

test('服务重启:running 僵尸任务标记失败可重试', () => {
  const { recoverZombies } = require('../bootstrap');
  const store = require('../store').open(':memory:'); store.seed();
  const id = store.createTask('活', '默认项目', 'admin', {});
  store.setTaskStatus(id, 'running');
  store.setStep(id, 'a', 'claude', 'done', 'ok');
  store.setStep(id, 'b', 'claude', 'running', null);
  recoverZombies(store);
  const t = store.getTask(id);
  assert.equal(t.status, 'failed');                                   // 任务可重试
  assert.equal(t.steps.find((s) => s.step_id === 'a').status, 'done');   // 已完成保留
  assert.equal(t.steps.find((s) => s.step_id === 'b').status, 'failed'); // 运行中转失败
});

test('限额自动重试:排定事件+提示日志,非限额失败不排', () => {
  const { open } = require('../store');
  const runner = require('../runner');
  // 通过 execute 私有入口不可达,直接测 scheduleAutoRetry 导出? 未导出——用 retryFailed 场景侧测:
  const store = open(':memory:'); store.seed();
  const id = store.createTask('活', '默认项目', 'admin', {});
  store.setPlan(id, { steps: [{ id: 'a', agent: 'x', prompt: 'p', deps: [] }] });
  store.setStep(id, 'a', 'x', 'failed', "You've hit your session limit · resets 1:50pm");
  store.setTaskStatus(id, 'failed');
  // 模拟 execute 尾部行为:直接 require 内部函数不可,改由 module 导出验证
  assert.ok(typeof runner.scheduleAutoRetry === 'function');
  runner.scheduleAutoRetry(id, { store, adapters: {}, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {} });
  const evs = store.getEvents(id).filter((e) => e.type === 'auto_retry');
  assert.equal(evs.length, 1);
  assert.ok(store.getTaskMsgs(id).some((m) => m.who === 'system' && /自动重试/.test(m.text))); // 任务对话可见提示
  // 第3次不再排
  store.addEvent(id, 'auto_retry', {}); // 手动补到2
  runner.scheduleAutoRetry(id, { store, adapters: {}, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {} });
  assert.equal(store.getEvents(id).filter((e) => e.type === 'auto_retry').length, 2); // 不增
  // 非限额失败不排
  const id2 = store.createTask('活2', '默认项目', 'admin', {});
  store.setStep(id2, 'a', 'x', 'failed', '普通错误');
  store.setTaskStatus(id2, 'failed');
  runner.scheduleAutoRetry(id2, { store, adapters: {}, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {} });
  assert.equal(store.getEvents(id2).filter((e) => e.type === 'auto_retry').length, 0);
});

test('经验沉淀:复盘写入员工与总调度memo,每任务一次', async () => {
  const { open } = require('../store');
  const { harvestExperience } = require('../runner');
  const store = open(':memory:'); store.seed();
  const id = store.createTask('活', '默认项目', 'admin', {});
  store.setPlan(id, { steps: [{ id: 'a', agent: 'claude', role: 'engineering-frontend-developer', prompt: 'p', deps: [] }] });
  store.setStep(id, 'a', 'claude', 'done', '页面完成,踩坑:file://被封');
  store.setTaskStatus(id, 'done');
  const fakeClaude = { async run() { return { output: '{"employees":{"engineering-frontend-developer":"file://被封时起本地http服务"},"chief":"单步任务无需质量门"}', success: true }; } };
  await harvestExperience(id, { store, adapters: { claude: fakeClaude } });
  assert.match(store.getRole('engineering-frontend-developer').memo, /http服务/);
  assert.match(store.getRole('chief-orchestrator').memo, /质量门/);
  // 再跑一次:不重复复盘
  await harvestExperience(id, { store, adapters: { claude: { async run() { throw new Error('不应再调'); } } } });
});

test('文件化规划:task_plan.md 渲染阶段/摘要/错误表,findings.md 初始化', () => {
  const { open } = require('../store');
  const { writePlanFile } = require('../runner');
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  const store = open(':memory:'); store.seed();
  const id = store.createTask('做个页面', '默认项目', 'admin', {});
  store.setTaskDir(id, dir);
  store.setPlan(id, { steps: [
    { id: 'build', agent: 'claude', role: 'engineering-frontend-developer', prompt: 'p', deps: [] },
    { id: 'check', agent: 'codex', role: 'testing-api-tester', prompt: 'p', deps: ['build'] },
  ] });
  store.setStep(id, 'build', 'claude', 'done', '页面完成,含交接备忘');
  store.setStep(id, 'check', 'codex', 'failed', '端口被占用启动失败');
  writePlanFile(id, store, dir);
  const plan = fs.readFileSync(path.join(dir, 'task_plan.md'), 'utf8');
  assert.match(plan, /做个页面/);                 // 目标
  assert.match(plan, /build — engineering-frontend-developer/);
  assert.match(plan, /✓ 完成/);                   // 状态
  assert.match(plan, /页面完成,含交接备忘/);       // 产出摘要
  assert.match(plan, /错误记录/);                  // 错误表
  assert.match(plan, /端口被占用/);
  assert.ok(fs.existsSync(path.join(dir, 'findings.md'))); // findings 初始化
  const f1 = fs.readFileSync(path.join(dir, 'findings.md'), 'utf8');
  fs.writeFileSync(path.join(dir, 'findings.md'), f1 + '- 员工写的发现\n');
  writePlanFile(id, store, dir); // 再渲染:findings 不被覆盖
  assert.match(fs.readFileSync(path.join(dir, 'findings.md'), 'utf8'), /员工写的发现/);
});

test('产出版本化:独立目录init+每步commit;祖先仓未忽略则拒建', () => {
  const { ensureOutputGit, commitStep } = require('../runner');
  const fs = require('fs'), os = require('os'), path = require('path');
  const { execSync } = require('child_process');
  // 独立目录
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
  assert.equal(ensureOutputGit(dir), true);
  commitStep(dir, '开工基线');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v2');
  commitStep(dir, '步骤 build 完成');
  const log = execSync('git log --format=%s', { cwd: dir }).toString().trim().split('\n');
  assert.deepEqual(log, ['步骤 build 完成', '开工基线']);
  const diff = execSync('git show --stat HEAD', { cwd: dir }).toString();
  assert.match(diff, /a\.txt/);
  // 祖先仓内且未被忽略 → 拒建(不污染用户仓)
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vg2-'));
  execSync('git init -q', { cwd: repo });
  const sub = path.join(repo, 'sub'); fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'b.txt'), 'x');
  assert.equal(ensureOutputGit(sub), false);
  assert.ok(!fs.existsSync(path.join(sub, '.git')));
});

test('会话化:中途指令注入下一步骤,暂停停新步,跳过直接标完成', async () => {
  const { runPlan } = require('../engine');
  // 注入
  let seen = '';
  const notes = ['改用深色主题'];
  const a = { async run({ prompt }) { seen = prompt; return { output: 'ok', success: true }; } };
  await runPlan({ steps: [{ id: 's1', agent: 'x', prompt: 'p', deps: [] }] },
    { adapters: { x: a }, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {},
      takeNotes: () => notes.splice(0).join('\n') });
  assert.match(seen, /用户最新指令/);
  assert.match(seen, /深色主题/);
  // 暂停:第一波后不起第二波
  let ran = [];
  const b = { async run() { ran.push(1); return { output: '', success: true }; } };
  let paused = false;
  await runPlan({ steps: [
    { id: 'w1', agent: 'x', prompt: 'p', deps: [] },
    { id: 'w2', agent: 'x', prompt: 'p', deps: ['w1'] },
  ] }, { adapters: { x: { async run() { ran.push(1); paused = true; return { output: '', success: true }; } } }, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {}, isPaused: () => paused });
  assert.equal(ran.length, 1); // w2 没跑
  // 跳过
  const done = await runPlan({ steps: [{ id: 'sk', agent: 'x', prompt: 'p', deps: [] }] },
    { adapters: { x: { async run() { throw new Error('不应执行'); } } }, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {}, skip: new Set(['sk']) });
  assert.equal(done.sk.success, true);
  assert.match(done.sk.output, /跳过/);
});

test('会话化:rerunStep 只重跑指定步,其余保留', async () => {
  const { open } = require('../store');
  const { rerunStep } = require('../runner');
  const store = open(':memory:'); store.seed();
  const id = store.createTask('活', '默认项目', 'admin', {});
  store.setPlan(id, { steps: [
    { id: 'a', agent: 'ok', prompt: 'p', deps: [] },
    { id: 'b', agent: 'ok', prompt: 'p', deps: ['a'] },
  ] });
  store.setStep(id, 'a', 'ok', 'done', 'A产出');
  store.setStep(id, 'b', 'ok', 'done', 'B产出v1');
  store.setTaskStatus(id, 'done');
  const ran = [];
  const ok = { async run({ prompt }) { ran.push(prompt.includes('A产出')); return { output: 'B产出v2', success: true }; } };
  await rerunStep(id, { store, adapters: { ok }, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {} }, 'b');
  assert.equal(ran.length, 1);                       // 只重跑 b
  assert.equal(ran[0], true);                        // b 仍收到 a 的交接
  assert.match(store.getTask(id).steps.find((s) => s.step_id === 'b').output, /v2/);
});

test('失败自省:重跑注入上次失败原因', async () => {
  const { open } = require('../store');
  const { retryFailed } = require('../runner');
  const store = open(':memory:'); store.seed();
  const id = store.createTask('活', '默认项目', 'admin', {});
  store.setPlan(id, { steps: [{ id: 'a', agent: 'x', prompt: 'p', deps: [] }] });
  store.setStep(id, 'a', 'x', 'failed', '编译错误:缺少分号在第42行');
  store.setTaskStatus(id, 'failed');
  let seen = '';
  const x = { async run({ prompt }) { seen = prompt; return { output: '修好了', success: true }; } };
  await retryFailed(id, { store, adapters: { x }, workspace: { make: () => '.' }, runs: new Map(), onEvent: () => {} });
  assert.match(seen, /上次在此步失败/);
  assert.match(seen, /缺少分号在第42行/);
});

test('复盘:喂入每步产出文件数,0文件提示别空转', async () => {
  const { open } = require('../store');
  const { harvestExperience } = require('../runner');
  const store = open(':memory:'); store.seed();
  const id = store.createTask('活', '默认项目', 'admin', {});
  store.setPlan(id, { steps: [{ id: 'a', role: 'engineering-frontend-developer', prompt: 'p', deps: [] }] });
  store.setStep(id, 'a', 'claude', 'done', '我写好了页面');
  store.addEvent(id, 'files', { step: 'a', n: 0 }); // 空转
  let seen = '';
  const claude = { async run({ prompt }) { seen = prompt; return { output: '{"employees":{}}', success: true }; } };
  await harvestExperience(id, { store, adapters: { claude } });
  assert.match(seen, /产出文件 0/);
  assert.match(seen, /别只描述不落盘|没落盘/);
});

test('task_plan.md 标注每步产出文件数', () => {
  const { open } = require('../store');
  const { writePlanFile } = require('../runner');
  const fs = require('fs'), path = require('path'), os = require('os');
  const s = open(':memory:'); s.seed();
  const id = s.createTask('活', '默认项目', 'admin', {});
  s.setPlan(id, { steps: [{ id: 'build', role: 'engineering-frontend-developer', prompt: 'p', deps: [] }] });
  s.setStep(id, 'build', 'claude', 'done', '做完了');
  s.addEvent(id, 'files', { step: 'build', n: 3 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchplan-'));
  writePlanFile(id, s, dir);
  const md = fs.readFileSync(path.join(dir, 'task_plan.md'), 'utf8');
  assert.match(md, /📄 3 文件/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('复盘后加系统消息告知更新的员工', async () => {
  const { open } = require('../store');
  const { harvestExperience } = require('../runner');
  const s = open(':memory:'); s.seed();
  const id = s.createTask('活', '默认项目', 'admin', {});
  s.setPlan(id, { steps: [{ id: 'a', role: 'engineering-frontend-developer', prompt: 'p', deps: [] }] });
  s.setStep(id, 'a', 'claude', 'done', '完成');
  const claude = { async run() { return { output: '{"employees":{"engineering-frontend-developer":"经验x"},"chief":"复盘y"}', success: true }; } };
  await harvestExperience(id, { store: s, adapters: { claude } });
  const msgs = s.getTaskMsgs(id);
  const sys = msgs.find((m) => m.who === 'system' && /任务复盘完成/.test(m.text));
  assert.ok(sys);
  assert.match(sys.text, /总调度/);
});
