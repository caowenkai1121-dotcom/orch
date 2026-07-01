const { runPlan } = require('./engine');

// 串起:出 plan → (审批模式则暂停待批,否则执行)
async function runTask(taskId, deps) {
  const { store, onEvent, makePlan } = deps;
  store.setTaskStatus(taskId, 'planning');
  const task = store.getTask(taskId);
  const plan = await makePlan(task.text);
  store.setPlan(taskId, plan);
  if (store.addEvent) store.addEvent(taskId, 'plan', { steps: (plan.steps || []).length });
  emit(onEvent, taskId, null, 'plan', plan);
  if (task.approve) { // 审批模式:出 plan 后暂停,等 /approve
    store.setTaskStatus(taskId, 'awaiting');
    if (store.addEvent) store.addEvent(taskId, 'task', 'awaiting');
    emit(onEvent, taskId, null, 'task', 'awaiting');
    return;
  }
  return execute(taskId, plan, deps);
}

// 用(可能被编辑过的)plan 执行,审批批准后由 server 调用
function runApproved(taskId, deps, plan) {
  deps.store.setPlan(taskId, plan);
  if (deps.store.addEvent) deps.store.addEvent(taskId, 'task', 'approved');
  return execute(taskId, plan, deps);
}

async function execute(taskId, plan, deps) {
  const { store, adapters, workspace, onEvent, runs } = deps;
  const rec = runs && (runs.get(taskId) || (runs.set(taskId, { cancelled: false, children: new Set() }), runs.get(taskId))) || { cancelled: false, children: new Set() };
  store.setTaskStatus(taskId, 'running');

  const agentOf = {};
  const collect = (steps) => steps.forEach((s) => { if (s.body) collect(s.body); else agentOf[s.id] = s.agent; });
  collect(plan.steps || []);

  const ctx = {
    adapters,
    workspace,
    isCancelled: () => rec.cancelled,
    onChild: (child) => rec.children.add(child),
    onUsage: (stepId, agent, u) => { store.addUsage(taskId, stepId, agent, u); emit(onEvent, taskId, stepId, 'usage', u); },
    onLog: (stepId, line) => { store.addLog(taskId, stepId, line); emit(onEvent, taskId, stepId, 'log', line, agentOf[stepId]); },
    onStatus: (stepId, status) => { store.setStep(taskId, stepId, agentOf[stepId] || '', status, null); if (store.addEvent) store.addEvent(taskId, 'status', { step: stepId, v: status }); emit(onEvent, taskId, stepId, 'status', status, agentOf[stepId]); },
  };

  try {
    const done = await runPlan(plan, ctx);
    const ok = !rec.cancelled && (plan.steps || []).every((s) => done[s.id] && done[s.id].success);
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

module.exports = { runTask, runApproved };
