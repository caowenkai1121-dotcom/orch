const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { makePlan, validate, lintPlan, mergeEditedPlan, extractJson, fill } = require('../planner');

test('规划期 claude 调用受并发信号量约束(不再fork风暴)', async () => {
  process.env.ORCH_CONCURRENCY = '1';
  let cur = 0, peak = 0;
  const claude = { async run() { cur++; peak = Math.max(peak, cur); await new Promise((r) => setTimeout(r, 20)); cur--; return { output: '{"steps":[{"id":"a","agent":"claude","prompt":"p","deps":[]}]}', success: true }; } };
  const opts = { agents: ['claude', 'codex'], roles: [], depts: [], refine: false, templatesDir: __dirname, claude }; // 多执行器→fromLLM 用 claude
  await Promise.all([makePlan('t1', opts), makePlan('t2', opts), makePlan('t3', opts)]);
  assert.ok(peak <= 1, 'peak=' + peak); // sem(1) 下并发规划≤1
  delete process.env.ORCH_CONCURRENCY;
});
const TPL = path.join(__dirname, '..', 'templates');

test('合法 plan 校验通过', () => {
  const ok = validate({ steps: [{ id: 'a', agent: 'claude', prompt: 'p', deps: [] }] }, ['claude', 'codex']);
  assert.equal(ok, true);
});
test('agent 不在可用列表则不通过', () => {
  assert.equal(validate({ steps: [{ id: 'a', agent: 'ghost', prompt: 'p', deps: [] }] }, ['claude']), false);
});
test('LLM 模式:合法 JSON 直接用', async () => {
  const claude = { async run() { return { output: '```json\n{"steps":[{"id":"x","agent":"claude","prompt":"p","deps":[]}]}\n```', success: true }; } };
  const plan = await makePlan('做事', { mode: 'llm', agents: ['claude', 'codex'], templatesDir: TPL, claude });
  assert.equal(plan.steps[0].id, 'x');
});
test('LLM 模式:非法(未知agent)回退模板', async () => {
  const claude = { async run() { return { output: '{"steps":[{"id":"x","agent":"ghost","prompt":"p","deps":[]}]}', success: true }; } };
  const plan = await makePlan('做事', { mode: 'llm', agents: ['claude', 'codex'], templatesDir: TPL, claude });
  assert.equal(plan.steps[0].id, 'dev'); // 兜底模板首步
});

test('#9 lintPlan 捕获结构错:重复id/缺指派/loop缺body/空', () => {
  assert.deepEqual(lintPlan({ steps: [] }), ['计划无任何步骤']);
  assert.ok(lintPlan({ steps: [{ id: 'a', agent: 'claude' }, { id: 'a', agent: 'claude' }] }).some((p) => /id 重复.*a/.test(p)));
  assert.ok(lintPlan({ steps: [{ id: 'a' }] }).some((p) => /未指派执行器/.test(p)));       // 无 hasRole → 查 agent
  assert.ok(lintPlan({ steps: [{ id: 'a' }] }, true).some((p) => /未指派员工/.test(p)));    // hasRole → 查 role
  assert.ok(lintPlan({ steps: [{ id: 'q', type: 'loop', body: [] }] }).some((p) => /缺 body/.test(p)));
  assert.deepEqual(lintPlan({ steps: [{ id: 'a', agent: 'claude', deps: [] }, { id: 'b', agent: 'claude', deps: ['a'] }] }), []); // 健康→无问题
});

test('#9 员工模式:结构坏(重复id)计划带问题回喂 planner 重拆一次', async () => {
  let call = 0;
  const claude = { async run() {
    call++;
    return call === 1
      ? { output: '{"steps":[{"id":"a","role":"r1","prompt":"p","deps":[]},{"id":"a","role":"r1","prompt":"q","deps":[]}]}', success: true } // 重复 id a
      : { output: '{"steps":[{"id":"a","role":"r1","prompt":"p","deps":[]},{"id":"b","role":"r1","prompt":"q","deps":["a"]}]}', success: true }; // 干净
  } };
  const roles = [{ id: 'r1', dept: 'dev', name: 'Dev', description: '', prompt: '角色', executor: 'claude' }];
  const plan = await makePlan('做个东西', { mode: 'llm', agents: ['claude'], roles, depts: [], refine: false, templatesDir: TPL, claude });
  assert.equal(call, 2);                                   // 坏计划触发一次回喂重拆
  assert.equal(plan.steps.length, 2);
  const ids = plan.steps.map((s) => s.id);
  assert.deepEqual([...new Set(ids)].sort(), ['a', 'b']);   // 采用了无重复 id 的重拆结果
});

test('#9 执行器模式:结构坏(重复id)计划带问题回喂 fromLLM 重拆一次', async () => {
  let call = 0;
  const claude = { async run() {
    call++;
    return call === 1
      ? { output: '{"steps":[{"id":"a","agent":"claude","prompt":"p","deps":[]},{"id":"a","agent":"codex","prompt":"q","deps":[]}]}', success: true } // 重复 id
      : { output: '{"steps":[{"id":"a","agent":"claude","prompt":"p","deps":[]},{"id":"b","agent":"codex","prompt":"q","deps":["a"]}]}', success: true }; // 干净
  } };
  const plan = await makePlan('做事', { mode: 'llm', agents: ['claude', 'codex'], roles: [], depts: [], refine: false, templatesDir: TPL, claude });
  assert.equal(call, 2);                                   // 执行器路径也回喂重拆一次
  assert.deepEqual([...new Set(plan.steps.map((s) => s.id))].sort(), ['a', 'b']);
});

