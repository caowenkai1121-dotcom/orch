async function runStep(step, ctx, prevOutput) {
  const adapter = ctx.adapters[step.agent];
  if (!adapter) throw new Error(`未知 agent: ${step.agent}`);
  // 只取上游输出末尾,防止整段日志塞进命令行参数撑爆 Windows ~32KB 上限
  // ponytail: 截断够用;要全量上下文再改成走 stdin/临时文件
  const prompt = step.prompt.replace('{prev}', (prevOutput || '').slice(-4000));
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
      if (s.type === 'loop') {
        // 上游(如 test)已通过则跳过改测循环:没坏就不修
        const depOk = s.deps.length && done[s.deps[0]] && done[s.deps[0]].success;
        if (depOk) {
          ctx.onStatus(s.id, 'done');
          done[s.id] = { output: prev, success: true };
        } else {
          done[s.id] = await runLoop(s, ctx, prev);
        }
      } else {
        done[s.id] = await runStep(s, ctx, prev);
      }
    }));
  }
  return done;
}

module.exports = { runPlan };
