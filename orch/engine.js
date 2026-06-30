async function runStep(step, ctx, prevOutput) {
  const adapter = ctx.adapters[step.agent];
  if (!adapter) throw new Error(`未知 agent: ${step.agent}`);
  const prompt = step.prompt.replace('{prev}', prevOutput || '');
  const workdir = await ctx.workspace.make(step.id);
  ctx.onStatus(step.id, 'running');
  const res = await adapter.run({
    prompt, workdir,
    onLine: (line) => ctx.onLog(step.id, line),
  });
  ctx.onStatus(step.id, res.success ? 'done' : 'failed');
  return res;
}

async function runLoop(step, ctx, prevOutput) {
  let last = { output: prevOutput || '', success: false };
  for (let i = 0; i < step.max; i++) {
    for (const body of step.body) {
      last = await runStep(body, ctx, last.output);
      if (!last.success) break; // 本轮某步失败,跳出去重来
    }
    if (step.until === 'pass' && last.success) break;
  }
  ctx.onStatus(step.id, last.success ? 'done' : 'failed');
  return last;
}

// 拓扑按波次调度:每波把"依赖已完成且未启动"的步骤并发跑完再进下一波。
// ponytail: 波次内有 barrier,快步骤要等慢步骤;轻量足够,真要流式再改。
async function runPlan(plan, ctx) {
  const done = {};
  const started = new Set();
  const ready = (s) => s.deps.every((d) => done[d]);
  while (Object.keys(done).length < plan.steps.length) {
    const wave = plan.steps.filter((s) => !started.has(s.id) && ready(s));
    if (wave.length === 0) break; // 依赖无法满足,防死循环
    await Promise.all(wave.map(async (s) => {
      started.add(s.id);
      const prev = s.deps.length ? done[s.deps[0]]?.output : '';
      done[s.id] = s.type === 'loop'
        ? await runLoop(s, ctx, prev)
        : await runStep(s, ctx, prev);
    }));
  }
  return done;
}

module.exports = { runPlan };
