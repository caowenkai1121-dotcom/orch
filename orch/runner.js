const { runPlan } = require('./engine');

// 串起:出 plan → 落库 → 执行(日志/状态/usage 实时回调 onEvent + 落库) → 收尾
async function runTask(taskId, deps) {
  const { store, adapters, workspace, onEvent, makePlan, runs } = deps;
  const rec = runs && (runs.get(taskId) || (runs.set(taskId, { cancelled: false, children: new Set() }), runs.get(taskId))) || { cancelled: false, children: new Set() };
  store.setTaskStatus(taskId, 'planning');
  const task = store.getTask(taskId);
  const plan = await makePlan(task.text);
  store.setPlan(taskId, plan);
  if (store.addEvent) store.addEvent(taskId, 'plan', { steps: (plan.steps || []).length });
  store.setTaskStatus(taskId, 'running');
  emit(onEvent, taskId, null, 'plan', plan);

  const agentOf = {};
  const collect = (steps) => steps.forEach((s) => {
    if (s.body) collect(s.body); else agentOf[s.id] = s.agent;
  });
  collect(plan.steps);

  const ctx = {
    adapters,
    workspace,
    isCancelled: () => rec.cancelled,
    onChild: (child) => rec.children.add(child),
    onUsage: (stepId, agent, u) => {
      store.addUsage(taskId, stepId, agent, u);
      emit(onEvent, taskId, stepId, 'usage', u);
    },
    onLog: (stepId, line) => {
      store.addLog(taskId, stepId, line);
      emit(onEvent, taskId, stepId, 'log', line, agentOf[stepId]);
    },
    onStatus: (stepId, status) => {
      store.setStep(taskId, stepId, agentOf[stepId] || '', status, null);
      if (store.addEvent) store.addEvent(taskId, 'status', { step: stepId, v: status });
      emit(onEvent, taskId, stepId, 'status', status, agentOf[stepId]);
    },
  };

  try {
    const done = await runPlan(plan, ctx);
    // 取消优先;否则顶层每步都成功才算 done(含 loop 步骤:跑到 max 仍未 pass 则 success=false)
    const ok = !rec.cancelled && plan.steps.every((s) => done[s.id] && done[s.id].success);
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

module.exports = { runTask };
