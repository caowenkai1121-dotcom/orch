// 把 orch 真实数据(tasks/steps/logs + agents/people 库)派生成 Maestro 前端数据形状。全部真实。
// agent/部门/人员均来自 SQLite;项目=按 task.project 聚合。

const DEPT_META = {
  dev: { name: '开发部', glyph: '</>', color: '#7C6FD9', soft: 'rgba(124,111,217,.2)', desc: '编写与重构代码、实现功能' },
  qa: { name: '测试 / QA 部', glyph: '✓', color: '#4F8BE8', soft: 'rgba(79,139,232,.2)', desc: '功能验证、回归与质量把关' },
};
const taskSk = (s) => ({ pending: 'queued', planning: 'planning', running: 'working', done: 'done', failed: 'failed', cancelled: 'cancelled', awaiting: 'awaiting', awaiting_input: 'awaiting_input', paused: 'paused', meeting: 'meeting' })[s] || 'queued';
const stepSk = (s) => ({ running: 'working', waiting: 'queued', done: 'done', failed: 'failed' })[s] || 'queued';

// 从 DB 构建 agentId → {dept,label,model,color,av,caps} 查找表
function roleMap(store) {
  const m = {};
  store.listAgents().forEach((a) => {
    let caps = []; try { caps = JSON.parse(a.caps); } catch (e) {}
    let args = []; try { args = JSON.parse(a.args); } catch (e) {}
    m[a.id] = { dept: a.dept || 'dev', label: a.name, model: a.model, color: a.color, av: a.avatar, caps, args, command: a.command, image: a.image || '', kind: a.kind || 'cli', enabled: a.enabled !== 0, defModel: a.default_model || '', defEffort: a.default_effort || '' };
  });
  return m;
}

// 步骤id → 员工id(从 plan JSON 提取,含 loop body)
function planRoleMap(t) {
  const m = {};
  let p = null; try { p = JSON.parse(t.plan); } catch (e) { return m; }
  const walk = (steps) => (steps || []).forEach((s) => { if (s.body) walk(s.body); else if (s.role) m[s.id] = s.role; });
  walk(p && p.steps);
  return m;
}
// 员工显示信息:{id → {name,emoji,color(部门色),dept,deptName}}
function roleView(store) {
  const dmeta = {}; store.listDepts().forEach((d) => { dmeta[d.id] = d; });
  const m = {};
  store.listRoles().forEach((r) => {
    const d = dmeta[r.dept] || {};
    m[r.id] = { name: r.name, emoji: r.emoji || '🧑‍💼', color: d.color || '#7C6FD9', dept: r.dept, deptName: d.name || r.dept, executor: r.executor };
  });
  return m;
}

function rel(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}
function isToday(iso) { if (!iso) return false; const d = new Date(iso), n = new Date(); return d.toDateString() === n.toDateString(); }

// 当前用户可见的项目集合(null=全部,管理员)
function visibleSet(store, user) {
  if (!user || user.admin) return null;
  const set = new Set();
  store.listTasks().forEach((t) => { if (t.owner === user.name) set.add(t.project || '默认项目'); });
  store.listGrants().forEach((g) => { if (g.user_id === user.id) set.add(g.project); });
  store.listProjects().forEach((p) => { if (p.owner === user.id) set.add(p.name); });
  return set;
}

