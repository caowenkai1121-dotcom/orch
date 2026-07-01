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
  const seedDone = {};
  store.doneSteps(taskId).forEach((s) => { seedDone[s.step_id] = { output: s.output || '', success: true }; });
  store.clearTaskDecision(taskId);
  if (store.addEvent) store.addEvent(taskId, 'decision', { step: stepId, answer });
  return execute(taskId, plan, deps, { seedDone, answers: { [stepId]: answer } });
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
  const seedDone = {};
  store.doneSteps(taskId).forEach((s) => { seedDone[s.step_id] = { output: s.output || '', success: true }; });
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

  let pending = null;
  const ctx = {
    adapters, workspace,
    preamble: task.ask ? ASK : AUTONOMY,
    askMode: !!task.ask,
    seedDone: opts.seedDone || null,
    answers: opts.answers || null,
    isCancelled: () => rec.cancelled,
    onChild: (child) => rec.children.add(child),
    onUsage: (stepId, agent, u) => { store.addUsage(taskId, stepId, agent, u); emit(onEvent, taskId, stepId, 'usage', u); },
    onResult: (stepId, out) => store.setStepOutput(taskId, stepId, (out || '').slice(-2000)),
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

module.exports = { runTask, runApproved, resumeTask, continueTask };
