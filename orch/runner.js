const { runPlan, AUTONOMY, ASK, REPLAN } = require('./engine');
const { metaDir } = require('./workspace'); // 复盘 LLM 的中性 cwd,隔离误写
const fs = require('fs');
const path = require('path');

// —— 产出版本化(参考 Conductor/vibe-kanban):非 git 产出目录自动 git 化,每步完成自动 commit ——
// 每步一个 commit → 任务详情「改动」页可审查每步/每轮改了什么。worktree 任务(已是 git)不动,归用户管。
const { execSync } = require('child_process');
function gitOut(dir, cmd) { return execSync(cmd, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
function ensureOutputGit(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false;
    if (fs.existsSync(path.join(dir, '.git'))) return true; // 已是独立仓(含我们 init 过的)
    // 在祖先 git 仓内(如 worktree 任务或 data 在项目仓里):仅当该目录被祖先忽略才安全地建嵌套仓
    try {
      gitOut(dir, 'git rev-parse --show-toplevel');
      try { execSync('git check-ignore -q .', { cwd: dir, stdio: 'ignore' }); } catch (e) { return false; } // 未被忽略:别乱建
    } catch (e) { /* 不在任何仓:直接 init */ }
    execSync('git init -q', { cwd: dir, stdio: 'ignore' });
    return true;
  } catch (e) { return false; }
}
// 按 mtime 归属本步真实产出文件数(独立于 git 暂存,免并行步共享目录 git add -A 互相污染绩效)。
// 排除引擎/团队共享文件(task_plan.md/findings.md 每步被引擎重写,不是某步的 agent 产出)。
function countRecentFiles(dir, sinceMs) {
  let n = 0;
  try {
    if (!dir || !fs.existsSync(dir)) return 0;
    const skipName = new Set(['.git', 'node_modules', '.playwright-mcp', 'task_plan.md', 'findings.md', 'CLAUDE.md', 'AGENTS.md']);
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (skipName.has(e.name)) continue; const fp = path.join(d, e.name); if (e.isDirectory()) walk(fp); else { try { if (fs.statSync(fp).mtimeMs >= sinceMs) n++; } catch (x) {} } } };
    walk(dir);
  } catch (e) {}
  return n;
}
function commitStep(dir, label) {
  try {
    if (!dir || !fs.existsSync(path.join(dir, '.git'))) return { files: 0 };
    execSync('git add -A', { cwd: dir, stdio: 'ignore' });
    const staged = execSync('git diff --cached --name-only', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (!staged) return { files: 0 }; // 无改动:该步没产出文件
    execSync('git -c user.name=orch -c user.email=orch@local commit -q -m ' + JSON.stringify(label), { cwd: dir, stdio: 'ignore' });
    return { files: staged.split('\n').filter(Boolean).length };
  } catch (e) { return { files: 0 }; }
}
// 目标/阶段状态/产出摘要/错误表,由 DB 状态渲染(幂等,永远准确);员工经简报可见,下游随时读全局进展。
function writePlanFile(taskId, store, dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return;
    const t = store.getTask(taskId);
    let plan = {}; try { plan = JSON.parse(t.plan) || {}; } catch (e) { return; }
    const st = {}; (t.steps || []).forEach((s) => { st[s.step_id] = s; });
    const fileN = {}; store.getEvents(taskId).forEach((e) => { if (e.type === 'files') { try { const d = JSON.parse(e.data); fileN[d.step] = d.n; } catch (x) {} } });
    const mark = { done: '✓ 完成', running: '▶ 进行中', failed: '✗ 失败' };
    const flat = [];
    const walk = (arr, loopTag) => (arr || []).forEach((s) => { if (s.body) walk(s.body, '(质量环)'); else flat.push({ id: s.id, role: s.role || s.agent, tag: loopTag || '' }); });
    walk(plan.steps);
    const lines = ['# 任务计划(引擎自动维护,请勿手改)', '', '## 目标', t.text || '', '', '## 阶段'];
    flat.forEach((s, i) => {
      const row = st[s.id] || {};
      const summary = (row.output || '').replace(/\s+/g, ' ').slice(-160);
      const fn = fileN[s.id];
      lines.push('### ' + (i + 1) + '. ' + s.id + ' — ' + (s.role || '') + ' ' + s.tag);
      lines.push('- 状态: ' + (mark[row.status] || '待执行') + (row.status === 'done' ? (fn > 0 ? ' · 📄 ' + fn + ' 文件' : ' · ⚠ 无文件产出') : ''));
      if (summary) lines.push('- 产出摘要: ' + summary);
    });
    const errs = (t.steps || []).filter((s) => s.status === 'failed' && s.output);
    if (errs.length) {
      lines.push('', '## 错误记录(不要重复同样的失败做法,换思路)', '', '| 步骤 | 错误摘要 |', '|------|----------|');
      errs.forEach((s) => lines.push('| ' + s.step_id + ' | ' + String(s.output).replace(/\s+/g, ' ').replace(/\|/g, '/').slice(-140) + ' |'));
    }
    lines.push('', '> 团队共享发现/决策/踩坑请写 findings.md');
    fs.writeFileSync(path.join(dir, 'task_plan.md'), lines.join('\n'), 'utf8');
    // findings.md:初始化一次,内容归员工维护
    const fp = path.join(dir, 'findings.md');
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, '# 团队发现与决策(findings)\n\n> 所有员工共享的外部记忆:重要发现、技术决策(含理由)、踩过的坑,完成工作前追加写入。\n\n', 'utf8');
  } catch (e) { /* 文件化规划失败不影响执行 */ }
}

