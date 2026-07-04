const { test } = require('node:test');
const assert = require('node:assert');
const { runPlan } = require('../engine');

function ctx(adapters, extra) {
  return Object.assign({ adapters, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {} }, extra || {});
}

test('并发不超过上限', async () => {
  process.env.ORCH_CONCURRENCY = '2';
  let cur = 0, peak = 0;
  const slow = { async run() { cur++; peak = Math.max(peak, cur); await new Promise((r) => setTimeout(r, 30)); cur--; return { output: '', success: true }; } };
  const steps = Array.from({ length: 6 }, (_, i) => ({ id: 's' + i, agent: 'a', prompt: 'p', deps: [] }));
  await runPlan({ steps }, ctx({ a: slow }));
  assert.ok(peak <= 2, 'peak=' + peak);
  delete process.env.ORCH_CONCURRENCY;
});

test('连续调度:独立快分支不被慢兄弟拖住(deps一满足即启动)', async () => {
  const done = [];
  const mk = (ms) => ({ async run({ prompt }) { await new Promise((r) => setTimeout(r, ms)); const id = prompt.match(/\bID:(\w+)/)[1]; done.push(id); return { output: '', success: true }; } });
  // a1(快)→a2(快) 与 b1(慢) 无依赖并行。波次模型下 a2 要等整波(含慢 b1)才启动 → a2 最后完成。
  const plan = { steps: [
    { id: 'a1', agent: 'f', prompt: 'ID:a1', deps: [] },
    { id: 'a2', agent: 'f', prompt: 'ID:a2', deps: ['a1'] },
    { id: 'b1', agent: 's', prompt: 'ID:b1', deps: [] },
  ] };
  await runPlan(plan, ctx({ f: mk(5), s: mk(80) }));
  assert.ok(done.indexOf('a2') < done.indexOf('b1'), '连续调度下 a2 应在慢 b1 之前完成,实际顺序: ' + done.join(','));
});

test('适配器抛错:该步标失败(非卡running),独立分支仍完成', async () => {
  const boom = { async run() { throw new Error('spawn xyz ENOENT'); } };
  const okA = { async run() { return { output: 'done', success: true }; } };
  const statuses = {};
  const c = ctx({ boom, ok: okA }, { onStatus: (sid, st) => { statuses[sid] = st; } });
  const done = await runPlan({ steps: [
    { id: 'bad', agent: 'boom', prompt: 'p', deps: [] },
    { id: 'good', agent: 'ok', prompt: 'p', deps: [] },
  ] }, c);
  assert.equal(statuses.bad, 'failed');       // 抛错步→失败,不是卡 running
  assert.equal(done.bad.success, false);
  assert.match(done.bad.output, /ENOENT/);    // 错误被捕获为产出(可经 failReason 展示)
  assert.equal(statuses.good, 'done');        // 独立分支不受影响
  assert.equal(done.good.success, true);
});

test('取消后不再起新 step', async () => {
  let ran = 0;
  const a = { async run() { ran++; return { output: '', success: true }; } };
  let cancelled = false;
  const c = ctx({ a }, { isCancelled: () => cancelled });
  // a 依赖链:s0 -> s1;在 s0 后置取消
  const a2 = { async run() { ran++; cancelled = true; return { output: '', success: true }; } };
  const done = await runPlan({ steps: [{ id: 's0', agent: 'b', prompt: 'p', deps: [] }, { id: 's1', agent: 'a', prompt: 'p', deps: ['s0'] }] }, ctx({ a, b: a2 }, { isCancelled: () => cancelled }));
  assert.equal(ran, 1); // 只有 s0(b)跑了,取消后 s1 不跑
});

test('onUsage 透传', async () => {
  const got = [];
  const a = { async run({ onUsage }) { onUsage && onUsage({ input: 5, output: 3, cost: 0.001 }); return { output: '', success: true }; } };
  await runPlan({ steps: [{ id: 's', agent: 'a', prompt: 'p', deps: [] }] }, ctx({ a }, { onUsage: (sid, ag, u) => got.push([sid, ag, u.input]) }));
  assert.deepEqual(got, [['s', 'a', 5]]);
});