test('#16 mergeEditedPlan:已完成步强制保留原样,未完成步删除生效', () => {
  const cur = { task: 't', steps: [{ id: 'a', agent: 'claude', prompt: '原A', deps: [] }, { id: 'b', agent: 'codex', prompt: '原B', deps: ['a'] }] };
  const incoming = { task: 't', steps: [{ id: 'a', agent: 'claude', prompt: '改过的A', deps: [] }] }; // 客户端改了 a、删了 b
  const merged = mergeEditedPlan(cur, incoming, ['a']);    // a 已完成
  assert.equal(merged.steps.find((s) => s.id === 'a').prompt, '原A'); // 已完成 a 强制保留原样
  assert.ok(!merged.steps.find((s) => s.id === 'b'));                 // 未完成 b 客户端删了 → 删除生效
});
test('审查修复:extractJson 跳过回显的花括号格式片段取真计划 + 剥代码围栏', () => {
  const o = extractJson('好的,格式是 {id,agent,prompt,deps}。计划如下:\n{"steps":[{"id":"a","role":"x"}]}');
  assert.equal(o.steps[0].id, 'a');                                    // 不被前面 {id,agent} 片段带崩
  assert.equal(extractJson('```json\n{"steps":[{"id":"b"}]}\n```').steps[0].id, 'b'); // 剥围栏
  assert.equal(extractJson('前言 {"note":"x"} 然后 {"steps":[{"id":"c"}]}').steps[0].id, 'c'); // 优先含 steps 的候选
});
test('审查修复:sanitizeDeps 递归清理 loop body(去重id+剔自依赖)', () => {
  const { sanitizeDeps } = require('../planner');
  const p = sanitizeDeps({ steps: [
    { id: 'q', type: 'loop', deps: [], body: [
      { id: 'impl', agent: 'claude', deps: ['impl'] }, // 自依赖
      { id: 'gate', agent: 'codex', deps: ['impl'] },
      { id: 'impl', agent: 'x', deps: [] },            // 重复 id
    ] },
  ] });
  const loop = p.steps.find((s) => s.id === 'q');
  assert.equal(loop.body.length, 2);                                 // 重复 impl 去掉
  assert.deepEqual(loop.body.find((b) => b.id === 'impl').deps, []); // 自依赖剔除
});

test('审查修复:role模式裸agent越出部门执行器池被coerce(防未验证/broken自动发现agent混入)', () => {
  const { resolveRoles } = require('../planner');
  const steps = [{ id: 'v', agent: 'gemini', deps: [] }];                    // LLM 未给 role、直接吐裸 agent gemini(不在池)
  resolveRoles(steps, {}, ['claude', 'codex', 'gemini'], { engineering: ['claude', 'codex'] }, 't', []);
  assert.ok(['claude', 'codex'].includes(steps[0].agent), 'gemini 应被 coerce 到池内,实际=' + steps[0].agent);
  const ok = [{ id: 'a', agent: 'codex', deps: [] }];                        // 池内裸 agent 不动
  resolveRoles(ok, {}, ['claude', 'codex', 'gemini'], { engineering: ['claude', 'codex'] }, 't', []);
  assert.equal(ok[0].agent, 'codex');
  const noPool = [{ id: 'g', agent: 'gemini', deps: [] }];                   // 无部门池→不限制(向后兼容)
  resolveRoles(noPool, {}, ['claude', 'codex', 'gemini'], {}, 't', []);
  assert.equal(noPool[0].agent, 'gemini');
});

test('审查修复:refineBrief 剥除 metaDir 绝对路径(防细化把中性cwd当工作目录、交付物落错目录)', async () => {
  const { refineBrief } = require('../planner');
  const { metaDir } = require('../workspace');
  const claude = { async run() { return { output: '在 ' + metaDir() + '\\out.txt 创建文件,单文件零依赖', success: true }; } };
  const b = await refineBrief('做个文件', claude);
  assert.ok(!b.includes(metaDir()), 'brief 不应残留 metaDir 绝对路径(否则执行步会写到 metaDir)');
});

test('审查修复:fill 全部替换 {task} 且不解释 $ 特殊序列', () => {
  const out = fill([{ id: 'a', prompt: '为「{task}」实现,并给「{task}」写测试' }], '价格$&优惠');
  assert.equal(out[0].prompt, '为「价格$&优惠」实现,并给「价格$&优惠」写测试'); // 两处都替、$&字面保留
});

test('审查修复:sanitizeDeps 去重重复 step id(保留首个,防 runPlan 碰撞丢步)', () => {
  const { sanitizeDeps } = require('../planner');
  const p = sanitizeDeps({ steps: [
    { id: 'a', agent: 'claude', prompt: '首个a', deps: [] },
    { id: 'a', agent: 'codex', prompt: '重复a', deps: [] },
    { id: 'b', agent: 'claude', prompt: 'b', deps: ['a'] },
  ] });
  assert.equal(p.steps.length, 2);                                   // 重复 a 被去掉
  assert.equal(p.steps.filter((s) => s.id === 'a').length, 1);       // 只剩一个 a
  assert.equal(p.steps.find((s) => s.id === 'a').prompt, '首个a');    // 保留首个
});

test('#16 mergeEditedPlan:未完成步的编辑生效', () => {
  const cur = { task: 't', steps: [{ id: 'a', agent: 'claude', prompt: '原A', deps: [] }] };
  const incoming = { task: 't', steps: [{ id: 'a', agent: 'claude', prompt: '改过的A', deps: [] }] };
  const merged = mergeEditedPlan(cur, incoming, []);       // 无已完成步
  assert.equal(merged.steps.find((s) => s.id === 'a').prompt, '改过的A'); // 未完成 → 编辑生效
});