// 出 plan →(审批模式暂停待批,否则执行)
async function runTask(taskId, deps) {
  const { store, onEvent, makePlan, runs } = deps;
  store.setTaskStatus(taskId, 'planning');
  const task = store.getTask(taskId);
  // 提前建运行态,让规划期(LLM 拆分)的子进程可被取消
  const rec = runs && (runs.get(taskId) || (runs.set(taskId, { cancelled: false, paused: false, children: new Set(), skip: new Set(), notes: [] }), runs.get(taskId)));
  const plan = await makePlan(task.text, rec ? (c) => rec.children.add(c) : undefined);
  if (rec && rec.cancelled) return; // 规划期间被取消:不继续
  store.setPlan(taskId, plan);
  if (plan && plan.degraded && store.addTaskMsg) store.addTaskMsg(taskId, 'system', '⚠ 员工/部门模式规划未成,已回退到单执行器直做(产出可能不如团队协作;方向没问题可等结果,否则「重新规划」再试)。');
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
  let plan = { steps: [] }; try { plan = JSON.parse(t.plan) || { steps: [] }; } catch (e) { plan = { steps: [] }; } // JSON.parse(null)→null,须兜底防 plan.steps 崩(无plan的失败任务)
  const top = new Set((plan.steps || []).map((s) => s.id));
  const seedDone = {};
  store.doneSteps(taskId).forEach((s) => { if (top.has(s.step_id)) seedDone[s.step_id] = { output: s.output || '', success: true }; });
  store.clearTaskDecision(taskId);
  if (store.addEvent) store.addEvent(taskId, 'decision', { step: stepId, answer });
  return execute(taskId, plan, deps, { seedDone, answers: { [stepId]: answer } });
}