test('askMode: NEED_DECISION 使步骤阻塞并触发 onDecision,下游不跑', async () => {
  const { runPlan } = require('../engine');
  let ran = 0, decided = null;
  const asker = { async run() { return { output: '分析完成\nNEED_DECISION: 用 Vue 还是 React?', success: true }; } };
  const down = { async run() { ran++; return { output: '', success: true }; } };
  const done = await runPlan({ steps: [{ id: 'a', agent: 'asker', prompt: 'p', deps: [] }, { id: 'b', agent: 'down', prompt: 'p', deps: ['a'] }] },
    { adapters: { asker, down }, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {}, askMode: true, onDecision: (sid, q) => { decided = { sid, q }; } });
  assert.equal(ran, 0);
  assert.ok(decided && decided.sid === 'a');
  assert.match(decided.q, /Vue/);
});

test('seedDone 跳过已完成步骤,只跑剩余', async () => {
  const { runPlan } = require('../engine');
  let ran = [];
  const a = { async run() { ran.push('x'); return { output: 'ok', success: true }; } };
  const done = await runPlan({ steps: [{ id: 'a', agent: 'x', prompt: 'p', deps: [] }, { id: 'b', agent: 'x', prompt: 'p', deps: ['a'] }] },
    { adapters: { x: a }, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {}, seedDone: { a: { output: 'seeded', success: true } } });
  assert.equal(ran.length, 1); // 只跑 b(a 已 seed)
  assert.equal(done.a.output, 'seeded');
});

test('质量门:门禁输出FAIL退回重做,PASS才放行', async () => {
  const { runPlan } = require('../engine');
  let implRuns = 0, gateCall = 0;
  const impl = { async run({ prompt }) { implRuns++; return { output: '实现完成 v' + implRuns, success: true }; } };
  const gate = { async run() { gateCall++; return { output: gateCall === 1 ? 'FAIL: 有 bug 未修' : 'PASS 全部通过', success: true }; } };
  const plan = { steps: [{ id: 'q', type: 'loop', until: 'pass', max: 3, deps: [], body: [
    { id: 'impl', agent: 'i', prompt: 'p', deps: [] },
    { id: 'gate', agent: 'g', prompt: 'p', deps: [] },
  ] }] };
  await runPlan(plan, { adapters: { i: impl, g: gate }, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {} });
  assert.equal(gateCall, 2);     // 门禁跑2轮(FAIL→PASS)
  assert.equal(implRuns, 2);     // 实现重做1次
});

test('质量门:一直FAIL则到max停,不无限循环', async () => {
  const { runPlan } = require('../engine');
  let gc = 0;
  const impl = { async run() { return { output: 'x', success: true }; } };
  const gate = { async run() { gc++; return { output: 'FAIL 还是不行', success: true }; } };
  const plan = { steps: [{ id: 'q', type: 'loop', until: 'pass', max: 2, deps: [], body: [
    { id: 'impl', agent: 'i', prompt: 'p', deps: [] }, { id: 'gate', agent: 'g', prompt: 'p', deps: [] },
  ] }] };
  await runPlan(plan, { adapters: { i: impl, g: gate }, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {} });
  assert.equal(gc, 2);  // max=2 轮后停
});

test('质量门:门禁步注入PASS/FAIL格式要求', async () => {
  const { runPlan } = require('../engine');
  let gatePrompt = '';
  const impl = { async run() { return { output: 'done', success: true }; } };
  const gate = { async run({ prompt }) { gatePrompt = prompt; return { output: 'PASS 通过', success: true }; } };
  const plan = { steps: [{ id: 'q', type: 'loop', until: 'pass', max: 2, deps: [], body: [
    { id: 'impl', agent: 'i', prompt: 'p', deps: [] }, { id: 'gate', agent: 'g', prompt: '审查', deps: [] },
  ] }] };
  await runPlan(plan, { adapters: { i: impl, g: gate }, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {} });
  assert.match(gatePrompt, /质量门·必读/);
  assert.match(gatePrompt, /PASS.*FAIL|FAIL/);
});

