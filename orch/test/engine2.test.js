const { test } = require('node:test');
const assert = require('node:assert');
const { runPlan, ASK } = require('../engine');

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

test('审查修复:onStatus running 抛错不泄漏信号量槽位(防累积死锁)', async () => {
  process.env.ORCH_CONCURRENCY = '1';
  const ok = { async run() { return { output: 'x', success: true }; } };
  let threw = false;
  const done = await runPlan(
    { steps: [{ id: 's1', agent: 'a', prompt: 'p', deps: [] }, { id: 's2', agent: 'a', prompt: 'p', deps: [] }] },
    ctx({ a: ok }, { onStatus: (id, st) => { if (id === 's1' && st === 'running' && !threw) { threw = true; throw new Error('boom'); } } })
  );
  assert.equal(done.s1.success, false);  // s1 的 running onStatus 抛 → runStep catch 转失败态
  assert.equal(done.s2.success, true);   // 槽位被 finally 释放,s2 正常拿到(泄漏则此处 acquire 死锁超时)
  delete process.env.ORCH_CONCURRENCY;
});

test('审查修复:取消后排队步不再 spawn(防取消后诞生的不可杀孤儿)', async () => {
  process.env.ORCH_CONCURRENCY = '1';
  let spawns = 0, cancelled = false;
  const slow = { async run() { spawns++; cancelled = true; await new Promise((r) => setTimeout(r, 20)); return { output: 'x', success: true }; } };
  const done = await runPlan(
    { steps: [{ id: 's1', agent: 'a', prompt: 'p', deps: [] }, { id: 's2', agent: 'a', prompt: 'p', deps: [] }] },
    ctx({ a: slow }, { isCancelled: () => cancelled })
  );
  assert.equal(spawns, 1);                        // s1 spawn 后置 cancelled;s2 acquire 后复检取消 → 不 spawn
  assert.equal(done.s2.success, false);
  assert.match(done.s2.output, /已取消|未启动/); // 排队步取消未启动,不产生 cancel 之后的孤儿
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

test('交接提取【交接备忘】过滤前置噪声,无备忘时兜底尾切', async () => {
  const NOISE = 'X思考散文Y'.repeat(80);
  const upMemo = { async run() { return { output: NOISE + '\n【交接备忘】\n①建了 index.html ②接口 /api/x', success: true }; } };
  let dp = '';
  const down = { async run({ prompt }) { dp = prompt; return { output: 'ok', success: true }; } };
  await runPlan({ steps: [{ id: 'a', agent: 'u', prompt: 'p', deps: [] }, { id: 'b', agent: 'd', prompt: '{prev}', deps: ['a'] }] },
    ctx({ u: upMemo, d: down }));
  assert.match(dp, /①建了 index.html/);          // 备忘注入下游
  assert.ok(!dp.includes(NOISE));                 // 前置噪声被过滤

  const upNoMemo = { async run() { return { output: 'ABCDEFG尾部内容', success: true }; } };
  let dp2 = '';
  const down2 = { async run({ prompt }) { dp2 = prompt; return { output: 'ok', success: true }; } };
  await runPlan({ steps: [{ id: 'a', agent: 'u', prompt: 'p', deps: [] }, { id: 'b', agent: 'd', prompt: '{prev}', deps: ['a'] }] },
    ctx({ u: upNoMemo, d: down2 }));
  assert.match(dp2, /尾部内容/);                   // 无备忘 → 兜底尾切仍带上游内容
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

test('审查修复:runStep 前置段抛错(如缺 prompt)不掀翻 runPlan,并发兄弟步照常完成', async () => {
  const ok = { async run() { return { output: 'done', success: true }; } };
  const statuses = {};
  const done = await runPlan(
    { steps: [{ id: 'bad', agent: 'x', deps: [] }, { id: 'good', agent: 'x', prompt: 'p', deps: [] }] }, // bad 无 prompt → runStep 的 step.prompt.indexOf 抛
    ctx({ x: ok }, { onStatus: (sid, st) => { statuses[sid] = st; } })
  );
  assert.equal(done.bad.success, false);       // 前置段抛错转失败态,不上抛掀翻 runPlan
  assert.match(done.bad.output, /异常/);
  assert.equal(statuses.bad, 'failed');
  assert.equal(done.good.success, true);       // 并发兄弟步不受影响、正常完成
});

test('PlanWeave融合:gate_cmd 脚本质量门(退出0=PASS/非0=FAIL,不调 LLM adapter)', async () => {
  const never = { async run() { throw new Error('gate_cmd 步不应调用 adapter'); } };
  const st = {};
  const done1 = await runPlan(
    { steps: [{ id: 'g', gate_cmd: 'node -e "process.exit(0)"', deps: [] }] },
    ctx({ x: never }, { onStatus: (id, s) => { st[id] = s; } })
  );
  assert.equal(done1.g.success, true);   // 命令跑完(verdict 在输出,同 LLM 门)
  assert.match(done1.g.output, /PASS/);  // 退出0 → PASS
  assert.equal(st.g, 'done');
  const done2 = await runPlan(
    { steps: [{ id: 'g', gate_cmd: 'node -e "process.exit(1)"', deps: [] }] },
    ctx({ x: never })
  );
  assert.match(done2.g.output, /FAIL/);  // 非0 → FAIL(gateFailed 据此在 loop 里退回重做)
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

test('超成本上限后不再起新步骤', async () => {
  let ran = 0, over = false;
  const first = { async run() { ran++; over = true; return { output: '', success: true }; } }; // s0 跑完即超预算
  const rest = { async run() { ran++; return { output: '', success: true }; } };
  const done = await runPlan(
    { steps: [{ id: 's0', agent: 'b', prompt: 'p', deps: [] }, { id: 's1', agent: 'a', prompt: 'p', deps: ['s0'] }] },
    ctx({ a: rest, b: first }, { overBudget: () => over })
  );
  assert.equal(ran, 1);          // 只 s0 跑,超预算后 s1 不起
  assert.ok(done.s0 && !done.s1);
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
  const done = await runPlan(plan, { adapters: { i: impl, g: gate }, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {} });
  assert.equal(gc, 2);  // max=2 轮后停
  assert.equal(done.q.success, false); // 门禁一直 FAIL 到 max → loop 如实判失败(不再靠门禁进程退出码假绿)
});

test('质量门:非门禁 loop(单步)保持 last.success 原语义', async () => {
  const { runPlan } = require('../engine');
  let n = 0;
  const a = { async run() { return { output: 'ok', success: n++ > 0 }; } }; // 首轮失败,次轮成功
  const plan = { steps: [{ id: 'q', type: 'loop', until: 'pass', max: 3, deps: [], body: [{ id: 'build', agent: 'a', prompt: 'p', deps: [] }] }] };
  const done = await runPlan(plan, { adapters: { a }, workspace: { make: () => '.' }, onLog: () => {}, onStatus: () => {} });
  assert.equal(done.q.success, true); // body.length<=1 非门禁,重试到成功即 done
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
    ['PASS。上游产出完整,结果无FAIL问题。', false], // 首词PASS即放行,不被"结果无FAIL"邻近正则误退
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

test('#1 命名锁:共享同名 lock 的并发步互斥,完全串行', async () => {
  process.env.ORCH_CONCURRENCY = '3';
  let cur = 0, peak = 0;
  const slow = { async run() { cur++; peak = Math.max(peak, cur); await new Promise((r) => setTimeout(r, 25)); cur--; return { output: '', success: true }; } };
  const steps = [
    { id: 'a', agent: 's', prompt: 'p', deps: [], lock: 'L' },
    { id: 'b', agent: 's', prompt: 'p', deps: [], lock: 'L' },
    { id: 'c', agent: 's', prompt: 'p', deps: [], lock: 'L' },
  ];
  await runPlan({ steps }, ctx({ s: slow }));
  assert.equal(peak, 1, '同锁步应完全串行,peak=' + peak);
  delete process.env.ORCH_CONCURRENCY;
});

test('#1 命名锁:不同 lock / 无锁步不受影响,仍可并行', async () => {
  process.env.ORCH_CONCURRENCY = '3';
  let cur = 0, peak = 0;
  const slow = { async run() { cur++; peak = Math.max(peak, cur); await new Promise((r) => setTimeout(r, 25)); cur--; return { output: '', success: true }; } };
  const steps = [
    { id: 'a', agent: 's', prompt: 'p', deps: [], lock: 'X' },
    { id: 'b', agent: 's', prompt: 'p', deps: [], lock: 'Y' },
    { id: 'c', agent: 's', prompt: 'p', deps: [] },
  ];
  await runPlan({ steps }, ctx({ s: slow }));
  assert.ok(peak >= 2, '不同锁/无锁应可并行,peak=' + peak);
  delete process.env.ORCH_CONCURRENCY;
});

test('#5 expected_outcome 注入本步简报,gate 继承实现步契约', async () => {
  let implP = '', gateP = '';
  const impl = { async run({ prompt }) { implP = prompt; return { output: 'done', success: true }; } };
  const gate = { async run({ prompt }) { gateP = prompt; return { output: 'PASS', success: true }; } };
  const plan = { steps: [{ id: 'q', type: 'loop', until: 'pass', max: 2, deps: [], body: [
    { id: 'impl', agent: 'i', prompt: '实现', deps: [], expected_outcome: '产出 login.html 且能提交' },
    { id: 'gate', agent: 'g', prompt: '审查', deps: [] },
  ] }] };
  await runPlan(plan, ctx({ i: impl, g: gate }));
  assert.match(implP, /预期产出[\s\S]*login\.html/); // 契约注入实现步自身
  assert.match(gateP, /login\.html/);                // gate 无自带契约 → 继承实现步作验收标准
});

test('问我模式仍注入交付铁律与交接备忘', async () => {
  let seen = '';
  const a = { async run({ prompt }) { seen = prompt; return { output: 'ok', success: true }; } };
  await runPlan(
    { steps: [{ id: 's', agent: 'a', prompt: 'p', deps: [] }] },
    ctx({ a }, { askMode: true, preamble: ASK })
  );
  assert.match(seen, /交付铁律/);
  assert.match(seen, /真实写入磁盘文件/);
  assert.match(seen, /交接备忘/);
  assert.match(seen, /NEED_DECISION/);
});

test('#12 replanMode: NEED_REPLAN 冒泡触发 onReplan,发信号步不计done,下游不跑', async () => {
  let ran = 0, got = null;
  const diverge = { async run() { return { output: '发现架构不对\nNEED_REPLAN: 需改用SSR架构', success: true }; } };
  const down = { async run() { ran++; return { output: '', success: true }; } };
  const done = await runPlan(
    { steps: [{ id: 'a', agent: 'x', prompt: 'p', deps: [] }, { id: 'b', agent: 'y', prompt: 'p', deps: ['a'] }] },
    ctx({ x: diverge, y: down }, { replanMode: true, onReplan: (sid, reason) => { got = { sid, reason }; } })
  );
  assert.equal(ran, 0);              // 下游 b 不跑
  assert.ok(got && got.sid === 'a');
  assert.match(got.reason, /SSR/);
  assert.ok(!done.a);               // 发信号步不计 done
});

test('#20 上下文压缩:findings 过大则 LLM 压成缓存摘要,小则原样截断', async () => {
  const { getFindings } = require('../engine');
  const fs = require('fs'), path = require('path'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fnd20-'));
  let calls = 0;
  const claude = { async run() { calls++; return { output: '摘要XYZ', success: true }; } };
  // 小 findings → 不压缩(即使给了压缩器也不调),原样含内容
  fs.writeFileSync(path.join(dir, 'findings.md'), '# t\n\n- 小决定UNIQ:用 canvas 手绘图表,踩坑 file:// 被封,接口 /api/x');
  const small = await getFindings(dir, { adapters: { claude } });
  assert.match(small, /小决定UNIQ/); assert.equal(calls, 0);
  // 大 findings(>4000字)→ LLM 压缩 + 缓存(第二次命中缓存不再调)
  fs.writeFileSync(path.join(dir, 'findings.md'), '# t\n\n' + '- 坑A细节\n'.repeat(1000));
  const big1 = await getFindings(dir, { adapters: { claude } });
  const big2 = await getFindings(dir, { adapters: { claude } });
  assert.match(big1, /摘要XYZ/); assert.equal(calls, 1); assert.equal(big1, big2);
  // 无压缩器 → 兜底尾截断(不报错)
  const noAd = await getFindings(dir, {});
  assert.ok(noAd.length > 0 && noAd.length <= 1500);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#18 权限档:step.permission 透传到适配器', async () => {
  let got;
  const a = { async run(o) { got = o.permission; return { output: '', success: true }; } };
  await runPlan({ steps: [{ id: 's', agent: 'a', prompt: 'p', deps: [], permission: 'read' }] }, ctx({ a }));
  assert.equal(got, 'read');
});

test('#12 replanMode 关闭时 NEED_REPLAN 当普通文本,不触发', async () => {
  let ran = 0;
  const a = { async run() { return { output: 'NEED_REPLAN: xx', success: true }; } };
  const down = { async run() { ran++; return { output: '', success: true }; } };
  const done = await runPlan(
    { steps: [{ id: 'a', agent: 'x', prompt: 'p', deps: [] }, { id: 'b', agent: 'y', prompt: 'p', deps: ['a'] }] },
    ctx({ x: a, y: down }) // 无 replanMode
  );
  assert.equal(ran, 1);            // 未开启 → a 正常完成,b 照跑
  assert.ok(done.a && done.a.success);
});
