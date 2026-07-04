const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { open } = require('../store');
const { runTask, runApproved, countRecentFiles } = require('../runner');

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
  assert.equal(countRecentFiles(dir, since), 1);         // 只数 new.html(old.txt 早于 since;共享文件排除)
  assert.equal(countRecentFiles(dir, 0), 2);             // since=0 → old+new,仍不含共享文件
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