// 重试失败步骤:已完成步骤不重跑,只重跑失败/未完成的(限额恢复后一键续跑)
// 收集失败步骤的上次输出 → 重跑时注入,让员工看到自己上次为何失败
function failNotes(store, taskId) {
  const m = {};
  (store.getTask(taskId).steps || []).forEach((s) => { if (s.status === 'failed' && s.output) m[s.step_id] = String(s.output).slice(-800); });
  return m;
}
function retryFailed(taskId, deps, initialNote) {
  const { store } = deps;
  const t = store.getTask(taskId);
  let plan = { steps: [] }; try { plan = JSON.parse(t.plan) || { steps: [] }; } catch (e) { plan = { steps: [] }; } // JSON.parse(null)→null,须兜底防 plan.steps 崩(无plan的失败任务)
  const top = new Set((plan.steps || []).map((s) => s.id)); // 只 seed 顶层步骤(loop 子步骤不算,防完成度误判)
  const seedDone = {};
  store.doneSteps(taskId).forEach((s) => { if (top.has(s.step_id)) seedDone[s.step_id] = { output: s.output || '', success: true }; });
  if (store.addEvent) store.addEvent(taskId, 'retry', { skip: Object.keys(seedDone).length });
  return execute(taskId, plan, deps, { seedDone, initialNote, lastFail: failNotes(store, taskId) });
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
  // 复盘时机:同一结局只复盘一次,但"失败过→重试成功升级到 done"允许补一次(学到修复经验,契合越用越聪明)
  const hv = store.getEvents(taskId).filter((e) => e.type === 'harvest').map((e) => { try { return JSON.parse(e.data).at; } catch (x) { return ''; } });
  if (hv.includes('done')) return;              // 成功态已复盘:成功经验已学,不再复盘
  if (t.status !== 'done' && hv.length) return; // 失败态且已复盘过:不反复复盘同一失败
  store.addEvent(taskId, 'harvest', { at: t.status });
  const fileN = {}; store.getEvents(taskId).forEach((e) => { if (e.type === 'files') { try { const d = JSON.parse(e.data); fileN[d.step] = d.n; } catch (x) {} } });
  const lines = (t.steps || []).filter((s) => stepRole[s.step_id]).map((s) =>
    '步骤 ' + s.step_id + ' | 员工 ' + stepRole[s.step_id] + ' | 结果 ' + s.status + ' | 产出文件 ' + (fileN[s.step_id] != null ? fileN[s.step_id] : '?') + ' | 产出摘要: ' + String(s.output || '').replace(/\s+/g, ' ').slice(-400));
  // 已有经验注入:让复盘避开重复(否则近似重复会被 appendRoleMemo 去重丢弃,白白浪费一次复盘)
  const prior = [...new Set(Object.values(stepRole))].map((rid) => { const r = store.getRole && store.getRole(rid); return (r && r.memo) ? rid + ': ' + r.memo.replace(/\n/g, ' | ') : ''; }).filter(Boolean);
  const priorTxt = prior.length ? '\n\n这些员工已有的经验(生成时务必避免与之语义重复,只写真正新增的洞见;若无新增就省略该员工):\n' + prior.join('\n') : '';
  const prompt = '你是团队复盘专家。任务「' + (t.text || '') + '」已结束(状态 ' + t.status + ')。各步骤(产出文件=该步真实改动的文件数,0=声称做了却没落盘,是要记的坑):\n' + lines.join('\n') + priorTxt
    + '\n\n输出 JSON:{"employees":{"<员工id>":"一条≤60字可复用经验(成功套路或踩过的坑,具体不空话;若该员工产出文件为0要点明别只描述不落盘)"},"chief":"一条≤80字调度复盘(步骤划分/指派/质量门下次怎么改进)"}。'
    + '只为值得记的员工写经验(没有就省略该员工),只输出 JSON。';
  try {
    const s = require('./engine').sem(); await s.acquire(); // 复盘 LLM 也过并发信号量
    let output; try { ({ output } = await adapters.claude.run({ prompt, workdir: metaDir(), onLine: () => {} })); } finally { s.release(); }
    const j = JSON.parse((output.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    const names = [];
    Object.entries(j.employees || {}).forEach(([rid, line]) => { store.appendRoleMemo(rid, line); const r = store.getRole && store.getRole(rid); names.push(r ? r.name : rid); });
    if (j.chief) { store.appendRoleMemo('chief-orchestrator', j.chief); names.push('总调度'); }
    if (names.length && store.addTaskMsg) store.addTaskMsg(taskId, 'system', '🧠 任务复盘完成,已更新经验:' + names.join('、') + '(下次相关任务会复用)。');
  } catch (e) { /* 复盘失败不影响任务 */ }
}

// —— 会话化控制面 ——
function pauseTask(taskId, runs, store) {
  const rec = runs.get(taskId); if (!rec) return false;
  rec.paused = true;
  store.addTaskMsg(taskId, 'system', '⏸ 已请求暂停:当前步骤跑完后不再启动新步骤。');
  return true;
}
function skipStep(taskId, runs, store, stepId) {
  const rec = runs.get(taskId); if (!rec) return false;
  rec.skip.add(stepId);
  store.addTaskMsg(taskId, 'system', '⏭ 步骤 ' + stepId + ' 将被跳过(轮到它时直接标记完成)。');
  return true;
}
function noteToTask(taskId, runs, text) {
  const rec = runs.get(taskId); if (!rec) return false;
  rec.notes.push(text);
  return true;
}
// 重跑单步:除该步外已完成的全部 seed,只重跑它(及其下游未完成的)
function rerunStep(taskId, deps, stepId) {
  const { store } = deps;
  const t = store.getTask(taskId);
  let plan = { steps: [] }; try { plan = JSON.parse(t.plan) || { steps: [] }; } catch (e) { plan = { steps: [] }; } // JSON.parse(null)→null,须兜底防 plan.steps 崩(无plan的失败任务)
  const top = new Set((plan.steps || []).map((s) => s.id));
  const seedDone = {};
  store.doneSteps(taskId).forEach((s) => { if (top.has(s.step_id) && s.step_id !== stepId) seedDone[s.step_id] = { output: s.output || '', success: true }; });
  const lastFail = failNotes(store, taskId);
  store.setStep(taskId, stepId, '', 'pending', null); // 清该步状态
  if (store.addEvent) store.addEvent(taskId, 'rerun', { step: stepId });
  store.addTaskMsg(taskId, 'system', '↻ 重跑步骤 ' + stepId + '(其余已完成步骤保留)。');
  return execute(taskId, plan, deps, { seedDone, lastFail });
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
  const mins = Math.round(delay / 60000);
  const at = new Date(Date.now() + delay); const hhmm = ('0' + at.getHours()).slice(-2) + ':' + ('0' + at.getMinutes()).slice(-2);
  store.addEvent(taskId, 'auto_retry', { inMin: mins });
  store.addLog(taskId, '', '⏳ 检测到执行器限额,已排定 ' + mins + ' 分钟后自动重试失败步骤(第 ' + (n + 1) + '/2 次,期间也可手动重试)。');
  // 同时在任务对话可见(不只埋在步骤日志),让操作者一眼知系统会自愈
  if (store.addTaskMsg) store.addTaskMsg(taskId, 'system', '⏳ 执行器限额,已排定约 ' + mins + ' 分钟后(~' + hhmm + ')自动重试失败步骤(第 ' + (n + 1) + '/2 次),期间也可手动重试。');
  const tm = setTimeout(() => {
    try { const cur = store.getTask(taskId); if (cur && cur.status === 'failed') retryFailed(taskId, deps); } catch (e) {}
  }, delay);
  if (tm.unref) tm.unref(); // 不阻止进程退出(重启后由僵尸恢复兜底)
}

// 继续开发:在原任务上追加新一轮步骤(不新建任务),复用产出目录
async function continueTask(taskId, deps, text) {
  const { store, runs } = deps;
  const t = store.getTask(taskId);
  store.setTaskStatus(taskId, 'planning');
  const rec = runs && (runs.get(taskId) || (runs.set(taskId, { cancelled: false, paused: false, children: new Set(), skip: new Set(), notes: [] }), runs.get(taskId)));
  let cur = {}; try { cur = JSON.parse(t.plan) || {}; } catch (e) { cur = { steps: [] }; } // 同上,防 null
  cur.steps = cur.steps || [];
  const context = '【继续开发】当前工作目录已有之前产出的文件,先查看现有文件,在其基础上扩展/修改实现新需求(不要从零重写)。新需求: ' + text;
  const fresh = await deps.makePlan(context, rec ? (c) => rec.children.add(c) : undefined);
  if (rec && rec.cancelled) return; // 规划期间被取消
  if (fresh && fresh.degraded && store.addTaskMsg) store.addTaskMsg(taskId, 'system', '⚠ 本轮继续开发的员工/部门规划未成,已回退单执行器直做(产出可能不如团队协作)。'); // 与 runTask 一致
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

// #12 动态重规划:某步发 NEED_REPLAN(实现现实偏离原计划)→ 保留已完成步,就剩余工作重新拆解接进活 DAG。
// 复用 continueTask 的拼接(前缀新步 id 防冲突 + seedDone 续跑);改计划前快照旧计划(#13 可回滚);每任务上限3次防死循环。
async function replanRemaining(taskId, deps, plan, done, divergedStepId, reason) {
  const { store, runs, onEvent } = deps;
  const finishFail = (msg) => { store.setTaskStatus(taskId, 'failed'); if (store.addTaskMsg) store.addTaskMsg(taskId, 'system', msg); if (store.addEvent) store.addEvent(taskId, 'task', 'failed'); emit(onEvent, taskId, null, 'task', 'failed'); };
  if (!deps.makePlan) return finishFail('⚠ 收到重规划信号,但当前执行路径无规划器,无法自动重规划。请「继续开发」或「重试失败步骤」。');
  const t = store.getTask(taskId);
  const n = store.getEvents(taskId).filter((e) => e.type === 'replan').length;
  if (n >= 3) return finishFail('⚠ 已达动态重规划上限(3次),停止以防失控。请人工介入(继续开发/重新规划)。');
  let oldPlan = {}; try { oldPlan = JSON.parse(t.plan) || {}; } catch (e) {}
  const ver = store.savePlanVersion(taskId, oldPlan, 'replan@' + divergedStepId + ': ' + String(reason).slice(0, 200)); // #13 快照旧计划
  store.addEvent(taskId, 'replan', { step: divergedStepId, reason: String(reason).slice(0, 200), version: ver });
  store.setTaskStatus(taskId, 'planning');
  emit(onEvent, taskId, null, 'task', 'planning');
  const rec = runs && runs.get(taskId);
  // 保留已成功完成的顶层步 + 其交接摘要(喂 replan LLM)
  const okIds = new Set(Object.keys(done).filter((id) => done[id] && done[id].success));
  const keep = (plan.steps || []).filter((s) => okIds.has(s.id));
  const doneSummary = keep.map((s) => s.id + ': ' + String((done[s.id] && done[s.id].output) || '').replace(/\s+/g, ' ').slice(-200)).join('\n');
  const context = '【重规划】原任务已完成部分步骤,但执行到「' + divergedStepId + '」时发现实现现实与原计划不符,需就剩余工作重新规划。\n'
    + '原任务目标: ' + (t.text || '') + '\n'
    + (doneSummary ? '已完成步骤(交接摘要,产出已在工作目录与 findings.md):\n' + doneSummary + '\n' : '')
    + '偏离原因: ' + reason + '\n'
    + '请只对【达成原目标所需的剩余工作】重新拆解成新步骤:先查看现有产出文件,在其基础上扩展/修正(不从零重写),不要重复已完成的步骤。';
  let fresh;
  try { fresh = await deps.makePlan(context, rec ? (c) => rec.children.add(c) : undefined); }
  catch (e) { return finishFail('⚠ 重规划失败:' + ((e && e.message) || e) + '。请人工介入。'); }
  if (rec && rec.cancelled) return;
  const pfx = 'r' + (n + 1) + '_'; // 重规划轮次前缀,防与已完成步 id 冲突
  const ids = new Set(); const collectIds = (arr) => (arr || []).forEach((s) => { ids.add(s.id); if (s.body) collectIds(s.body); }); collectIds(fresh.steps);
  const rw = (s) => { const o = Object.assign({}, s, { id: pfx + s.id }); if (o.deps) o.deps = o.deps.filter((d) => ids.has(d)).map((d) => pfx + d); if (o.body) o.body = o.body.map(rw); return o; };
  const newSteps = (fresh.steps || []).map(rw);
  if (!newSteps.length) return finishFail('⚠ 重规划未产出新步骤,停止。请人工介入。');
  const merged = { task: t.text, steps: keep.concat(newSteps) };
  store.setPlan(taskId, merged);
  if (store.addTaskMsg) store.addTaskMsg(taskId, 'system', '🔄 已就剩余工作重规划(第 ' + (n + 1) + '/3 次,旧计划存为 v' + ver + '):保留 ' + keep.length + ' 个已完成步,新增 ' + newSteps.length + ' 步。原因:' + reason);
  // 审批门复用:approve 任务停在待审批等人批准新计划,否则自主续跑
  if (t.approve) {
    store.setTaskStatus(taskId, 'awaiting');
    if (store.addEvent) store.addEvent(taskId, 'task', 'awaiting');
    emit(onEvent, taskId, null, 'task', 'awaiting');
    return;
  }
  const top = new Set(merged.steps.map((s) => s.id));
  const seedDone = {};
  store.doneSteps(taskId).forEach((s) => { if (top.has(s.step_id)) seedDone[s.step_id] = { output: s.output || '', success: true }; });
  return execute(taskId, merged, deps, { seedDone });
}

async function execute(taskId, plan, deps, opts) {
  const { store, adapters, workspace, onEvent, runs } = deps;
  const fresh = { cancelled: false, paused: false, children: new Set(), skip: new Set(), notes: [] };
  const rec = runs && (runs.get(taskId) || (runs.set(taskId, fresh), fresh)) || fresh;
  rec.paused = false; rec.skip = rec.skip || new Set(); rec.notes = rec.notes || [];
  if (opts.initialNote) rec.notes.push(opts.initialNote); // 恢复/重试时随带的用户指令
  const task = store.getTask(taskId);
  store.setTaskStatus(taskId, 'running');

  const agentOf = {}; const roleOf = {}; const stepStart = {}; // stepStart:本步 running 时刻,用于按 mtime 归属产出
  const collect = (steps) => steps.forEach((s) => { if (s.body) collect(s.body); else { agentOf[s.id] = s.agent; if (s.role) roleOf[s.id] = s.role; } });
  collect(plan.steps || []);

  // 任务简报:让员工知道全局与自己在流水线中的位置(上游谁/下游谁)
  const flat = plan.steps || [];
  const downOf = {}; flat.forEach((s) => (s.deps || []).forEach((d) => { (downOf[d] = downOf[d] || []).push(s.id); }));
  const posOf = (sid) => { let i = flat.findIndex((s) => s.id === sid); if (i < 0) i = flat.findIndex((s) => s.body && s.body.some((b) => b.id === sid)); return i; };
  const projKnow = (store.projectKnowledge ? store.projectKnowledge(task.project) : '').slice(0, 1500); // 本项目约定,注入每步简报
  const brief = (sid) => {
    const i = posOf(sid); if (i < 0) return '';
    const s = flat[i]; const down = downOf[s.id] || [];
    return '总任务: ' + (task.text || '') + '\n你负责流水线第 ' + (i + 1) + '/' + flat.length + ' 步「' + sid + '」'
      + ((s.deps && s.deps.length) ? ',上游: ' + s.deps.join(', ') : '')
      + (down.length ? ',你的产出将交接给: ' + down.join(', ') : ',你是最后一步,交付即收尾') + '。'
      + (projKnow ? '\n【本项目约定】(同项目所有任务遵守)\n' + projKnow : '');
  };

  const overTaskBudget = () => task.budget > 0 && (store.taskUsage(taskId).cost || 0) >= task.budget;
  const overDailyBudget = () => { const c = Number(process.env.ORCH_DAILY_BUDGET) || 0; return c > 0 && (store.usageToday().cost || 0) >= c; };
  let models = null; try { models = task.models ? JSON.parse(task.models) : null; } catch (e) {} // 用户选的大模型:{执行器id:模型}
  let pending = null;
  let pendingReplan = null; // #12 某步发 NEED_REPLAN → runPlan 收尾后触发重规划
  const ctx = {
    adapters, workspace, brief, models,
    preamble: (task.ask ? ASK : AUTONOMY) + (task.replan ? REPLAN : ''),
    askMode: !!task.ask,
    replanMode: !!task.replan,
    seedDone: opts.seedDone || null,
    answers: opts.answers || null,
    isCancelled: () => rec.cancelled,
    isPaused: () => rec.paused,
    // 成本上限(0=不限):任务级 或 全局日级。执行期都查 → retry/continue/resume 及跑中超限都会收尾停(总护栏真正覆盖所有执行路径)
    overBudget: () => overTaskBudget() || overDailyBudget(),
    skip: rec.skip,
    lastFail: opts.lastFail || null, // 重跑时该步上次的失败输出
    takeNotes: () => { const t = rec.notes.splice(0).join('\n'); return t; }, // 用户中途指令,注入即消费
    onChild: (child) => rec.children.add(child),
    onUsage: (stepId, agent, u) => { store.addUsage(taskId, stepId, agent, u); emit(onEvent, taskId, stepId, 'usage', u); },
    onResult: (stepId, out) => {
      store.setStepOutput(taskId, stepId, (out || '').slice(-2000));
      if (/hit your session limit|rate limit|usage limit/i.test(out || '')) {
        store.addLog(taskId, stepId, '⚠ 执行器会话限额(非任务本身错误)。限额重置后在任务详情点「↻ 重试失败步骤」续跑,已完成步骤不会重跑。');
      }
      writePlanFile(taskId, store, task.dir); // 产出摘要进 task_plan.md
    },
    onDecision: (stepId, q) => { pending = { stepId, q }; },
    onReplan: (stepId, reason) => { pendingReplan = { stepId, reason }; },
    onLog: (stepId, line) => { store.addLog(taskId, stepId, line); emit(onEvent, taskId, stepId, 'log', line, agentOf[stepId]); },
    onStatus: (stepId, status) => {
      store.setStep(taskId, stepId, agentOf[stepId] || '', status, null);
      if (store.addEvent) store.addEvent(taskId, 'status', { step: stepId, v: status });
      emit(onEvent, taskId, stepId, 'status', status, agentOf[stepId]);
      writePlanFile(taskId, store, task.dir);
      if (status === 'running') stepStart[stepId] = Date.now(); // 记开工时刻(供 mtime 归属)
      if (status === 'done') {
        const n = countRecentFiles(task.dir, stepStart[stepId] || 0); // 按 mtime 数本步产出(不受并行步 git add -A 污染)
        if (gitOk) commitStep(task.dir, '步骤 ' + stepId + ' 完成'); // 仍每步 commit 供改动审查(计数不再取其暂存数)
        if (store.addEvent) store.addEvent(taskId, 'files', { step: stepId, n });
        if (roleOf[stepId] && store.addRoleStat) store.addRoleStat(roleOf[stepId], n > 0); // 员工绩效(落盘/空转)
      }
    },
  };
  // #3 任务级稳定上下文落成 CLI 原生记忆文件(claude 读 CLAUDE.md,codex/其他读 AGENTS.md),CLI 启动自动加载。
  // 只写任务级稳定内容(总目标+项目约定):同任务各步共享目录且并发,每步动态 brief 仍走 -p,不落文件(否则并发步互相覆盖)。
  try {
    if (task.dir && fs.existsSync(task.dir)) {
      const ctxMd = '# 项目上下文(orch 自动注入,勿删)\n\n## 总任务目标\n' + (task.text || '') + '\n'
        + (projKnow ? '\n## 本项目约定(同项目所有任务遵守)\n' + projKnow + '\n' : '');
      for (const fn of ['CLAUDE.md', 'AGENTS.md']) { try { fs.writeFileSync(path.join(task.dir, fn), ctxMd, 'utf8'); } catch (e) {} }
    }
  } catch (e) {}
  writePlanFile(taskId, store, task.dir); // 开工先落计划文件(员工简报可见)
  const gitOk = ensureOutputGit(task.dir); // 产出版本化
  if (gitOk) commitStep(task.dir, '开工基线');

  try {
    const done = await runPlan(plan, ctx);
    if (pending) { // 有步骤需人决策:暂停等回答
      store.setTaskDecision(taskId, pending.stepId, pending.q);
      store.setTaskStatus(taskId, 'awaiting_input');
      if (store.addEvent) store.addEvent(taskId, 'task', 'awaiting_input');
      emit(onEvent, taskId, null, 'task', 'awaiting_input');
      return;
    }
    if (pendingReplan) return replanRemaining(taskId, deps, plan, done, pendingReplan.stepId, pendingReplan.reason); // #12 就剩余工作重规划并续跑
    const seeded = opts.seedDone || {};
    // 空计划且无已完成步骤 → 从未真正规划/执行(如被成本护栏拦下的 NULL-plan 任务);[].every()===true 会假判 done,须拦
    const noWork = (plan.steps || []).length === 0 && Object.keys(seeded).length === 0;
    const ok = !rec.cancelled && !noWork && (plan.steps || []).every((s) => (done[s.id] || seeded[s.id]) && (done[s.id] || seeded[s.id]).success);
    const stoppedByBudget = !ok && !noWork && !rec.cancelled && ctx.overBudget(); // 因成本上限停(暂停,可提预算后续跑)
    const final = rec.cancelled ? 'cancelled' : (ok ? 'done' : ((rec.paused || stoppedByBudget) ? 'paused' : 'failed'));
    store.setTaskStatus(taskId, final);
    if (store.addEvent) store.addEvent(taskId, 'task', final);
    emit(onEvent, taskId, null, 'task', final);
    if (final === 'failed' && !noWork) { try { scheduleAutoRetry(taskId, deps); } catch (e) {} } // noWork 无步骤可重试
    if (noWork) store.addTaskMsg(taskId, 'system', '⚠ 任务从未成功规划(可能被成本护栏拦下或规划失败),空计划无步骤可跑。请调高预算/ORCH_DAILY_BUDGET 后用「重新规划」重跑。');
    else if (stoppedByBudget) store.addTaskMsg(taskId, 'system', overDailyBudget()
      ? ('🛑 已达全局日成本上限 $' + (Number(process.env.ORCH_DAILY_BUDGET) || 0) + '(今日已花 $' + (store.usageToday().cost || 0).toFixed(3) + '),未启动步骤已暂停。次日0点(本地)重置或调高 ORCH_DAILY_BUDGET 后恢复。')
      : ('💰 已达任务成本上限 $' + task.budget + '(实际约 $' + (store.taskUsage(taskId).cost || 0).toFixed(3) + '),未启动的步骤已暂停。提高预算后点「继续」,或发消息恢复。'));
    else if (final === 'paused') store.addTaskMsg(taskId, 'system', '⏸ 任务已暂停(当前步骤已收尾)。发消息即恢复并注入指令,或点「继续」原样恢复。');
    if (final === 'done' || final === 'failed') harvestExperience(taskId, deps).catch(() => {}); // 异步复盘,不阻塞
  } catch (e) {
    store.setTaskStatus(taskId, 'failed');
    emit(onEvent, taskId, null, 'task', 'failed: ' + e.message);
  } finally {
    // 残留纠偏指令(无任何步骤消费)不静默丢弃:仅终态 done/failed 诚实告知(awaiting_input 仍有后续步骤,不误导)
    if (rec && rec.notes && rec.notes.length) {
      const cur = store.getTask(taskId);
      if (cur && (cur.status === 'done' || cur.status === 'failed')) store.addTaskMsg(taskId, 'system', '⚠ 你发的指令未生效——任务已无后续步骤可注入。点「继续开发」把它作为新一轮需求重述执行。');
    }
    if (runs) runs.delete(taskId);
  }
}

function emit(onEvent, taskId, stepId, type, data, agent) {
  if (onEvent) onEvent({ taskId, stepId, type, data, agent });
}

module.exports = { runTask, runApproved, resumeTask, continueTask, retryFailed, scheduleAutoRetry, harvestExperience, writePlanFile, ensureOutputGit, commitStep, countRecentFiles, pauseTask, skipStep, noteToTask, rerunStep, replanRemaining };
