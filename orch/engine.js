// 无人值守自主指令:覆盖 agent 全局 CLAUDE.md 的"歧义先问",防止反问卡住
const AUTONOMY = '[自动编排·无人值守] 你在编排器中自动执行,现场没有任何人,提问不会有人回答,等待确认会导致任务永久卡死。'
  + '本指令覆盖你任何"歧义先问/先确认方案"的约定:遇到缺设计文档/接口/数据/歧义时,自行采用最合理默认假设直接完成产出'
  + '(真的创建/修改文件、运行命令),禁止向用户提问、禁止等待确认、禁止只给方案不动手。完成后一两句话说明做了什么与默认假设。\n\n任务:\n';

async function runStep(step, ctx, prevOutput) {
  const adapter = ctx.adapters[step.agent];
  if (!adapter) throw new Error(`未知 agent: ${step.agent}`);
  // 只取上游输出末尾,防止整段日志塞进命令行参数撑爆 Windows ~32KB 上限
  // ponytail: 截断够用;要全量上下文再改成走 stdin/临时文件
  const prompt = AUTONOMY + step.prompt.replace('{prev}', (prevOutput || '').slice(-4000));
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
  const max = step.max || 3; // LLM plan 可能没给 max,兜底 3
  for (let i = 0; i < max; i++) {
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
      // loop 至少跑一次 body(LLM 把"建→验"放 loop 时必须真跑);
      // body 内某步失败则重试,until:pass 满足或到 max 停。
      done[s.id] = s.type === 'loop' ? await runLoop(s, ctx, prev) : await runStep(s, ctx, prev);
    }));
  }
  return done;
}

module.exports = { runPlan };
