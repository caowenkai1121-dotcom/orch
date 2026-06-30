const { runPlan } = require('./engine');

// 串起:出 plan → 落库 → 执行(日志/状态实时回调 onEvent + 落库) → 收尾
async function runTask(taskId, deps) {
  const { store, adapters, workspace, onEvent, makePlan } = deps;
  store.setTaskStatus(taskId, 'planning');
  const task = store.getTask(taskId);
  const plan = await makePlan(task.text);
  store.setPlan(taskId, plan);
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
    onLog: (stepId, line) => {
      store.addLog(taskId, stepId, line);
      emit(onEvent, taskId, stepId, 'log', line);
    },
    onStatus: (stepId, status) => {
      store.setStep(taskId, stepId, agentOf[stepId] || '', status, null);
      emit(onEvent, taskId, stepId, 'status', status);
    },
  };

  try {
    const done = await runPlan(plan, ctx);
    // 顶层每步都成功才算 done(含 loop 步骤:跑到 max 仍未 pass 则 success=false)
    const ok = plan.steps.every((s) => done[s.id] && done[s.id].success);
    store.setTaskStatus(taskId, ok ? 'done' : 'failed');
    emit(onEvent, taskId, null, 'task', ok ? 'done' : 'failed');
  } catch (e) {
    store.setTaskStatus(taskId, 'failed');
    emit(onEvent, taskId, null, 'task', 'failed: ' + e.message);
  }
}

function emit(onEvent, taskId, stepId, type, data) {
  if (onEvent) onEvent({ taskId, stepId, type, data });
}

module.exports = { runTask };