function buildAll(store, user) {
  const ROLE = roleMap(store);
  const RV = roleView(store);                  // 员工视图:整个 buildAll 只算一次(87角色),各处复用
  const projRows = store.listProjects();       // 只查一次,循环内复用
  const usageMap = store.usageByTask();        // 一趟聚合,消除每任务 taskUsage 的 N+1
  const uOf = (id) => usageMap.get(id) || { input: 0, output: 0, cost: 0 };
  const vis = visibleSet(store, user);         // null=全部
  const tasks = store.listTasks().filter((t) => !vis || vis.has(t.project || '默认项目') || t.owner === (user && user.name));
  const visIds = new Set(tasks.map((t) => t.id));
  const steps = store.allSteps().filter((s) => visIds.has(s.task_id));
  const byTask = {}; steps.forEach((s) => { (byTask[s.task_id] = byTask[s.task_id] || []).push(s); });
  const taskById = {}; tasks.forEach((t) => { taskById[t.id] = t; });

  const progressOf = (tid) => { const ss = byTask[tid] || []; if (!ss.length) return 0; return Math.round(ss.filter((s) => s.status === 'done').length / ss.length * 100); };
  const agentsInTask = (tid) => { const set = {}; (byTask[tid] || []).forEach((s) => { if (s.agent && ROLE[s.agent]) set[s.agent] = 1; }); return Object.keys(set); };
  const lastLine = (tid, stepId) => { const rows = store.getLogs(tid); for (let i = rows.length - 1; i >= 0; i--) if (rows[i].step_id === stepId) return rows[i].line; return ''; };

  const agents = Object.keys(ROLE).map((id) => {
    const r = ROLE[id];
    const mine = steps.filter((s) => s.agent === id);
    const done = mine.filter((s) => s.status === 'done').length;
    const fail = mine.filter((s) => s.status === 'failed').length;
    const running = mine.find((s) => s.status === 'running');
    const cur = running ? taskById[running.task_id] : null;
    const tot = done + fail;
    // 正在扮演的员工(部门·角色)
    let empNow = '';
    if (running) {
      const sr = planRoleMap(store.getTask(running.task_id) || {});
      const emp = sr[running.step_id] && RV[sr[running.step_id]];
      if (emp) empNow = emp.emoji + ' ' + emp.deptName + '·' + emp.name;
    }
    return {
      id, name: r.label, type: id, dept: r.dept, enabled: r.enabled,
      defModel: r.defModel, defEffort: r.defEffort,
      command: r.command, args: r.args, image: r.image, kind: r.kind,
      color: r.color, avatar: r.av, soft: (r.color || '#7C6FD9') + '2b',
      status: running ? 'working' : 'idle',
      task: cur ? cur.text : '—', taskId: cur ? cur.id : '', empNow,
      action: running ? ((empNow ? empNow + ' · ' : '') + (lastLine(running.task_id, running.step_id) || ('执行 ' + running.step_id))) : '空闲 · 等待任务',
      actions: [], progress: cur ? progressOf(cur.id) : 0,
      model: r.model, success: tot ? Math.round(done / tot * 100) + '%' : '—', done,
      avg: (function () { const s = store.agentAvgSeconds ? store.agentAvgSeconds(id) : 0; return s > 0 ? (s >= 60 ? Math.floor(s / 60) + 'm' + (s % 60) + 's' : s + 's') : '—'; })(),
      cost: (function () { const c = store.agentTotals ? store.agentTotals(id).cost : 0; return c > 0 ? '$' + (Math.round(c * 1000) / 1000) : '—'; })(), caps: r.caps,
    };
  });

  // 部门:来自 departments 表(含空部门);employees=部门员工(角色)
  const boards = {};
  const allRoles = store.listRoles();
  const deptPools = store.allDeptExecutors();
  const depts = store.listDepts().map((d) => {
    const id = d.id;
    const employees = allRoles.filter((r) => r.dept === id).map((r) => { const dn = r.done_count || 0, en = r.empty_count || 0; const memoLines = (r.memo || '').split('\n').filter(Boolean); return { id: r.id, name: r.name, emoji: r.emoji || '🧑‍💼', description: r.description || '', executor: r.executor || 'claude', doneN: dn, emptyN: en, perf: (dn + en) >= 2 ? (dn + '落盘' + (en ? ' · ' + en + '空转' : '')) : '', memoN: memoLines.length, memo: memoLines.join('\n') }; });
    let flow = []; try { flow = JSON.parse(d.flow) || []; } catch (e) {}
    // 部门级绩效:员工落盘/空转汇总 → 真实成功率(替代原 mock 的 doneWeek/successAvg/lead)
    const deptDone = employees.reduce((a, e) => a + e.doneN, 0), deptEmpty = employees.reduce((a, e) => a + e.emptyN, 0);
    const successAvg = (deptDone + deptEmpty) > 0 ? Math.round(deptDone / (deptDone + deptEmpty) * 100) + '%' : '—';
    const meta = { name: d.name, glyph: d.glyph, color: d.color, soft: (d.color || '#7C6FD9') + '33', desc: '', employees, empN: employees.length, flow, executors: deptPools[id] || [], deptDone, successAvg };
    const myAgents = Object.keys(ROLE).filter((aid) => ROLE[aid].dept === id);
    const ds = steps.filter((s) => myAgents.includes(s.agent));
    const card = (s) => ({ t: (taskById[s.task_id] ? taskById[s.task_id].text : ('任务 ' + s.task_id)).slice(0, 36), m: (ROLE[s.agent] ? ROLE[s.agent].label : s.agent) + ' · ' + s.step_id });
    const done = ds.filter((s) => s.status === 'done');
    const fail = ds.filter((s) => s.status === 'failed');
    boards[id] = { todo: [], doing: ds.filter((s) => s.status === 'running').map(card), done: done.map(card) };
    const tot = done.length + fail.length;
    return { id, agent: myAgents[0], agentIds: myAgents, ...meta, lead: '—', tasks: ds.filter((s) => s.status === 'running').length, doneWeek: done.length };
  });

  // 项目:按 task.project 聚合
  const projMap = {};
  tasks.forEach((t) => { (projMap[t.project || '默认项目'] = projMap[t.project || '默认项目'] || []).push(t); });
  const projects = Object.keys(projMap).map((name, i) => {
    const ts = projMap[name];
    const prog = Math.round(ts.reduce((a, t) => a + progressOf(t.id), 0) / ts.length);
    const anyRun = ts.some((t) => t.status === 'running' || t.status === 'planning');
    const allDone = ts.every((t) => t.status === 'done');
    const deptSet = {}; ts.forEach((t) => agentsInTask(t.id).forEach((a) => { deptSet[ROLE[a].dept] = 1; }));
    const agSet = {}; ts.forEach((t) => agentsInTask(t.id).forEach((a) => { agSet[a] = 1; }));
    const projRow = projRows.find((p) => p.name === name);
    const amOwner = !!(user && (user.admin || (projRow && projRow.owner === user.id) || ts.some((t) => t.owner === user.name)));
    const cost = ts.reduce((a, t) => a + (uOf(t.id).cost || 0), 0);
    const doneN = ts.filter((t) => t.status === 'done').length;
    const failN = ts.filter((t) => t.status === 'failed').length;
    return {
      id: 'PR' + i, name, client: 'orch', progress: prog,
      status: anyRun ? '进行中' : (allDone ? '已完成' : '规划'), sk: anyRun ? 'working' : (allDone ? 'done' : 'queued'),
      depts: Object.keys(deptSet), agentCount: Object.keys(agSet).length, taskCount: ts.length,
      cost: Math.round(cost * 1000) / 1000, doneN, failN, approve: !!(projRow && projRow.approve), budget: (projRow && projRow.budget) || 0,
      tasks: ts.map((t) => t.id), grantIds: store.grantsFor(name), amOwner,
      knowledge: store.projectKnowledge ? store.projectKnowledge(name) : '',
    };
  });

  // 合并 projects 表里的项目(含无任务的空项目),按可见性过滤
  projRows.forEach((tp) => {
    if (projMap[tp.name]) return;
    if (vis && !(tp.owner === (user && user.id) || vis.has(tp.name))) return;
    projects.push({ id: tp.id, name: tp.name, client: tp.client || 'orch', progress: 0, status: '规划', sk: 'queued', depts: [], agentCount: 0, taskCount: 0, cost: 0, doneN: 0, failN: 0, approve: !!tp.approve, budget: tp.budget || 0, tasks: [], grantIds: store.grantsFor(tp.name), amOwner: !!(user && (user.admin || tp.owner === user.id)), knowledge: store.projectKnowledge ? store.projectKnowledge(tp.name) : '' });
  });

  const tasksVm = tasks.map((t) => {
    const u = uOf(t.id);
    // 进度:顶层步骤完成数/总数(loop 子步骤不计)
    const tops = (byTask[t.id] || []).filter((s) => (s.step_id || '').indexOf('.') < 0);
    const total = tops.length, doneN = tops.filter((s) => s.status === 'done').length;
    const progress = total ? Math.round(doneN / total * 100) : 0;
    const progressLabel = total ? (doneN + '/' + total + ' 步') : '';
    // 失败任务:末段失败步的错误摘要(供需处理面板/列表直接显示,不必进详情)
    let failReason = '';
    if (t.status === 'failed') { const fs = (byTask[t.id] || []).filter((s) => s.status === 'failed' && s.output); const last = fs[fs.length - 1]; if (last) failReason = String(last.output).replace(/\s+/g, ' ').slice(-120); }
    // 总耗时:创建→最后更新(仅终态任务)
    let durLabel = '';
    if ((t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') && t.created_at && t.updated_at) {
      const sec = Math.round((new Date(t.updated_at).getTime() - new Date(t.created_at).getTime()) / 1000);
      if (sec > 0) durLabel = sec >= 3600 ? Math.floor(sec / 3600) + 'h' + Math.floor(sec % 3600 / 60) + 'm' : (sec >= 60 ? Math.floor(sec / 60) + 'm' + (sec % 60) + 's' : sec + 's'); // 0s(导入历史/瞬时)不显,避免"⏱ 0s"误导似坏了
    }
    // 任务挂靠部门 + 运行中谁在做什么:都用步骤→角色映射(开发任务的步骤多是工程部角色 → 挂工程部)
    const sr = planRoleMap(store.getTask(t.id) || {});
    const deptCount = {};
    Object.values(sr).forEach((role) => { const emp = RV[role]; if (emp && emp.deptName) deptCount[emp.deptName] = (deptCount[emp.deptName] || 0) + 1; });
    const deptName = Object.keys(deptCount).sort((a, b) => deptCount[b] - deptCount[a])[0] || '';
    let nowDoing = '';
    if (t.status === 'running') {
      nowDoing = (byTask[t.id] || []).filter((s) => s.status === 'running').map((s) => {
        const emp = sr[s.step_id] && RV[sr[s.step_id]];
        return (emp ? (emp.emoji + ' ' + emp.deptName + '·' + emp.name) : (ROLE[s.agent] ? ROLE[s.agent].label : s.agent)) + ' 正在做 ' + s.step_id;
      }).join(' | ');
    }
    let modelsObj = null; try { modelsObj = t.models ? JSON.parse(t.models) : null; } catch (e) {} // 供「再来一个」克隆配置
    return { id: t.id, title: t.text, proj: t.project || '默认项目', dept: deptName, sk: taskSk(t.status), agents: agentsInTask(t.id), updated: rel(t.updated_at), cost: u.cost, tokens: u.input + u.output, budget: t.budget || 0, approve: !!t.approve, ask: !!t.ask, replan: !!t.replan, isolate: t.isolate || 'none', models: modelsObj, question: t.question || '', blockedStep: t.blocked_step || '', hasDir: !!t.dir, owner: t.owner, mine: !!(user && t.owner === user.name), canModify: !!(user && (user.admin || t.owner === user.name)), nowDoing, progress, progressLabel, durLabel, failReason };
  });

  // 人员:来自 DB(含分配的 agent)
  const projN = Object.keys(projMap).length;
  const lastTs = tasks.length ? tasks[0].updated_at : null;
  const people = store.listPeople().map((p) => {
    const assigned = store.listPersonAgents(p.id);
    return { id: p.id, name: p.name, av: p.av, color: p.color, role: p.role, email: p.email, projects: projN, agents: assigned.length, assignedIds: assigned, last: rel(lastTs), budget: p.budget || 0, spend: Math.round((store.userSpend ? store.userSpend(p.name) : 0) * 1000) / 1000 };
  });

  const today = store.usageToday();
  today.byAgent = (store.usageTodayByAgent ? store.usageTodayByAgent() : []).map((r) => ({ agent: (ROLE[r.agent] && ROLE[r.agent].label) || r.agent, cost: Math.round(r.c * 1000) / 1000, tokens: r.i + r.o, calls: r.n }));
  today.allTime = store.usageAllTime ? Math.round(store.usageAllTime().cost * 1000) / 1000 : 0;
  const apps = store.listApps().map((a) => ({ id: a.id, name: a.name, taskId: a.task_id, entry: a.entry, url: '/output/' + a.task_id + '/' + a.entry, updated: rel(a.created_at) }));
  // 员工绩效榜:有记录的员工按落盘数排,含成功率(落盘/(落盘+空转))
  const dmetaN = {}; store.listDepts().forEach((d) => { dmetaN[d.id] = d.name; });
  const topEmployees = allRoles.filter((r) => r.dept !== '__system' && ((r.done_count || 0) + (r.empty_count || 0)) > 0)
    .map((r) => { const dn = r.done_count || 0, en = r.empty_count || 0; return { name: r.name, dept: dmetaN[r.dept] || r.dept, emoji: r.emoji || '🧑‍💼', done: dn, empty: en, total: dn + en, rate: Math.round(dn / (dn + en) * 100) }; })
    .sort((a, b) => b.done - a.done || a.empty - b.empty).slice(0, 10);
  return {
    me: user ? { id: user.id, name: user.name, admin: !!user.admin } : null,
    agents, depts, boards, projects, tasks: tasksVm, people, usage: today, apps, topEmployees,
    counts: {
      runningAgents: agents.filter((a) => a.status === 'working').length,
      runningTasks: tasks.filter((t) => t.status === 'running').length,
      doneToday: tasks.filter((t) => t.status === 'done' && isToday(t.updated_at)).length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      // 待自动重试:限额类失败且已排定自动重试、次数未用完(≤2)——与永久失败区分,让操作者知系统会自愈
      pendingRetry: tasks.filter((t) => { if (t.status !== 'failed') return false; const ar = store.getEvents(t.id).filter((e) => e.type === 'auto_retry').length; return ar > 0 && ar < 2; }).length,
      totalTasks: tasks.length, totalAgents: agents.length,
      costToday: today.cost,
      dailyBudget: Number(process.env.ORCH_DAILY_BUDGET) || 0, // 全局日成本上限(0=不限),供仪表盘显示护栏状态
    },
  };
}

// 任务详情接力链(RELAY 形状,原始 sk,前端再映射)
// 每步耗时:events 里 running→done/failed 的时差
function stepDurations(store, taskId) {
  const start = {}, dur = {};
  store.getEvents(taskId).forEach((e) => {
    if (e.type !== 'status') return;
    let d = null; try { d = JSON.parse(e.data); } catch (x) { return; }
    if (!d || !d.step) return;
    if (d.v === 'running') start[d.step] = new Date(e.ts).getTime();
    if ((d.v === 'done' || d.v === 'failed') && start[d.step]) {
      const s = Math.round((new Date(e.ts).getTime() - start[d.step]) / 1000);
      dur[d.step] = s >= 60 ? Math.floor(s / 60) + 'm' + (s % 60) + 's' : s + 's';
      delete start[d.step]; // 已结束:不再算作运行中
    }
  });
  // 仍在运行的步骤:实时已耗时(让用户看出在跑而非卡死)
  const fmt = (s) => s >= 60 ? Math.floor(s / 60) + 'm' + (s % 60) + 's' : s + 's';
  Object.keys(start).forEach((k) => { dur[k] = '⏱ ' + fmt(Math.round((Date.now() - start[k]) / 1000)); });
  return dur;
}

function relay(store, id) {
  const ROLE = roleMap(store);
  const t = store.getTask(id);
  if (!t) return [];
  const logs = store.getLogs(id);
  const stepRole = planRoleMap(t);
  const RV = roleView(store);
  const durs = stepDurations(store, id);
  const files = {}; (store.getEvents ? store.getEvents(id) : []).forEach((e) => { if (e.type === 'files') { try { const d = JSON.parse(e.data); files[d.step] = d.n; } catch (x) {} } });
  const costs = store.stepCosts ? store.stepCosts(id) : {};
  // loop 包装步骤 id:接力里标注为"质量环",避免空署名看着像坏行
  const loopIds = new Set(); try { (JSON.parse(t.plan).steps || []).forEach((s) => { if (s.type === 'loop') loopIds.add(s.id); }); } catch (e) {}
  return (t.steps || []).map((s) => {
    const isLoop = loopIds.has(s.step_id);
    const emp = !isLoop && stepRole[s.step_id] && RV[stepRole[s.step_id]]; // 员工(部门角色)
    const r = isLoop ? { label: '🔁 质量环', color: '#7C6FD9', av: '🔁' } : (ROLE[s.agent] || { label: s.agent, color: '#A39E94', av: 'A' });
    let last = ''; for (let i = logs.length - 1; i >= 0; i--) if (logs[i].step_id === s.step_id) { last = logs[i].line; break; }
    const outFull = (s.output && s.output.trim()) ? s.output.trim() : '';
    const summary = outFull ? outFull.slice(-300) : (last || ('状态: ' + s.status));
    const full = (outFull.length > 300) ? outFull.slice(-4000) : ''; // 有更多内容才给全文(供前端展开)
    const who = emp ? (emp.deptName + ' · ' + emp.name) : r.label;
    const fn = files[s.step_id];
    const filesLabel = s.status === 'done' ? (fn > 0 ? '📄 ' + fn + ' 文件' : '⚠ 无产出') : '';
    const sc = costs[s.step_id];
    const costLabel = sc > 0 ? '$' + (Math.round(sc * 1000) / 1000) : '';
    const metaLabel = [costLabel, filesLabel, durs[s.step_id] || ''].filter(Boolean).join(' · '); // 成本·文件·耗时 合并
    return { who, avatar: emp ? emp.emoji : r.av, color: emp ? emp.color : r.color, title: s.step_id, desc: summary, full, time: '', dur: durs[s.step_id] || '', filesLabel, costLabel, metaLabel, sk: stepSk(s.status), back: s.status === 'failed', art: null, artLabel: '', barPct: '0%', barColor: '#2E9E5B' };
  });
}

// 编排计划(PLAN 形状)
function plan(store, id) {
  const ROLE = roleMap(store);
  const RV = roleView(store);
  const t = store.getTask(id);
  if (!t) return [];
  let p = null; try { p = JSON.parse(t.plan); } catch (e) {}
  if (!p || !p.steps) return [];
  let n = 0; const out = [];
  const push = (s, dep, deps) => {
    const emp = s.role && RV[s.role];
    const r = ROLE[s.agent] || { label: s.agent || '编排器', color: '#1A1814', av: '◆' };
    out.push({ n: ++n, title: s.id, agent: emp ? (emp.deptName + '·' + emp.name) : r.label, avatar: emp ? emp.emoji : r.av, color: emp ? emp.color : r.color, sk: 'queued', eta: '', dep: dep || (deps && deps.length ? '依赖 ' + deps.join(',') : ''), deps: deps || [] });
  };
  // 展开 loop 为串联 body,并把依赖链重写到子步骤(保证画布连线不断):
  // body[0] 继承 loop.deps, body[i] 依赖 body[i-1];下游引用 loop id → 改指最后一个 body
  const tail = {}; // loop id → 最后一个 body id
  p.steps.forEach((s) => { if (s.type === 'loop' && s.body && s.body.length) tail[s.id] = s.body[s.body.length - 1].id; });
  const remap = (deps) => (deps || []).map((d) => tail[d] || d);
  p.steps.forEach((s) => {
    if (s.type === 'loop' && s.body && s.body.length) {
      s.body.forEach((b, i) => push(b, i ? '回退环' : '', i === 0 ? remap(s.deps) : [s.body[i - 1].id]));
    } else push(s, '', remap(s.deps));
  });
  (t.steps || []).forEach((st) => { const e = out.find((o) => o.title === st.step_id); if (e) { e.sk = stepSk(st.status); e.rawStatus = st.status; } });
  // #8 why-not:为未开始(queued)的步算"为何未就绪",供画布节点显示——等哪个上游 / 排队等槽位 / 任务被门挡
  const doneTitles = new Set(out.filter((o) => o.sk === 'done').map((o) => o.title));
  const taskGate = t.status === 'awaiting' ? '任务待审批,批准后才开始' : t.status === 'awaiting_input' ? '任务待你回答后继续' : t.status === 'paused' ? '任务已暂停' : '';
  out.forEach((o) => {
    if (o.sk !== 'queued') { o.blockReason = ''; return; }
    const unmet = (o.deps || []).filter((d) => !doneTitles.has(d));
    if (unmet.length) o.blockReason = '等待上游完成:' + unmet.join('、');
    else if (o.rawStatus === 'waiting') o.blockReason = '排队等执行器槽位(并发已达上限)';
    else o.blockReason = taskGate || '就绪,待调度';
  });
  return out;
}

// 会议室视图:参会员工 + 群聊消息流 + 可 @ 加入的员工名册
function meeting(store, id) {
  const t = store.getTask(id);
  if (!t) return null;
  const mt = store.getMeeting(id);
  if (!mt) return { status: 'none', task: t.text, attendees: [], msgs: [], roster: [] };
  const RV = roleView(store);
  const att = (mt.attendees || []).map((rid) => { const e = RV[rid] || {}; return { id: rid, name: e.name || rid, avatar: e.emoji || '🧑‍💼', deptName: e.deptName || '', color: e.color || '#7C6FD9' }; });
  const attSet = new Set(mt.attendees || []);
  const msgs = store.listMeetingMsgs(id).map((m) => ({ role: m.role, name: m.name, avatar: m.avatar || '🧑‍💼', text: m.text, ts: (m.ts || '').slice(11, 16), mine: m.role === 'user', sys: m.role === 'system' }));
  const roster = store.listRoles().filter((r) => r.dept !== '__system' && !attSet.has(r.id)).map((r) => { const e = RV[r.id] || {}; return { id: r.id, name: r.name, avatar: r.emoji || '🧑‍💼', deptName: e.deptName || '' }; });
  return { status: mt.status, task: t.text, attendees: att, msgs, roster };
}

function agentLog(store, agentId, limit) {
  return store.recentLogsForAgent(agentId, limit || 40).map((r) => '[T' + r.task_id + '·' + r.step_id + '] ' + r.line);
}

// 任务 Markdown 报告:目标/各步骤(员工·结果·产出文件·摘要)/成本,供归档分享
function taskReport(store, id) {
  const t = store.getTask(id);
  if (!t) return '# 任务不存在\n';
  const rows = relay(store, id);
  const u = store.taskUsage(id);
  const sk = { done: '✅ 完成', failed: '❌ 失败', running: '▶ 进行中', cancelled: '⊘ 取消' };
  let md = '# ' + (t.text || '任务 ' + id) + '\n\n';
  md += '- 状态:' + (sk[t.status] || t.status) + '\n- 项目:' + (t.project || '默认项目') + '\n- 负责人:' + (t.owner || '-') + '\n';
  md += '- 成本:$' + (u.cost || 0) + ' · ' + ((u.input || 0) + (u.output || 0)) + ' tokens\n\n';
  md += '## 执行接力\n\n';
  rows.forEach((r, i) => {
    md += '### ' + (i + 1) + '. ' + r.title + ' — ' + r.who + '\n';
    md += '结果:' + (r.sk || '') + (r.filesLabel ? ' · ' + r.filesLabel : '') + (r.dur ? ' · 用时 ' + r.dur : '') + '\n\n';
    if (r.desc) md += '> ' + String(r.desc).replace(/\n/g, '\n> ') + '\n\n';
  });
  return md;
}

module.exports = { buildAll, relay, plan, meeting, agentLog, roleMap, planRoleMap, roleView, taskReport };