test('质量门打回:实现员工收到返工框架', async () => {
  const { runPlan } = require('../engine');
  let implPrompts = [];
  let gc = 0;
  const impl = { async run({ prompt }) { implPrompts.push(prompt); return { output: 'v', success: true }; } };
  const gate = { async run() { gc++; return { output: gc === 1 ? 'FAIL 缺少错误处理' : 'PASS', success: true }; } };
  const plan = { steps: [{ id: 'q', type: 'loop', until: 'pass', max: 3, deps: [], body: [
    { id: 'impl', agent: 'i', prompt: '实现', deps: [] }, { id: 'gate', agent: 'g', prompt: '审查', deps: [] },
  ] }] };
  await runPlan(plan, { adapters: { i: impl, g: gate }, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {} });
  // 第二次实现(返工)应收到打回框架 + 门禁问题
  assert.match(implPrompts[1], /质量门.*打回/);
  assert.match(implPrompts[1], /缺少错误处理/);
});

test('质量门检测:按首个判定词,FAIL在前判失败', async () => {
  // 直接测 gateFailed(经 runLoop 行为覆盖)
  const { runPlan } = require('../engine');
  const outs = [
    ['FAIL: 缺错误处理,但部分用例 PASS', true],   // FAIL 在前 → 失败
    ['PASS: 全部通过,无 FAIL 项', false],          // PASS 在前 → 通过
    ['FAIL 不合格', true],
    ['PASS 合格', false],
    ['一切正常', false],                            // 无判定词 → 通过
  ];
  for (const [gateOut, shouldRework] of outs) {
    let gc = 0, implRuns = 0;
    const impl = { async run() { implRuns++; return { output: 'v', success: true }; } };
    const gate = { async run() { gc++; return { output: gc === 1 ? gateOut : 'PASS 通过', success: true }; } };
    const plan = { steps: [{ id: 'q', type: 'loop', until: 'pass', max: 3, deps: [], body: [
      { id: 'impl', agent: 'i', prompt: 'p', deps: [] }, { id: 'gate', agent: 'g', prompt: 'p', deps: [] },
    ] }] };
    await runPlan(plan, { adapters: { i: impl, g: gate }, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {} });
    assert.equal(implRuns > 1, shouldRework, '门禁输出: ' + gateOut);
  }
});

test('loop max 封顶 5,防失控', async () => {
  const { runPlan } = require('../engine');
  let gc = 0;
  const impl = { async run() { return { output: 'v', success: true }; } };
  const gate = { async run() { gc++; return { output: 'FAIL 永不通过', success: true }; } };
  const plan = { steps: [{ id: 'q', type: 'loop', until: 'pass', max: 99, deps: [], body: [
    { id: 'impl', agent: 'i', prompt: 'p', deps: [] }, { id: 'gate', agent: 'g', prompt: 'p', deps: [] },
  ] }] };
  await runPlan(plan, { adapters: { i: impl, g: gate }, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {} });
  assert.equal(gc, 5); // max=99 被封到 5
});

test('交接:上游失败时下游被告知', async () => {
  const { runPlan } = require('../engine');
  let downPrompt = '';
  const failAgent = { async run() { return { output: '部分产出', success: false }; } };
  const downAgent = { async run({ prompt }) { downPrompt = prompt; return { output: 'ok', success: true }; } };
  const plan = { steps: [
    { id: 'up', agent: 'f', prompt: 'p', deps: [] },
    { id: 'down', agent: 'd', prompt: 'q', deps: ['up'] },
  ] };
  await runPlan(plan, { adapters: { f: failAgent, d: downAgent }, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {} });
  assert.match(downPrompt, /失败|产出可能不完整/); // 下游收到上游失败告知
});

test('简报注入findings.md内容(不指望员工主动读)', async () => {
  const { runPlan } = require('../engine');
  const fs = require('fs'), path = require('path'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchfnd-'));
  fs.writeFileSync(path.join(dir, 'findings.md'), '# 团队发现\n\n> 说明\n\n- 决定:用 canvas 手绘图表 UNIQUE_FND_9x7\n- 踩坑:file:// 被封');
  let seen = '';
  const ag = { async run({ prompt }) { seen = prompt; return { output: 'ok', success: true }; } };
  const plan = { steps: [{ id: 'a', agent: 'x', prompt: 'p', deps: [] }] };
  await runPlan(plan, { adapters: { x: ag }, workspace: { make: () => dir }, onLog: () => {}, onStatus: () => {} });
  assert.match(seen, /团队共享发现/);
  assert.match(seen, /UNIQUE_FND_9x7/);
  fs.rmSync(dir, { recursive: true, force: true });
});
