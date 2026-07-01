// 把 orch 真实数据(tasks/steps/logs + agents/people 库)派生成 Maestro 前端数据形状。全部真实。
// agent/部门/人员均来自 SQLite;项目=按 task.project 聚合。

const DEPT_META = {
  dev: { name: '开发部', glyph: '</>', color: '#7C6FD9', soft: 'rgba(124,111,217,.2)', desc: '编写与重构代码、实现功能' },
  qa: { name: '测试 / QA 部', glyph: '✓', color: '#4F8BE8', soft: 'rgba(79,139,232,.2)', desc: '功能验证、回归与质量把关' },
};
const taskSk = (s) => ({ pending: 'queued', planning: 'queued', running: 'working', done: 'done', failed: 'failed', cancelled: 'cancelled', awaiting: 'awaiting', awaiting_input: 'awaiting_input' })[s] || 'queued';
const stepSk = (s) => ({ running: 'working', done: 'done', failed: 'failed' })[s] || 'queued';

// 从 DB 构建 agentId → {dept,label,model,color,av,caps} 查找表
function roleMap(store) {
  const m = {};
  store.listAgents().forEach((a) => {
    let caps = []; try { caps = JSON.parse(a.caps); } catch (e) {}
    let args = []; try { args = JSON.parse(a.args); } catch (e) {}
    m[a.id] = { dept: a.dept || 'dev', label: a.name, model: a.model, color: a.color, av: a.avatar, caps, args, command: a.command, image: a.image || '' };
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
    return {
      id, name: r.label, type: id, dept: r.dept,
      command: r.command, args: r.args, image: r.image,
      color: r.color, avatar: r.av, soft: (r.color || '#7C6FD9') + '2b',
      status: running ? 'working' : 'idle',
      task: cur ? cur.text : '—', taskId: cur ? cur.id : '',
      action: running ? (lastLine(running.task_id, running.step_id) || ('执行 ' + running.step_id)) : '空闲 · 等待任务',
      actions: [], progress: cur ? progressOf(cur.id) : 0,
      model: r.model, success: tot ? Math.round(done / tot * 100) + '%' : '—', done,
      avg: '—', cost: '—', caps: r.caps,
    };
  });

  // 部门:来自 departments 表(含空部门)
  const boards = {};
  const depts = store.listDepts().map((d) => {
    const id = d.id;
    const meta = { name: d.name, glyph: d.glyph, color: d.color, soft: (d.color || '#7C6FD9') + '33', desc: '' };
    const myAgents = Object.keys(ROLE).filter((aid) => ROLE[aid].dept === id);
    const ds = steps.filter((s) => myAgents.includes(s.agent));
    const card = (s) => ({ t: (taskById[s.task_id] ? taskById[s.task_id].text : ('任务 ' + s.task_id)).slice(0, 36), m: (ROLE[s.agent] ? ROLE[s.agent].label : s.agent) + ' · ' + s.step_id });
    const done = ds.filter((s) => s.status === 'done');
    const fail = ds.filter((s) => s.status === 'failed');
    boards[id] = { todo: [], doing: ds.filter((s) => s.status === 'running').map(card), done: done.map(card) };
    const tot = done.length + fail.length;
    return { id, agent: myAgents[0], agentIds: myAgents, ...meta, lead: '—', tasks: ds.filter((s) => s.status === 'running').length, doneWeek: done.length, successAvg: tot ? Math.round(done.length / tot * 100) + '%' : '—' };
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
    const projRow = store.listProjects().find((p) => p.name === name);
    const amOwner = !!(user && (user.admin || (projRow && projRow.owner === user.id) || ts.some((t) => t.owner === user.name)));
    return {
      id: 'PR' + i, name, client: 'orch', progress: prog,
      status: anyRun ? '进行中' : (allDone ? '已完成' : '规划'), sk: anyRun ? 'working' : (allDone ? 'done' : 'queued'),
      depts: Object.keys(deptSet), agentCount: Object.keys(agSet).length, taskCount: ts.length,
      tasks: ts.map((t) => t.id), grantIds: store.grantsFor(name), amOwner,
    };
  });

  // 合并 projects 表里的项目(含无任务的空项目),按可见性过滤
  store.listProjects().forEach((tp) => {
    if (projMap[tp.name]) return;
    if (vis && !(tp.owner === (user && user.id) || vis.has(tp.name))) return;
    projects.push({ id: tp.id, name: tp.name, client: tp.client || 'orch', progress: 0, status: '规划', sk: 'queued', depts: [], agentCount: 0, taskCount: 0, tasks: [], grantIds: store.grantsFor(tp.name), amOwner: !!(user && (user.admin || tp.owner === user.id)) });
  });

  const tasksVm = tasks.map((t) => { const u = store.taskUsage(t.id); return { id: t.id, title: t.text, proj: t.project || '默认项目', sk: taskSk(t.status), agents: agentsInTask(t.id), updated: rel(t.updated_at), cost: u.cost, tokens: u.input + u.output, question: t.question || '', blockedStep: t.blocked_step || '', hasDir: !!t.dir, owner: t.owner, mine: !!(user && t.owner === user.name), canModify: !!(user && (user.admin || t.owner === user.name)) }; });

  // 人员:来自 DB(含分配的 agent)
  const projN = Object.keys(projMap).length;
  const lastTs = tasks.length ? tasks[0].updated_at : null;
  const people = store.listPeople().map((p) => {
    const assigned = store.listPersonAgents(p.id);
    return { id: p.id, name: p.name, av: p.av, color: p.color, role: p.role, email: p.email, projects: projN, agents: assigned.length, assignedIds: assigned, last: rel(lastTs) };
  });

  const today = store.usageToday();
  const apps = store.listApps().map((a) => ({ id: a.id, name: a.name, taskId: a.task_id, entry: a.entry, url: '/output/' + a.task_id + '/' + a.entry, updated: rel(a.created_at) }));
  return {
    me: user ? { id: user.id, name: user.name, admin: !!user.admin } : null,
    agents, depts, boards, projects, tasks: tasksVm, people, usage: today, apps,
    counts: {
      runningAgents: agents.filter((a) => a.status === 'working').length,
      runningTasks: tasks.filter((t) => t.status === 'running').length,
      doneToday: tasks.filter((t) => t.status === 'done' && isToday(t.updated_at)).length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      totalTasks: tasks.length, totalAgents: agents.length,
      costToday: today.cost,
    },
  };
}

