const { runPlan, AUTONOMY, ASK } = require('./engine');

// 出 plan →(审批模式暂停待批,否则执行)
async function runTask(taskId, deps) {
  const { store, onEvent, makePlan } = deps;
  store.setTaskStatus(taskId, 'planning');
  const task = store.getTask(taskId);
  const plan = await makePlan(task.text);
  store.setPlan(taskId, plan);
  if (store.addEvent) store.addEvent(taskId, 'plan', { steps: (plan.steps || []).length });
  emit(onEvent, taskId, null, 'plan', plan);
  if (task.approve) {
    store.setTaskStatus(taskId, 'awaiting');
    if (store.addEvent) store.addEvent(taskId, 'task', 'awaiting');
    emit(onEvent, taskId, null, 'task', 'awaiting');
    return;
  }
  return execute(taskId, plan, deps, {});
}

// 审批批准后用(可能编辑过的)plan 执行
function runApproved(taskId, deps, plan) {
  deps.store.setPlan(taskId, plan);
  if (deps.store.addEvent) deps.store.addEvent(taskId, 'task', 'approved');
  return execute(taskId, plan, deps, {});
}

// 用户回答决策后续跑:跳过已完成步骤,把答案注入被阻塞步骤
function resumeTask(taskId, deps, stepId, answer) {
  const { store } = deps;
  const t = store.getTask(taskId);
  let plan = {}; try { plan = JSON.parse(t.plan); } catch (e) { plan = { steps: [] }; }
  const top = new Set((plan.steps || []).map((s) => s.id));
  const seedDone = {};
  store.doneSteps(taskId).forEach((s) => { if (top.has(s.step_id)) seedDone[s.step_id] = { output: s.output || '', success: true }; });
  store.clearTaskDecision(taskId);
  if (store.addEvent) store.addEvent(taskId, 'decision', { step: stepId, answer });
  return execute(taskId, plan, deps, { seedDone, answers: { [stepId]: answer } });
}

// 重试失败步骤:已完成步骤不重跑,只重跑失败/未完成的(限额恢复后一键续跑)
function retryFailed(taskId, deps) {
  const { store } = deps;
  const t = store.getTask(taskId);
  let plan = {}; try { plan = JSON.parse(t.plan); } catch (e) { plan = { steps: [] }; }
  const top = new Set((plan.steps || []).map((s) => s.id)); // 只 seed 顶层步骤(loop 子步骤不算,防完成度误判)
  const seedDone = {};
  store.doneSteps(taskId).forEach((s) => { if (top.has(s.step_id)) seedDone[s.step_id] = { output: s.output || '', success: true }; });
  if (store.addEvent) store.addEvent(taskId, 'retry', { skip: Object.keys(seedDone).length });
  return execute(taskId, plan, deps, { seedDone });
}

