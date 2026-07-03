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