// 任务详情接力链(RELAY 形状,原始 sk,前端再映射)
function relay(store, id) {
  const ROLE = roleMap(store);
  const t = store.getTask(id);
  if (!t) return [];
  const logs = store.getLogs(id);
  return (t.steps || []).map((s) => {
    const r = ROLE[s.agent] || { label: s.agent, color: '#A39E94', av: 'A' };
    let last = ''; for (let i = logs.length - 1; i >= 0; i--) if (logs[i].step_id === s.step_id) { last = logs[i].line; break; }
    const summary = (s.output && s.output.trim()) ? s.output.trim().slice(-300) : (last || ('状态: ' + s.status));
    return { who: r.label, avatar: r.av, color: r.color, title: s.step_id, desc: summary, time: '', dur: '', sk: stepSk(s.status), back: s.status === 'failed', art: null, artLabel: '', barPct: '0%', barColor: '#2E9E5B' };
  });
}

// 编排计划(PLAN 形状)
function plan(store, id) {
  const ROLE = roleMap(store);
  const t = store.getTask(id);
  if (!t) return [];
  let p = null; try { p = JSON.parse(t.plan); } catch (e) {}
  if (!p || !p.steps) return [];
  let n = 0; const out = [];
  const push = (s, dep) => {
    const r = ROLE[s.agent] || { label: s.agent || '编排器', color: '#1A1814', av: '◆' };
    out.push({ n: ++n, title: s.id, agent: r.label, avatar: r.av, color: r.color, sk: 'queued', eta: '', dep: dep || (s.deps && s.deps.length ? '依赖 ' + s.deps.join(',') : ''), deps: s.deps || [] });
  };
  p.steps.forEach((s) => { if (s.type === 'loop') { (s.body || []).forEach((b) => push(b, '回退环')); } else push(s); });
  (t.steps || []).forEach((st) => { const e = out.find((o) => o.title === st.step_id); if (e) e.sk = stepSk(st.status); });
  return out;
}

function agentLog(store, agentId, limit) {
  return store.recentLogsForAgent(agentId, limit || 40).map((r) => '[T' + r.task_id + '·' + r.step_id + '] ' + r.line);
}

module.exports = { buildAll, relay, plan, agentLog, roleMap };