// 经验沉淀:任务结束后用 LLM 复盘,给每位参与员工提炼一条经验、给总调度一条调度复盘,存入 roles.memo
// 下次同员工/调度接任务时自动注入 → 越用越聪明。失败任务的教训同样提炼。
async function harvestExperience(taskId, deps) {
  const { store, adapters } = deps;
  if (!adapters || !adapters.claude) return;
  const t = store.getTask(taskId);
  let plan = {}; try { plan = JSON.parse(t.plan) || {}; } catch (e) { return; }
  const stepRole = {}; const walk = (arr) => (arr || []).forEach((s) => { if (s.body) walk(s.body); else if (s.role) stepRole[s.id] = s.role; });
  walk(plan.steps);
  if (!Object.keys(stepRole).length) return; // 非员工模式不复盘
  if (store.getEvents(taskId).some((e) => e.type === 'harvest')) return; // 每任务只复盘一次
  store.addEvent(taskId, 'harvest', { at: t.status });
  const lines = (t.steps || []).filter((s) => stepRole[s.step_id]).map((s) =>
    '步骤 ' + s.step_id + ' | 员工 ' + stepRole[s.step_id] + ' | 结果 ' + s.status + ' | 产出摘要: ' + String(s.output || '').replace(/\s+/g, ' ').slice(-400));
  const prompt = '你是团队复盘专家。任务「' + (t.text || '') + '」已结束(状态 ' + t.status + ')。各步骤:\n' + lines.join('\n')
    + '\n\n输出 JSON:{"employees":{"<员工id>":"一条≤60字可复用经验(成功套路或踩过的坑,具体不空话)"},"chief":"一条≤80字调度复盘(步骤划分/指派/质量门下次怎么改进)"}。'
    + '只为值得记的员工写经验(没有就省略该员工),只输出 JSON。';
  try {
    const { output } = await adapters.claude.run({ prompt, workdir: process.cwd(), onLine: () => {} });
    const j = JSON.parse((output.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    Object.entries(j.employees || {}).forEach(([rid, line]) => store.appendRoleMemo(rid, line));
    if (j.chief) store.appendRoleMemo('chief-orchestrator', j.chief);
  } catch (e) { /* 复盘失败不影响任务 */ }
}

// 限额自动重试:任务因执行器限额失败时,解析重置时间到点自动续跑(每任务最多2次)
function scheduleAutoRetry(taskId, deps) {
  const { store } = deps;
  const t = store.getTask(taskId);
  const hit = (t.steps || []).filter((s) => s.status === 'failed').map((s) => s.output || '')
    .find((o) => /hit your session limit|usage limit|rate limit/i.test(o));
  if (!hit) return;
  const n = store.getEvents(taskId).filter((e) => e.type === 'auto_retry').length;
  if (n >= 2) return; // 防死循环
  const m = hit.match(/resets\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  let delay = 30 * 60 * 1000; // 解析不到重置时间:30分钟兜底
  if (m) {
    let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12;
    const target = new Date(); target.setHours(h, Number(m[2]) + 3, 0, 0); // +3分钟缓冲
    if (target <= new Date()) target.setDate(target.getDate() + 1);
    delay = target.getTime() - Date.now();
  }
  store.addEvent(taskId, 'auto_retry', { inMin: Math.round(delay / 60000) });
  store.addLog(taskId, '', '⏳ 检测到执行器限额,已排定 ' + Math.round(delay / 60000) + ' 分钟后自动重试失败步骤(第 ' + (n + 1) + '/2 次,期间也可手动重试)。');
  const tm = setTimeout(() => {
    try { const cur = store.getTask(taskId); if (cur && cur.status === 'failed') retryFailed(taskId, deps); } catch (e) {}
  }, delay);
  if (tm.unref) tm.unref(); // 不阻止进程退出(重启后由僵尸恢复兜底)
}

// 继续开发:在原任务上追加新一轮步骤(不新建任务),复用产出目录
async function continueTask(taskId, deps, text) {
  const { store } = deps;
  const t = store.getTask(taskId);
  store.setTaskStatus(taskId, 'planning');
  let cur = {}; try { cur = JSON.parse(t.plan); } catch (e) { cur = { steps: [] }; }
  cur.steps = cur.steps || [];
  const context = '【继续开发】当前工作目录已有之前产出的文件,先查看现有文件,在其基础上扩展/修改实现新需求(不要从零重写)。新需求: ' + text;
  const fresh = await deps.makePlan(context);
  const pfx = 'c' + ((t.steps || []).length + 1) + '_'; // 新一轮步骤 id 前缀,防与旧步骤冲突
  const ids = new Set();
  const collectIds = (arr) => (arr || []).forEach((s) => { ids.add(s.id); if (s.body) collectIds(s.body); });
  collectIds(fresh.steps);
  const rw = (s) => { const o = Object.assign({}, s, { id: pfx + s.id }); if (o.deps) o.deps = o.deps.filter((d) => ids.has(d)).map((d) => pfx + d); if (o.body) o.body = o.body.map(rw); return o; };
  const newSteps = (fresh.steps || []).map(rw);
  const merged = { task: t.text, steps: cur.steps.concat(newSteps) };
  store.setPlan(taskId, merged);
  if (store.addEvent) store.addEvent(taskId, 'continue', { text, steps: newSteps.length });
  const top = new Set(merged.steps.map((s) => s.id));
  const seedDone = {};
  store.doneSteps(taskId).forEach((s) => { if (top.has(s.step_id)) seedDone[s.step_id] = { output: s.output || '', success: true }; });
  return execute(taskId, merged, deps, { seedDone });
}

async function execute(taskId, plan, deps, opts) {
  const { store, adapters, workspace, onEvent, runs } = deps;
  const rec = runs && (runs.get(taskId) || (runs.set(taskId, { cancelled: false, children: new Set() }), runs.get(taskId))) || { cancelled: false, children: new Set() };
  const task = store.getTask(taskId);
  store.setTaskStatus(taskId, 'running');

  const agentOf = {};
  const collect = (steps) => steps.forEach((s) => { if (s.body) collect(s.body); else agentOf[s.id] = s.agent; });
  collect(plan.steps || []);

  // 任务简报:让员工知道全局与自己在流水线中的位置(上游谁/下游谁)
  const flat = plan.steps || [];
  const downOf = {}; flat.forEach((s) => (s.deps || []).forEach((d) => { (downOf[d] = downOf[d] || []).push(s.id); }));
  const posOf = (sid) => { let i = flat.findIndex((s) => s.id === sid); if (i < 0) i = flat.findIndex((s) => s.body && s.body.some((b) => b.id === sid)); return i; };
  const brief = (sid) => {
    const i = posOf(sid); if (i < 0) return '';
    const s = flat[i]; const down = downOf[s.id] || [];
    return '总任务: ' + (task.text || '') + '\n你负责流水线第 ' + (i + 1) + '/' + flat.length + ' 步「' + sid + '」'
      + ((s.deps && s.deps.length) ? ',上游: ' + s.deps.join(', ') : '')
      + (down.length ? ',你的产出将交接给: ' + down.join(', ') : ',你是最后一步,交付即收尾') + '。';
  };

  let models = null; try { models = task.models ? JSON.parse(task.models) : null; } catch (e) {} // 用户选的大模型:{执行器id:模型}
  let pending = null;
  const ctx = {
    adapters, workspace, brief, models,
    preamble: task.ask ? ASK : AUTONOMY,
    askMode: !!task.ask,
    seedDone: opts.seedDone || null,
    answers: opts.answers || null,
    isCancelled: () => rec.cancelled,
    onChild: (child) => rec.children.add(child),
    onUsage: (stepId, agent, u) => { store.addUsage(taskId, stepId, agent, u); emit(onEvent, taskId, stepId, 'usage', u); },
    onResult: (stepId, out) => {
      store.setStepOutput(taskId, stepId, (out || '').slice(-2000));
      if (/hit your session limit|rate limit|usage limit/i.test(out || '')) {
        store.addLog(taskId, stepId, '⚠ 执行器会话限额(非任务本身错误)。限额重置后在任务详情点「↻ 重试失败步骤」续跑,已完成步骤不会重跑。');
      }
    },
    onDecision: (stepId, q) => { pending = { stepId, q }; },
    onLog: (stepId, line) => { store.addLog(taskId, stepId, line); emit(onEvent, taskId, stepId, 'log', line, agentOf[stepId]); },
    onStatus: (stepId, status) => { store.setStep(taskId, stepId, agentOf[stepId] || '', status, null); if (store.addEvent) store.addEvent(taskId, 'status', { step: stepId, v: status }); emit(onEvent, taskId, stepId, 'status', status, agentOf[stepId]); },
  };

  try {
    const done = await runPlan(plan, ctx);
    if (pending) { // 有步骤需人决策:暂停等回答
      store.setTaskDecision(taskId, pending.stepId, pending.q);
      store.setTaskStatus(taskId, 'awaiting_input');
      if (store.addEvent) store.addEvent(taskId, 'task', 'awaiting_input');
      emit(onEvent, taskId, null, 'task', 'awaiting_input');
      return;
    }
    const seeded = opts.seedDone || {};
    const ok = !rec.cancelled && (plan.steps || []).every((s) => (done[s.id] || seeded[s.id]) && (done[s.id] || seeded[s.id]).success);
    const final = rec.cancelled ? 'cancelled' : (ok ? 'done' : 'failed');
    store.setTaskStatus(taskId, final);
    if (store.addEvent) store.addEvent(taskId, 'task', final);
    emit(onEvent, taskId, null, 'task', final);
    if (final === 'failed') { try { scheduleAutoRetry(taskId, deps); } catch (e) {} }
    if (final === 'done' || final === 'failed') harvestExperience(taskId, deps).catch(() => {}); // 异步复盘,不阻塞
  } catch (e) {
    store.setTaskStatus(taskId, 'failed');
    emit(onEvent, taskId, null, 'task', 'failed: ' + e.message);
  } finally {
    if (runs) runs.delete(taskId);
  }
}

function emit(onEvent, taskId, stepId, type, data, agent) {
  if (onEvent) onEvent({ taskId, stepId, type, data, agent });
}

module.exports = { runTask, runApproved, resumeTask, continueTask, retryFailed, scheduleAutoRetry, harvestExperience };
