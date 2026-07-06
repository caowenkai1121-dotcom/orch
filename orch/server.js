const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const { open } = require('./store');
const { makePlan } = require('./planner');
const { makeWorkspace, taskDir, worktreeDir, reapWorktree, listWorktreeIds, listDataDirs } = require('./workspace');
const { runTask } = require('./runner');
const api = require('./api');
const boot = require('./bootstrap');
const perm = require('./perm');
const modelDiscovery = require('./model_discovery');
const { killTree } = require('./adapters/steptimeout'); // 按 PID 杀子进程树(POSIX 杀 shell 的子=真 agent,防孤儿),与超时守卫同一实现

// 进程级兜底:单个未捕获异常/悬空 rejection 不掀翻整个编排器——进程挂掉 = 所有运行中任务瞬间成僵尸、子进程成孤儿,
// 代价远大于带伤继续跑(状态全在 SQLite,坏不掉;错误如实进日志供排查)。
process.on('uncaughtException', (e) => { try { console.error('[uncaughtException]', (e && e.stack) || e); } catch (x) {} });
process.on('unhandledRejection', (e) => { try { console.error('[unhandledRejection]', (e && e.stack) || e); } catch (x) {} });

const ROOT = process.cwd();
const store = open(path.join(__dirname, 'orch.db'));
store.seed();
boot.importDataDir(store, ROOT);
boot.recoverZombies(store); // 上次进程中断的任务 → 标失败可重试
let adapters = boot.buildAdapters(store);
if (boot.scanAgents(store)) adapters = boot.buildAdapters(store);
const listFilesIn = boot.listFilesIn;
let health = boot.checkHealth(store); // 执行器健康(启动检测,缓存)
let modelDiscoveryCache = { ts: 0, data: null };

const runs = new Map(); // 运行态注册表:taskId -> { cancelled, children }
const workspace = makeWorkspace(ROOT);
const templatesDir = path.join(__dirname, 'templates');

const app = express();
const auth = require('./auth');
app.use(express.json({ limit: '8mb' })); // 配置导入/编辑计划等可能较大,放宽默认 100kb
app.use(express.static(path.join(__dirname, 'web')));

// 会话:每请求解析当前用户
app.use((req, res, next) => { req.user = auth.userFromReq(store, req); next(); });
const pubUser = (u) => ({ id: u.id, name: u.name, av: u.av, color: u.color, role: u.role, admin: !!u.admin });
app.post('/login', (req, res) => {
  const r = auth.login(store, (req.body || {}).name, (req.body || {}).password);
  if (!r) return res.status(401).json({ error: '账号或密码错误' });
  res.setHeader('Set-Cookie', 'orch_sess=' + r.tok + '; HttpOnly; Path=/; SameSite=Lax');
  res.json({ ok: true, user: pubUser(r.user) });
});
app.post('/logout', (req, res) => { auth.logout(store, auth.tokenFromReq(req)); res.setHeader('Set-Cookie', 'orch_sess=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => req.user ? res.json(pubUser(req.user)) : res.status(401).json({ error: 'unauthorized' }));
app.post('/api/me/password', (req, res) => { if (!req.user) return res.status(401).json({ error: 'unauthorized' }); store.setPassword(req.user.id, (req.body || {}).password || 'admin'); res.json({ ok: true }); });
// Webhook 触发(鉴权闸前,凭 token):外部系统 POST /hook/<token> {text,project?,dept?,playbook?} 即建任务
app.post('/hook/:token', (req, res) => {
  const p = store.personByHookToken(req.params.token);
  if (!p) return res.status(401).json({ error: 'bad token' });
  const b = req.body || {};
  const text = (b.text || '').trim();
  if (!text) return res.status(400).json({ error: '缺 text' });
  // dept 支持传名称或 id;playbook 传名称或 id
  let dept = null; if (b.dept) { const d = store.listDepts().find((x) => x.id === b.dept || x.name === b.dept); dept = d ? d.id : null; }
  let playbook = null; if (b.playbook) { const pb = store.listPlaybooks().find((x) => String(x.id) === String(b.playbook) || x.name === b.playbook); playbook = pb ? pb.id : null; }
  const id = createAndRunTask(p.name, { text, project: b.project, dept, playbook, refine: false });
  store.addEvent(id, 'webhook', { by: p.id, dept, playbook });
  res.json({ id });
});

// 鉴权闸:此后所有接口都要求登录
app.use((req, res, next) => { if (req.user) return next(); res.status(401).json({ error: 'unauthorized' }); });

// 权限助手(perm.js,服务端强制)
const { owns, canSeeTask, adminOnly } = perm.make(store);

// 我的 Webhook 地址(取/重置)
app.get('/api/me/hook', (req, res) => res.json({ url: '/hook/' + store.ensureHookToken(req.user.id) }));
app.post('/api/me/hook/reset', (req, res) => res.json({ url: '/hook/' + store.resetHookToken(req.user.id) }));

app.get('/tasks', (req, res) => res.json(store.listTasks()));
app.get('/task/:id', (req, res) => { const t = store.getTask(Number(req.params.id)); if (!canSeeTask(req.user, t)) return res.status(403).json({ error: '无权限' }); res.json(t); });
app.get('/task/:id/logs', (req, res) => { if (!canSeeTask(req.user, store.getTask(Number(req.params.id)))) return res.status(403).json([]); res.json(store.getLogs(Number(req.params.id))); });

// Maestro 前端的真实数据聚合(按当前用户过滤)
app.get('/api/all', (req, res) => res.json({ ...api.buildAll(store, req.user), activity: activity.slice(0, 18) }));
app.get('/api/relay/:id', (req, res) => { if (!canSeeTask(req.user, store.getTask(Number(req.params.id)))) return res.status(403).json([]); res.json(api.relay(store, Number(req.params.id))); });
app.get('/api/plan/:id', (req, res) => { if (!canSeeTask(req.user, store.getTask(Number(req.params.id)))) return res.status(403).json([]); res.json(api.plan(store, Number(req.params.id))); });
app.get('/api/agentlog/:id', adminOnly, (req, res) => res.json(api.agentLog(store, req.params.id))); // 按执行器跨全部任务聚合日志→无法单任务鉴权,收口为 adminOnly(防普通用户越权读他人任务日志)
// 执行器健康(缓存;?refresh=1 重测)
app.get('/api/health', (req, res) => { if (req.query.refresh) health = boot.checkHealth(store); res.json(health); });
app.get('/api/agents/model-discovery', async (req, res) => {
  try {
    if (!req.query.refresh && modelDiscoveryCache.data && Date.now() - modelDiscoveryCache.ts < 60000) return res.json(modelDiscoveryCache.data);
    const data = await modelDiscovery.discoverModels(store);
    modelDiscoveryCache = { ts: Date.now(), data };
    res.json(data);
  } catch (e) {
    res.status(500).json({ agents: {}, error: (e && e.message) || String(e) });
  }
});

app.post('/api/agents', adminOnly, (req, res) => {
  const b = req.body || {};
  const id = store.addAgent(b);
  if (b.default_model !== undefined || b.default_effort !== undefined) store.setAgentDefaults(id, b.default_model, b.default_effort); // #4
  adapters = boot.buildAdapters(store);
  health = boot.checkHealth(store);
  broadcastRaw({ type: 'agents' });
  res.json({ id });
});
app.put('/api/agents/:id', adminOnly, (req, res) => { const b = req.body || {}; store.updateAgent(req.params.id, b); if (b.default_model !== undefined || b.default_effort !== undefined) store.setAgentDefaults(req.params.id, b.default_model, b.default_effort); adapters = boot.buildAdapters(store); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });
app.delete('/api/agents/:id', adminOnly, (req, res) => { store.deleteAgent(req.params.id); adapters = boot.buildAdapters(store); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });
app.post('/api/agents/:id/enabled', adminOnly, (req, res) => { store.setAgentEnabled(req.params.id, !!(req.body && req.body.enabled)); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); }); // 启用/停用:停用的不进规划器可选列表
// #3 把一个 agent 加入/移出某部门执行器池(在 Agent 团队页批量加多个部门,每次一个)
app.post('/api/agents/:id/dept-pool', adminOnly, (req, res) => {
  const aid = req.params.id; const deptId = (req.body || {}).deptId; const on = !!(req.body || {}).on;
  if (!deptId) return res.json({ ok: false });
  const cur = (store.allDeptExecutors()[deptId] || []).slice();
  const i = cur.indexOf(aid);
  if (on && i < 0) cur.push(aid); else if (!on && i >= 0) cur.splice(i, 1);
  store.setDeptExecutors(deptId, cur);
  broadcastRaw({ type: 'agents' });
  res.json({ ok: true });
});
app.get('/api/projects', (req, res) => res.json(store.listProjects()));
app.post('/api/projects', (req, res) => {
  const id = store.addProject({ ...(req.body || {}), owner: req.user.id });
  const name = (req.body || {}).name;
  ((req.body || {}).members || []).forEach((uid) => name && store.grantProject(name, uid)); // 归属用户
  broadcastRaw({ type: 'task' });
  res.json({ id });
});
// 项目知识/约定:admin 或该项目属主(拥有其任务/项目行)可编辑
app.post('/api/project/:name/knowledge', (req, res) => {
  const name = req.params.name;
  const pr = store.listProjects().find((p) => p.name === name);
  const owns = req.user.admin || (pr && pr.owner === req.user.id) || store.listTasks().some((t) => (t.project || '默认项目') === name && t.owner === req.user.name);
  if (!owns) return res.status(403).json({ ok: false, error: '无权限' });
  store.setProjectKnowledge(name, (req.body || {}).knowledge || '');
  res.json({ ok: true });
});
app.post('/api/people', adminOnly, (req, res) => res.json({ id: store.addPerson(req.body || {}) }));
app.post('/api/people/:id/agents', adminOnly, (req, res) => { store.setPersonAgents(req.params.id, (req.body || {}).agentIds || []); res.json({ ok: true }); });

// 员工(角色) CRUD:管理员
app.post('/api/roles', adminOnly, (req, res) => { const id = store.addRole(req.body || {}); broadcastRaw({ type: 'agents' }); res.json({ id }); });
app.delete('/api/roles/:id', adminOnly, (req, res) => { store.deleteRole(req.params.id); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });
app.get('/api/roles/:id', adminOnly, (req, res) => { const r = store.getRole(req.params.id); if (!r) return res.status(404).json({ error: '员工不存在' }); res.json({ id: r.id, dept: r.dept, name: r.name, description: r.description || '', prompt: r.prompt || '', executor: r.executor || 'claude' }); });
app.put('/api/roles/:id', adminOnly, (req, res) => { const ok = store.updateRole(req.params.id, req.body || {}); broadcastRaw({ type: 'agents' }); res.json({ ok }); });
app.post('/api/roles/:id/reset', adminOnly, (req, res) => { const ok = store.resetRoleLearning(req.params.id); broadcastRaw({ type: 'agents' }); res.json({ ok }); });

// #3 部门 CRUD + 为部门设置 agent
app.post('/api/depts', adminOnly, (req, res) => { const id = store.addDept(req.body || {}); broadcastRaw({ type: 'agents' }); res.json({ id }); });
app.delete('/api/depts/:id', adminOnly, (req, res) => { store.deleteDept(req.params.id); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });
app.post('/api/depts/:id/agents', adminOnly, (req, res) => { ((req.body || {}).agentIds || []).forEach((a) => store.setAgentDept(a, req.params.id)); adapters = boot.buildAdapters(store); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });
// 部门执行器池:该部门任务只能用这些执行器
app.post('/api/depts/:id/executors', adminOnly, (req, res) => { store.setDeptExecutors(req.params.id, (req.body || {}).agentIds || []); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });
// 部门标准作业流程(可编辑)
app.put('/api/depts/:id/flow', adminOnly, (req, res) => { store.setDeptFlow(req.params.id, (req.body || {}).flow || []); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });

// #4 项目授权:项目 owner(有任务在其中)或管理员可授权
app.post('/api/grant', (req, res) => {
  const { project, userId, on } = req.body || {};
  if (!project || !userId) return res.json({ ok: false });
  const mine = store.listTasks().some((t) => (t.project || '默认项目') === project && t.owner === req.user.name);
  if (!req.user.admin && !mine) return res.status(403).json({ ok: false, error: '需项目所有者或管理员' });
  if (on === false) store.revokeProject(project, userId); else store.grantProject(project, userId);
  broadcastRaw({ type: 'task' });
  res.json({ ok: true });
});

// #4 项目级审批开关(仅管理员):开启后本项目所有新任务须先审批
app.post('/api/projects/:name/approve', adminOnly, (req, res) => {
  store.setProjectApprove(req.params.name, !!(req.body && req.body.on));
  broadcastRaw({ type: 'task' });
  res.json({ ok: true });
});
// #7 项目总成本上限(仅管理员;0=不限)
app.post('/api/projects/:name/budget', adminOnly, (req, res) => {
  store.setProjectBudget(req.params.name, Number((req.body || {}).budget) || 0);
  broadcastRaw({ type: 'task' });
  res.json({ ok: true });
});
// #7 用户总成本上限(仅管理员;0=不限)
app.post('/api/people/:id/budget', adminOnly, (req, res) => {
  store.setUserBudget(req.params.id, Number((req.body || {}).budget) || 0);
  broadcastRaw({ type: 'task' });
  res.json({ ok: true });
});

// 建任务并启动:表单/定时任务/Webhook 共用
function createAndRunTask(ownerName, body) {
  const project = body.project || '默认项目';
  const models = body.models && typeof body.models === 'object' ? body.models : null; // {执行器id:{model,effort}}
  const approve = !!body.approve || store.projectApprove(project); // #4 任务级 或 项目级(admin 开启)审批,任一开启则须审批
  const id = store.createTask(body.text, project, ownerName, { budget: body.budget, approve, isolate: body.isolate, ask: body.ask, replan: body.replan, models });
  const ws = taskWorkspace(store.getTask(id));
  store.setTaskDir(id, ws.make()); // 持久化产出目录(供预览/打开)
  // 全局日成本总护栏(无人值守防失控):今日累计花费已达上限则建任务但不执行,标失败可重试
  const cap = Number(process.env.ORCH_DAILY_BUDGET) || 0;
  if (cap > 0) {
    const spent = store.usageToday().cost || 0;
    if (spent >= cap) {
      const msg = '🛑 已达全局日成本上限 $' + cap + '(今日已花 $' + spent.toFixed(3) + '),任务未执行(未规划)。次日0点(本地)重置,或提高 ORCH_DAILY_BUDGET 后重新下发本任务。';
      store.setStep(id, 'blocked', '', 'failed', msg);
      store.setTaskStatus(id, 'failed');
      if (store.addEvent) store.addEvent(id, 'task', 'failed');
      if (store.addTaskMsg) store.addTaskMsg(id, 'system', msg);
      broadcast({ taskId: id, type: 'task', data: 'failed' });
      return id;
    }
  }
  const allAgents = store.listAgents().filter((a) => (a.kind || 'cli') === 'cli' && a.enabled !== 0).map((a) => a.id);
  const explicit = Array.isArray(body.agents) && body.agents.length > 0;
  const sel = explicit ? body.agents.filter((a) => allAgents.includes(a)) : allAgents;
  const refine = body.refine === undefined ? true : !!body.refine;
  // 剧本模式:按剧本骨架直接出计划(不走 LLM 规划,快且稳)
  const pb = body.playbook ? store.getPlaybook(Number(body.playbook)) : null;
  const planFromPlaybook = () => {
    const p = JSON.parse(pb.plan);
    const fill = (steps) => (steps || []).map((s) => ({ ...s, prompt: s.prompt ? s.prompt.split('{task}').join(body.text) : s.prompt, body: s.body ? fill(s.body) : undefined }));
    return { task: body.text, steps: fill(p.steps) };
  };
  runTask(id, {
    store, adapters, workspace: ws, runs,
    makePlan: pb
      ? () => Promise.resolve(planFromPlaybook())
      : (text, onChild) => makePlan(text, { mode: body.mode, agents: sel.length ? sel : allAgents, explicit, roles: store.listRoles(), depts: store.listDepts(), dept: body.dept || null, deptPools: store.allDeptExecutors(), orchestration: body.orchestration, refine, templatesDir, claude: adapters.claude, onChild }),
    onEvent: broadcast,
  });
  return id;
}

app.post('/task', (req, res) => {
  const id = createAndRunTask(req.user.name, req.body || {}); // 归属=当前登录用户
  res.json({ id });
});

// 剧本:存(从任务) / 列 / 删;新建任务 body.playbook=id 使用
app.post('/api/playbooks', (req, res) => {
  const t = store.getTask(Number((req.body || {}).taskId));
  if (!t || !owns(req.user, t)) return res.status(403).json({ ok: false });
  let plan = null; try { plan = JSON.parse(t.plan); } catch (e) {}
  if (!plan || !plan.steps || !plan.steps.length) return res.json({ ok: false, error: '无计划可存' });
  // 泛化:把具体任务文本替换成 {task} 占位,复用时回填新需求
  const generalize = (steps) => (steps || []).forEach((s) => { if (s.prompt && t.text) s.prompt = s.prompt.split(t.text).join('{task}'); if (s.body) generalize(s.body); });
  generalize(plan.steps);
  const id = store.addPlaybook({ name: (req.body || {}).name || t.text.slice(0, 30), description: t.text.slice(0, 80), plan });
  broadcastRaw({ type: 'agents' });
  res.json({ id });
});
app.get('/api/playbooks', (req, res) => res.json(store.listPlaybooks().map((p) => { let n = 0; try { n = (JSON.parse(p.plan || '{}').steps || []).length; } catch (e) {} return { id: p.id, name: p.name, description: p.description, steps: n }; })));
app.delete('/api/playbooks/:id', adminOnly, (req, res) => { store.deletePlaybook(Number(req.params.id)); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });

// 按任务的 isolate 选工作目录:worktree(git仓内) / 每任务 data 目录(回退)
function isGit(d) { try { execSync('git rev-parse --is-inside-work-tree', { cwd: d, stdio: 'ignore' }); return true; } catch (e) { return false; } }
function taskWorkspace(t) {
  let dir = ROOT;
  try {
    // 已有产出目录一律复用:目录名含任务文本 slug,任务重命名后重新推导会得到全新空目录,
    // retry/resume/继续开发 就会跑错地方(交接/产出/git 历史全断)。t.dir 是唯一真相。
    if (t.dir && fs.existsSync(t.dir)) dir = t.dir;
    else if (t.isolate === 'worktree' && isGit(ROOT)) dir = worktreeDir(ROOT, t.id);
    else dir = taskDir(ROOT, t.owner, t.project, t.text, t.id);
  } catch (e) {}
  return { make: () => dir };
}

function parseRouteChoice(s) {
  const t = String(s || '').trim().toUpperCase();
  if (/^A\b|快速/.test(t)) return 'A';
  if (/^B\b|标准/.test(t)) return 'B';
  if (/^C\b|深度|会议/.test(t)) return 'C';
  return '';
}

function applyRouteChoice(id, t, answer) {
  const choice = parseRouteChoice(answer);
  if (!choice) {
    store.addTaskMsg(id, 'system', '请选择 A / B / C: A=快速实现,B=标准编排,C=深度会议。');
    broadcastRaw({ type: 'msg', taskId: id });
    return false;
  }
  const allAgents = store.listAgents().filter((a) => (a.kind || 'cli') === 'cli' && a.enabled !== 0).map((a) => a.id);
  store.addTaskMsg(id, 'user', choice);
  store.clearTaskDecision(id);
  store.clearSteps(id);
  store.setTaskStatus(id, 'planning');
  store.addEvent(id, 'route_choice', { choice });
  broadcastRaw({ type: 'task', taskId: id });
  (async () => {
    try {
      // 注册运行态:让规划期 LLM 子进程可被取消;取消后不再复活执行(否则「取消」对此路径完全失效)
      const rec = runs.get(id) || (runs.set(id, { cancelled: false, paused: false, children: new Set(), skip: new Set(), notes: [] }), runs.get(id));
      rec.cancelled = false; rec.paused = false;
      const planStart = Date.now();
      const plan = await makePlan(t.text, { mode: 'llm', agents: allAgents, roles: store.listRoles(), depts: store.listDepts(), deptPools: store.allDeptExecutors(), refine: true, templatesDir, claude: adapters.claude, routeChoice: choice, onChild: (c) => rec.children.add(c) });
      if (rec.cancelled) return; // 规划期间被取消
      const planMs = Date.now() - planStart;
      store.addEvent(id, 'plan', { steps: (plan.steps || []).length, ms: planMs, route: plan.planning_stats && plan.planning_stats.route, llmCalls: plan.planning_stats && plan.planning_stats.llm_calls });
      broadcast({ taskId: id, type: 'plan', data: plan });
      require('./runner').runPlanned(id, { store, adapters, workspace: taskWorkspace(t), runs, onEvent: broadcast }, plan);
    } catch (e) {
      store.setTaskStatus(id, 'failed');
      store.addTaskMsg(id, 'system', '规划模式选择后重规划失败:' + (e && e.message || e));
      store.addEvent(id, 'task', 'failed');
      broadcast({ taskId: id, type: 'task', data: 'failed' });
    }
  })();
  return true;
}
// 用户回答决策 → 续跑
app.post('/task/:id/answer', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  if (!t) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  const stepId = (req.body && req.body.stepId) || t.blocked_step;
  const answer = (req.body && req.body.answer) || '';
  if (t.status !== 'awaiting_input') return res.json({ ok: false, error: '任务不在待输入状态(可能已被处理)' }); // 防重复提交/旧页面把在跑任务再拉起一份并发执行
  if (stepId === '__route_choice') {
    const ok = applyRouteChoice(id, t, answer);
    return res.json({ ok, mode: 'route_choice' });
  }
  res.json({ ok: true });
  require('./runner').resumeTask(id, { store, adapters, workspace: taskWorkspace(t), runs, onEvent: broadcast }, stepId, answer);
});

// 打开产出目录(系统文件管理器)
app.post('/task/:id/open', (req, res) => {
  const t = store.getTask(Number(req.params.id)); const dir = t && t.dir;
  if (!canSeeTask(req.user, t)) return res.status(403).json({ ok: false });
  if (dir) { try { const cmd = process.platform === 'win32' ? 'explorer' : (process.platform === 'darwin' ? 'open' : 'xdg-open'); require('child_process').spawn(cmd, [dir], { detached: true, stdio: 'ignore' }); } catch (e) {} }
  res.json({ ok: !!dir });
});

// 列产出文件
app.get('/api/files/:id', (req, res) => {
  const t = store.getTask(Number(req.params.id));
  if (!canSeeTask(req.user, t)) return res.status(403).json([]);
  if (!t || !t.dir) return res.json([]);
  const out = [];
  const walk = (d, rel) => {
    if (out.length > 500) return;
    let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const it of items) {
      if (it.name === '.git' || it.name === 'node_modules') continue;
      const rp = rel ? rel + '/' + it.name : it.name;
      if (it.isDirectory()) walk(path.join(d, it.name), rp);
      else { let sz = 0; try { sz = fs.statSync(path.join(d, it.name)).size; } catch (e) {} out.push({ path: rp, size: sz }); }
    }
  };
  walk(t.dir, '');
  res.json(out.slice(0, 500));
});

// 一键发布到应用广场(仅管理员)
app.post('/api/apps', adminOnly, (req, res) => {
  const taskId = Number(req.body && req.body.taskId); const t = store.getTask(taskId);
  if (!t || !t.dir) return res.json({ ok: false });
  let entry = req.body && req.body.entry;
  if (!entry) { const fl = listFilesIn(t.dir); entry = fl.find((f) => /(^|\/)index\.html$/i.test(f)) || fl.find((f) => /\.html$/i.test(f)) || fl[0]; }
  if (!entry) return res.json({ ok: false, error: '无可发布入口' });
  const appId = store.addApp({ name: (req.body && req.body.name) || t.text, taskId, dir: t.dir, entry });
  broadcastRaw({ type: 'apps' });
  res.json({ id: appId, entry });
});
app.delete('/api/apps/:id', adminOnly, (req, res) => {
  store.deleteApp(Number(req.params.id)); broadcastRaw({ type: 'apps' }); res.json({ ok: true });
});

// 继续开发:在原任务上追加新一轮步骤(不新建任务),复用产出目录
app.post('/task/:id/continue', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  const text = ((req.body && req.body.text) || '').trim();
  if (!t || !text) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  if (t.status === 'running' || t.status === 'planning' || t.status === 'meeting') return res.json({ ok: false, error: '任务进行中,请在任务对话里发消息注入,或先停止' }); // 防与在跑计划并发双跑
  const dir = t.dir || ROOT;
  res.json({ id });
  require('./runner').continueTask(id, {
    store, adapters, workspace: { make: () => dir }, runs,
    makePlan: (txt, onChild) => makePlan(txt, { mode: 'llm', agents: store.listAgents().filter((a) => (a.kind || 'cli') === 'cli' && a.enabled !== 0).map((a) => a.id), roles: store.listRoles(), depts: store.listDepts(), refine: false, templatesDir, claude: adapters.claude, onChild }),
    onEvent: broadcast,
  }, text);
});

// 内容搜索:任务需求+产出里搜关键词(仅可见任务)
app.get('/api/search', (req, res) => {
  const q = ((req.query.q || '') + '').trim();
  if (!q) return res.json([]);
  const rows = store.searchContent(q, 40).filter((t) => canSeeTask(req.user, store.getTask(t.id)));
  res.json(rows.slice(0, 20));
});

// 配置备份导出(admin):角色/部门/剧本/自定义Agent → JSON,换库/重置后可留存定制
app.get('/api/export/config', adminOnly, (req, res) => {
  const cfg = {
    exportedAt: new Date().toISOString(),
    roles: store.listRoles().map((r) => ({ id: r.id, dept: r.dept, name: r.name, emoji: r.emoji, description: r.description, prompt: r.prompt, executor: r.executor, memo: r.memo || '' })),
    depts: store.listDepts().map((d) => ({ id: d.id, name: d.name, glyph: d.glyph, color: d.color, flow: d.flow || '[]' })),
    playbooks: store.listPlaybooks().map((p) => ({ name: p.name, description: p.description, plan: p.plan })),
    agents: store.listAgents().filter((a) => (a.kind || 'cli') !== 'cli' || !['claude', 'codex'].includes(a.id)).map((a) => ({ id: a.id, name: a.name, command: a.command, model: a.model, kind: a.kind })),
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="orch-config-backup.json"');
  res.send(JSON.stringify(cfg, null, 2));
});

// 配置导入/恢复(admin):从备份 JSON 恢复角色/部门/剧本/自定义Agent(upsert 合并,不删现有)
app.post('/api/import/config', adminOnly, (req, res) => {
  const c = req.body || {};
  let n = { depts: 0, roles: 0, playbooks: 0, agents: 0 };
  try {
    (c.depts || []).forEach((d) => {
      if (!store.listDepts().some((x) => x.id === d.id)) { store.addDept({ id: d.id, name: d.name, glyph: d.glyph, color: d.color }); n.depts++; }
      let flow = []; try { flow = JSON.parse(d.flow || '[]'); } catch (e) {} if (flow.length) store.setDeptFlow(d.id, flow);
    });
    (c.roles || []).forEach((r) => { store.addRole({ id: r.id, dept: r.dept, name: r.name, emoji: r.emoji, description: r.description, prompt: r.prompt, executor: r.executor }); if (r.memo) store.setRoleMemo(r.id, r.memo); n.roles++; });
    (c.playbooks || []).forEach((p) => { let plan = p.plan; try { plan = typeof p.plan === 'string' ? JSON.parse(p.plan) : p.plan; } catch (e) {} store.addPlaybook({ name: p.name, description: p.description, plan }); n.playbooks++; });
    (c.agents || []).forEach((a) => { if (!store.listAgents().some((x) => x.id === a.id)) { store.addAgent({ id: a.id, name: a.name, command: a.command, model: a.model, kind: a.kind || 'cli' }); n.agents++; } });
  } catch (e) { return res.status(400).json({ ok: false, error: '配置格式错误' }); }
  broadcastRaw({ type: 'agents' });
  res.json({ ok: true, imported: n });
});

// 任务 Markdown 报告下载(人读归档)
app.get('/api/report/:id', (req, res) => {
  const t = store.getTask(Number(req.params.id));
  if (!canSeeTask(req.user, t)) return res.sendStatus(403);
  const md = api.taskReport(store, Number(req.params.id));
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', "attachment; filename=\"report-" + t.id + ".md\"");
  res.send(md);
});

// 产出打包下载:git archive 出 zip(产出已版本化,零依赖)
app.get('/api/download/:id', (req, res) => {
  const t = store.getTask(Number(req.params.id));
  if (!canSeeTask(req.user, t)) return res.sendStatus(403);
  if (!t || !t.dir || !fs.existsSync(path.join(t.dir, '.git'))) return res.status(404).json({ error: '产出未版本化,无法打包(任务需先跑出产出)' });
  const name = (t.text || 'output').replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 30) + '.zip';
  res.setHeader('Content-Type', 'application/zip');
  // RFC5987:中文文件名走 filename*,ASCII 兜底 filename(header 不能含非 latin1 字符)
  res.setHeader('Content-Disposition', "attachment; filename=\"output-" + t.id + ".zip\"; filename*=UTF-8''" + encodeURIComponent(name));
  const p = require('child_process').spawn('git', ['archive', '--format=zip', 'HEAD'], { cwd: t.dir });
  p.stdout.pipe(res);
  p.on('error', () => { if (!res.headersSent) res.sendStatus(500); });
  p.stderr.on('data', () => {});
});

// 静态服务产出文件(供预览);防目录穿越
app.get('/output/:id/*splat', (req, res) => {
  const t = store.getTask(Number(req.params.id));
  if (!t || !t.dir) return res.sendStatus(404);
  // 已发布到应用广场的任务视为公开(仍在登录闸后),让普通成员的 app iframe 能渲染;其余走 canSeeTask
  if (!store.isPublishedTask(t.id) && !canSeeTask(req.user, t)) return res.sendStatus(403);
  const rel = [].concat(req.params.splat || []).join('/'); // Express5 命名通配
  const full = path.resolve(t.dir, rel);
  const baseR = path.resolve(t.dir);
  // 必须严格在本任务目录内:startsWith 无分隔符会让 task-1 命中兄弟 task-12(前缀绕过),须补 path.sep
  if (full !== baseR && !full.startsWith(baseR + path.sep)) return res.sendStatus(403);
  res.sendFile(full);
});

// —— 任务会话化:统一消息入口(按任务状态智能路由) + 实时控制面 ——
const runnerMod = require('./runner');
app.get('/api/msgs/:id', (req, res) => {
  const t = store.getTask(Number(req.params.id));
  if (!canSeeTask(req.user, t)) return res.status(403).json([]);
  res.json(store.getTaskMsgs(t.id));
});
// —— 会议室:复杂任务开会讨论(员工+用户群聊)——
const meetDeps = (t) => ({ store, adapters, workspace: taskWorkspace(t), runs, onEvent: broadcast });
app.get('/api/meeting/:id', (req, res) => {
  const t = store.getTask(Number(req.params.id));
  if (!canSeeTask(req.user, t)) return res.status(403).json(null);
  res.json(api.meeting(store, t.id));
});
app.post('/api/meeting/:id/msg', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  const text = ((req.body || {}).text || '').trim();
  if (!t || !text) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  const ok = runnerMod.meetingUserMsg(id, meetDeps(t), text, req.user.name);
  res.json({ ok });
});
app.post('/api/meeting/:id/summon', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  const roleId = (req.body || {}).roleId;
  if (!t || !roleId) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  res.json({ ok: true });
  runnerMod.summonEmployee(id, meetDeps(t), roleId).catch(() => {});
});
app.post('/api/meeting/:id/end', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  if (!t) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  res.json({ ok: true });
  // 用户显式点「结束会议 · 生成方案」= 用户拍板:直接收束,不再过主持人判定(否则会被 continue 否决,用户按钮失效还多花一次 LLM)
  runnerMod.endMeeting(id, meetDeps(t), { status: 'user_forced', reason: '用户手动结束会议' }).catch(() => {});
});
app.post('/task/:id/message', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  const text = ((req.body || {}).text || '').trim();
  if (!t || !text) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  store.addTaskMsg(id, 'user', text);
  broadcastRaw({ type: 'msg', taskId: id });
  const deps = () => ({ store, adapters, workspace: taskWorkspace(t), runs, onEvent: broadcast });
  if (t.status === 'running' || t.status === 'planning') {
    runnerMod.noteToTask(id, runs, text); // 注入下一个启动的步骤
    store.addTaskMsg(id, 'system', '📨 指令已排队,将注入下一个开始执行的步骤。');
    broadcastRaw({ type: 'msg', taskId: id });
    return res.json({ ok: true, mode: 'inject' });
  }
  if (t.status === 'paused') { res.json({ ok: true, mode: 'resume' }); return runnerMod.retryFailed(id, deps(), text); }
  if (t.status === 'awaiting_input') {
    if (t.blocked_step === '__route_choice') {
      const ok = applyRouteChoice(id, t, text);
      return res.json({ ok, mode: 'route_choice' });
    }
    res.json({ ok: true, mode: 'answer' });
    return runnerMod.resumeTask(id, deps(), t.blocked_step, text);
  }
  if (t.status === 'awaiting') { store.addTaskMsg(id, 'system', '任务在等审批,请先「批准并运行」(可先编辑计划)。'); broadcastRaw({ type: 'msg', taskId: id }); return res.json({ ok: true, mode: 'info' }); }
  // done/failed/cancelled → 继续开发
  res.json({ ok: true, mode: 'continue' });
  runnerMod.continueTask(id, {
    store, adapters, workspace: { make: () => (t.dir || ROOT) }, runs,
    makePlan: (txt, onChild) => makePlan(txt, { mode: 'llm', agents: store.listAgents().filter((a) => (a.kind || 'cli') === 'cli' && a.enabled !== 0).map((a) => a.id), roles: store.listRoles(), depts: store.listDepts(), refine: false, templatesDir, claude: adapters.claude, onChild }),
    onEvent: broadcast,
  }, text);
});
// #1 任务重命名(仅本人/管理员)
app.post('/task/:id/rename', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  const text = ((req.body || {}).text || '').trim();
  if (!t || !text) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  store.renameTask(id, text);
  broadcastRaw({ type: 'task' });
  res.json({ ok: true });
});
app.post('/task/:id/pause', (req, res) => {
  const id = Number(req.params.id);
  if (!owns(req.user, store.getTask(id))) return res.status(403).json({ ok: false });
  const ok = runnerMod.pauseTask(id, runs, store);
  broadcastRaw({ type: 'msg', taskId: id });
  res.json({ ok });
});
app.post('/task/:id/budget', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  if (!t) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  const b = Number((req.body || {}).budget) || 0;
  store.setTaskBudget(id, b);
  store.addTaskMsg(id, 'system', '💰 成本上限已调整为 ' + (b > 0 ? '$' + b : '不限') + '。' + (t.status === 'paused' ? '发消息或点「继续」即恢复执行(已完成步骤不重跑)。' : ''));
  broadcastRaw({ type: 'msg', taskId: id });
  res.json({ ok: true, budget: b });
});
app.post('/task/:id/skip', (req, res) => {
  const id = Number(req.params.id); const stepId = (req.body || {}).stepId;
  if (!owns(req.user, store.getTask(id))) return res.status(403).json({ ok: false });
  const ok = runnerMod.skipStep(id, runs, store, stepId);
  broadcastRaw({ type: 'msg', taskId: id });
  res.json({ ok });
});
app.post('/task/:id/rerun', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id); const stepId = (req.body || {}).stepId;
  if (!t || !stepId) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false });
  if (t.status === 'running' || t.status === 'planning') return res.json({ ok: false, error: '运行中不能重跑单步' });
  res.json({ ok: true });
  runnerMod.rerunStep(id, { store, adapters, workspace: taskWorkspace(t), runs, onEvent: broadcast }, stepId);
});

// 重新规划:推翻当前计划,从原需求重新拆分并执行(方向错了时用;清旧步骤,运行中需先停)
app.post('/task/:id/replan', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  if (!t) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  if (t.status === 'running' || t.status === 'planning') return res.json({ ok: false, error: '运行中不能重规划,请先停止' });
  store.clearSteps(id); // 清旧步骤,避免残留误判进度
  // 清旧交接全文:新计划步骤 id 常与旧同名(scaffold_ui 等通用名),残留文件会把上一轮的全文当"上游交接"喂给新员工
  if (t.dir) { try { fs.rmSync(path.join(t.dir, '交接'), { recursive: true, force: true }); } catch (e) {} }
  if (store.addEvent) store.addEvent(id, 'replan', {});
  store.addTaskMsg(id, 'system', '🔄 已推翻原计划,正在按原需求重新拆分。');
  res.json({ ok: true });
  const allAgents = store.listAgents().filter((a) => (a.kind || 'cli') === 'cli' && a.enabled !== 0).map((a) => a.id);
  runTask(id, {
    store, adapters, workspace: taskWorkspace(t), runs, onEvent: broadcast,
    makePlan: (text) => makePlan(text, { agents: allAgents, roles: store.listRoles(), depts: store.listDepts(), deptPools: store.allDeptExecutors(), refine: true, templatesDir, claude: adapters.claude }),
  });
});

// 批量清理:删除本人指定状态的任务(默认失败/取消的废弃任务);运行中的不动
app.post('/api/tasks/cleanup', (req, res) => {
  const statuses = Array.isArray(req.body && req.body.statuses) && req.body.statuses.length ? req.body.statuses : ['failed', 'cancelled'];
  const safe = statuses.filter((s) => ['failed', 'cancelled', 'done'].includes(s)); // 只允许清终态,不清运行中
  const delTasks = store.listTasks().filter((t) => safe.includes(t.status) && owns(req.user, t));
  delTasks.forEach((t) => { store.deleteTask(t.id); reapTaskDir(t); }); // 同时回收 worktree/data 产出目录,防孤儿 + 防重启复活
  broadcastRaw({ type: 'task' });
  res.json({ ok: true, n: delTasks.length });
});

// 批量重试:重跑本人所有失败任务(限额恢复/临时故障后一键恢复);已完成步骤不重跑
app.post('/api/tasks/retry-all', (req, res) => {
  const list = store.listTasks().filter((t) => t.status === 'failed' && owns(req.user, t));
  list.forEach((t) => { try { require('./runner').retryFailed(t.id, { store, adapters, workspace: taskWorkspace(t), runs, onEvent: broadcast }); } catch (e) {} });
  res.json({ ok: true, n: list.length });
});

// 删除任务(+全部关联数据);运行中需先停
app.delete('/task/:id', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  if (!t) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  if (t.status === 'running' || t.status === 'planning') return res.json({ ok: false, error: '运行中不能删除,请先停止' });
  store.deleteTask(id);
  reapTaskDir(t); // 回收 worktree 或非worktree产出目录:防孤儿累积 + 防重启被 importDataDir 复活删除的任务
  broadcastRaw({ type: 'task' });
  res.json({ ok: true });
});
// 删任务后回收其磁盘目录:worktree→reapWorktree;非worktree→删 data/ 下的产出目录(限 ROOT/data 内,防误删)
function reapTaskDir(t) {
  try {
    if (t.isolate === 'worktree') reapWorktree(ROOT, t.id);
    else if (t.dir) { const d = path.resolve(t.dir); if (d.startsWith(path.resolve(ROOT, 'data') + path.sep)) { store.addEvent(0, 'deleted_dir', d); fs.rmSync(d, { recursive: true, force: true }); } } // 先记墓碑再删:rmSync 若因子进程锁文件抛 EPERM,墓碑仍在→importDataDir 不会重启复活该任务
  } catch (e) {}
}

// #15 doctor:状态对账自检(参考 PlanWeave doctor)——扫僵尸任务/孤儿 worktree,只报告;repair 才动手
app.get('/api/doctor', adminOnly, (req, res) => {
  const issues = [];
  const tasks = store.listTasks(); const taskIds = new Set(tasks.map((t) => t.id));
  tasks.forEach((t) => { if ((t.status === 'running' || t.status === 'planning') && !runs.has(t.id)) issues.push({ kind: 'zombie_task', id: t.id, detail: '任务 ' + t.id + '「' + (t.text || '').slice(0, 24) + '」状态=' + t.status + ' 但无在跑进程(僵尸)' }); });
  try { listWorktreeIds(ROOT).forEach((id) => { if (!taskIds.has(id)) issues.push({ kind: 'orphan_worktree', id, detail: 'worktrees/task-' + id + ' 对应任务已删除(孤儿目录+分支)' }); }); } catch (e) {}
  try { listDataDirs(ROOT).forEach(({ id, dir }) => { if (!taskIds.has(id)) issues.push({ kind: 'orphan_datadir', id, detail: 'data 目录 ' + path.relative(ROOT, dir).replace(/\\/g, '/') + ' 对应任务已删除(孤儿产出目录,占磁盘)' }); }); } catch (e) {}
  res.json({ ok: issues.length === 0, issues });
});
app.post('/api/doctor/repair', adminOnly, (req, res) => {
  let fixed = 0;
  const tasks = store.listTasks(); const taskIds = new Set(tasks.map((t) => t.id));
  tasks.forEach((t) => { if ((t.status === 'running' || t.status === 'planning') && !runs.has(t.id)) { store.setTaskStatus(t.id, 'failed'); store.addEvent(t.id, 'task', 'failed'); store.addTaskMsg(t.id, 'system', '🩺 健康自检:僵尸任务(无在跑进程)已标记失败,可「重试失败步骤」续跑。'); fixed++; } });
  try { listWorktreeIds(ROOT).forEach((id) => { if (!taskIds.has(id) && reapWorktree(ROOT, id)) fixed++; }); } catch (e) {}
  try { listDataDirs(ROOT).forEach(({ id, dir }) => { if (!taskIds.has(id)) { try { fs.rmSync(dir, { recursive: true, force: true }); fixed++; } catch (e) {} } }); } catch (e) {} // 孤儿产出目录:任务已删→产出不可访问,清理回收磁盘
  broadcastRaw({ type: 'task' });
  res.json({ ok: true, fixed });
});

// 重试失败步骤:已完成的不重跑(限额/临时故障恢复后续跑)
app.post('/task/:id/retry', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  if (!t) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  if (t.status === 'running' || t.status === 'planning' || t.status === 'meeting') return res.json({ ok: false, error: '任务进行中,不能重试(会双跑),请先停止' });
  res.json({ ok: true });
  require('./runner').retryFailed(id, { store, adapters, workspace: taskWorkspace(t), runs, onEvent: broadcast });
});

// 审批批准:用(可能编辑过的)plan 执行
app.post('/task/:id/approve', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  if (!t) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  if (t.status !== 'awaiting') return res.json({ ok: false, error: '任务不在待审批状态(可能已批准)' }); // 防重复批准把同一计划并发跑两遍
  let plan = req.body && req.body.plan;
  if (!plan) { try { plan = JSON.parse(t.plan); } catch (e) { plan = { steps: [] }; } }
  require('./planner').sanitizeDeps(plan); // 用户可能编辑坏依赖(循环/悬空)→ 健全化防卡死
  res.json({ ok: true });
  require('./runner').runApproved(id, { store, adapters, workspace: taskWorkspace(t), runs, onEvent: broadcast }, plan);
});

const { execSync } = require('child_process');
app.post('/task/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  if (!owns(req.user, store.getTask(id))) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  const rec = runs.get(id);
  if (rec) {
    rec.cancelled = true;
    // 只杀仍存活的子进程,且按 PID 定向(绝不按镜像名):避免 PID 被回收后误杀无关进程(极端下可能是别的 claude 会话)
    rec.children.forEach((c) => killTree(c));
  }
  // 会议中取消:一并关会议,否则会议室仍 open,用户/员工还能继续发言触发 LLM(取消后继续烧钱)
  try { const mt = store.getMeeting(id); if (mt && mt.status === 'open') { store.setMeetingStatus(id, 'closed', ''); store.addMeetingMsg(id, { role: 'system', name: '会议室', avatar: '🏛', text: '任务已取消,会议关闭。' }); } } catch (e) {}
  store.clearTaskDecision(id); // 挂起的裁决/决策问题一并清掉,防残留误导
  store.setTaskStatus(id, 'cancelled'); store.addEvent(id, 'task', 'cancelled'); broadcast({ taskId: id, type: 'task', data: 'cancelled' });
  res.json({ ok: true });
});

// 产出改动:commit 列表 + 单个 commit 的 diff(参考 Conductor/vibe-kanban 改动审查)
const { execSync: ex2 } = require('child_process');
app.get('/api/diff/:id', (req, res) => {
  const t = store.getTask(Number(req.params.id));
  if (!canSeeTask(req.user, t)) return res.status(403).json([]);
  if (!t || !t.dir || !fs.existsSync(path.join(t.dir, '.git'))) return res.json([]);
  try {
    const out = ex2('git log --format=%H%x09%ad%x09%s --date=format:"%m-%d %H:%M" -50', { cwd: t.dir }).toString().trim();
    res.json(out ? out.split('\n').map((l) => { const [sha, date, ...s] = l.split('\t'); return { sha, date, subject: s.join('\t') }; }) : []);
  } catch (e) { res.json([]); }
});
app.get('/api/diff/:id/:sha', (req, res) => {
  const t = store.getTask(Number(req.params.id));
  if (!canSeeTask(req.user, t)) return res.status(403).json({ ok: false });
  if (!t || !t.dir || !/^[0-9a-f]{7,40}$/i.test(req.params.sha)) return res.json({ patch: '' });
  try {
    const patch = ex2('git show --stat --patch ' + req.params.sha, { cwd: t.dir, maxBuffer: 4 * 1024 * 1024 }).toString();
    res.json({ patch: patch.slice(0, 200000) });
  } catch (e) { res.json({ patch: '(读取失败)' }); }
});

// #16 运行期活编辑计划:暂停/待审批任务上编辑未开始步(改指令/删步),保存后恢复生效。
// 内存 plan 在运行中固定,故运行中禁编;已完成步服务端强制保留(防客户端误删/误改历史)。
app.post('/task/:id/edit-plan', (req, res) => {
  const t = store.getTask(Number(req.params.id));
  if (!t) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  if (t.status === 'running' || t.status === 'planning') return res.json({ ok: false, error: '运行中不能编辑计划,请先暂停' });
  const incoming = req.body && req.body.plan;
  if (!incoming || !Array.isArray(incoming.steps)) return res.json({ ok: false, error: '计划为空或格式错误' });
  let cur = {}; try { cur = JSON.parse(t.plan) || {}; } catch (e) {}
  cur.task = t.text;
  const doneIds = store.doneSteps(t.id).map((s) => s.step_id); // 已完成步:合并时强制保留,不受客户端编辑影响
  const planner = require('./planner');
  const merged = planner.mergeEditedPlan(cur, incoming, doneIds);
  // 审查LOW-3:拒绝保存结构不合法的计划(官方UI不会产出,防原始API写坏致恢复时 runStep 抛「未知agent」中断)。
  // 用 lintPlan 递归校验(含 loop body):存库计划已过 resolveRoles,叶子步必须带 agent(role-only 会抛错),故 hasRole=false。
  const probs = planner.lintPlan(merged, false);
  if (probs.length) return res.json({ ok: false, error: '计划结构不合法,拒绝保存: ' + probs.join('; ') });
  store.setPlan(t.id, merged);
  store.addTaskMsg(t.id, 'system', '✎ 计划已编辑保存;恢复任务时对尚未开始的步骤生效(已完成步不受影响)。');
  broadcast({ taskId: t.id, type: 'task', data: t.status });
  res.json({ ok: true });
});

// #12 计划版本(动态重规划快照):列出 + 恢复(回滚坏的重规划)
app.get('/api/plan-versions/:id', (req, res) => {
  const t = store.getTask(Number(req.params.id));
  if (!t || !owns(req.user, t)) return res.json([]); // 仅归属者/管理员可见(含可恢复权)
  const vs = store.listPlanVersions(t.id).map((v) => {
    let n = 0; try { const pv = store.getPlanVersion(t.id, v.version); n = (JSON.parse((pv && pv.plan) || '{}').steps || []).length; } catch (e) {}
    return { version: v.version, reason: v.reason || '', created_at: v.created_at, steps: n };
  });
  res.json(vs);
});
app.post('/task/:id/plan-restore', (req, res) => {
  const t = store.getTask(Number(req.params.id));
  if (!t) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  if (t.status === 'running' || t.status === 'planning') return res.json({ ok: false, error: '任务运行中,先停止再恢复计划' });
  const version = Number((req.body || {}).version);
  const v = store.getPlanVersion(t.id, version);
  if (!v) return res.json({ ok: false, error: '版本不存在' });
  let plan = {}; try { plan = JSON.parse(v.plan) || {}; } catch (e) { return res.json({ ok: false, error: '版本数据损坏' }); }
  let cur = {}; try { cur = JSON.parse(t.plan) || {}; } catch (e) {}
  store.savePlanVersion(t.id, cur, '恢复到 v' + version + ' 前的快照'); // 恢复也可再回滚
  store.setPlan(t.id, plan);
  store.addTaskMsg(t.id, 'system', '↩ 已恢复到计划 v' + version + '(' + (v.reason || '') + ')。用「重试失败步骤」或「继续开发」按此计划推进。');
  broadcast({ taskId: t.id, type: 'task', data: t.status });
  res.json({ ok: true });
});

// 任务回放:事件时间线 + 每步日志(参考 Manus 会话回放)
app.get('/api/replay/:id', (req, res) => {
  const t = store.getTask(Number(req.params.id));
  if (!canSeeTask(req.user, t)) return res.status(403).json({ ok: false });
  const events = store.getEvents(t.id).map((e) => { let d = null; try { d = JSON.parse(e.data); } catch (x) { d = e.data; } return { ts: e.ts, type: e.type, data: d }; });
  const logsByStep = {};
  store.getLogs(t.id).forEach((l) => { (logsByStep[l.step_id || ''] = logsByStep[l.step_id || ''] || []).push(l.line); });
  res.json({ task: t.text, status: t.status, events, logsByStep });
});

// —— 定时任务:每分钟检查,到点自动建任务(参考 Manus Scheduled Tasks) ——
app.get('/api/schedules', (req, res) => res.json(store.listSchedules().filter((s) => req.user.admin || s.owner === req.user.name).map((s) => { let spec = {}; try { spec = JSON.parse(s.spec || '{}') || {}; } catch (e) {} return { ...s, spec }; }))); // 单条坏 spec 不掀翻整个列表接口
app.post('/api/schedules', (req, res) => {
  const b = req.body || {};
  if (!b.text || !b.spec || !b.spec.kind) return res.json({ ok: false, error: '缺 text/spec' });
  const id = store.addSchedule({ text: b.text, project: b.project, owner: req.user.name, spec: b.spec, dept: b.dept, agents: b.agents, models: b.models, playbook: b.playbook });
  res.json({ id });
});
app.post('/api/schedules/:id/toggle', (req, res) => {
  const s = store.listSchedules().find((x) => x.id === Number(req.params.id));
  if (!s || (!req.user.admin && s.owner !== req.user.name)) return res.status(403).json({ ok: false });
  store.setScheduleEnabled(s.id, !s.enabled); res.json({ ok: true });
});
app.delete('/api/schedules/:id', (req, res) => {
  const s = store.listSchedules().find((x) => x.id === Number(req.params.id));
  if (!s || (!req.user.admin && s.owner !== req.user.name)) return res.status(403).json({ ok: false });
  store.deleteSchedule(s.id); res.json({ ok: true });
});

const { scheduleDue } = require('./schedule'); // 截止式到点判断(重启/漂移可补跑)
setInterval(() => {
  const now = new Date();
  store.listSchedules().filter((s) => s.enabled).forEach((s) => {
    if (!scheduleDue(s, now)) return;
    store.setScheduleRun(s.id);
    try {
      const body = { text: s.text, project: s.project, dept: s.dept || null, agents: JSON.parse(s.agents || '[]'), models: s.models ? JSON.parse(s.models) : null, playbook: s.playbook || null, refine: false };
      const id = createAndRunTask(s.owner, body);
      store.addEvent(id, 'scheduled', { schedule: s.id });
      console.log('定时任务触发: schedule', s.id, '→ task', id);
    } catch (e) { console.log('定时任务失败:', e.message); }
  });
}, 60 * 1000).unref();

const server = app.listen(3000, () => console.log('orch http://localhost:3000'));
const wss = new WebSocketServer({ server });

// 重启恢复:上次因执行器限额失败、已排定自动重试的任务,重启后 setTimeout 定时器已丢失 → 重新排定。
// scheduleAutoRetry 自带命中判断(仅限额类失败)与 ≤2 次上限,对无关失败任务自动跳过。
store.listTasks().filter((t) => t.status === 'failed').forEach((t) => {
  try { require('./runner').scheduleAutoRetry(t.id, { store, adapters, workspace: taskWorkspace(t), runs, onEvent: broadcast }); } catch (e) {}
});

const activity = []; // 真实活动流环形缓冲(最新在前)
// roleMap/roleView 缓存:toActivity 对每条 status 广播都重建(87 角色 + 部门全表),并发多任务每秒几十次。
// 角色/部门/执行器极少变,变更统一走 broadcastRaw({type:'agents'})——在那清缓存即可。
let _rmCache = null, _rvCache = null;
const roleMapCached = () => _rmCache || (_rmCache = api.roleMap(store));
const roleViewCached = () => _rvCache || (_rvCache = api.roleView(store));
function broadcastRaw(ev) {
  if (ev && ev.type === 'agents') { _rmCache = null; _rvCache = null; } // 角色/部门/执行器变更 → 失效缓存
  const msg = JSON.stringify(ev);
  // 单个客户端 send 抛错(socket 刚好关闭的 TOCTOU)不得中断其它客户端广播,更不得沿 onEvent 冒泡进引擎把好任务搞成 failed
  wss.clients.forEach((c) => { if (c.readyState === 1) { try { c.send(msg); } catch (e) {} } });
}
function hhmmss() { const d = new Date(), z = (n) => (n < 10 ? '0' + n : '' + n); return z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds()); }
function toActivity(ev) {
  const { taskId, stepId, type, data } = ev;
  // 只有 plan/status/task 进活动流;log/usage 等最高频事件直接早退,不再白跑 getTask+roleMap+roleView+planRoleMap 4 次查询
  if (type !== 'plan' && type !== 'status' && type !== 'task') return null;
  const time = hhmmss();
  if (type === 'plan') return { a: '编排器', c: '#1A1814', t: '拆解为 ' + ((data && data.steps && data.steps.length) || 0) + ' 步流水线', dot: '#F0B400', soft: '#FFF6D6', time };
  if (type === 'task') return { a: '编排器', c: '#1A1814', t: data === 'done' ? '任务完成 ✓' : ('任务结束: ' + data), dot: data === 'done' ? '#2E9E5B' : '#DC5B52', soft: data === 'done' ? '#E4F4EA' : '#FBE9E7', time };
  // 仅 status 的 running/done/failed 需查库算员工署名(waiting/blocked 等不进流,免查询)
  if (data !== 'running' && data !== 'done' && data !== 'failed') return null;
  const t = store.getTask(taskId);
  const st = t && t.steps ? t.steps.find((x) => x.step_id === stepId) : null;
  const role = st && roleMapCached()[st.agent];
  const emp = t && stepId ? (roleViewCached()[api.planRoleMap(t)[stepId]] || null) : null; // 员工署名优先(缓存 roleMap/roleView)
  const who = emp ? (emp.deptName + '·' + emp.name) : (role ? role.label : '编排器');
  const c = emp ? emp.color : (role ? role.color : '#1A1814');
  if (data === 'running') return { a: who, c, t: '开始 ' + stepId, dot: '#F0B400', soft: '#FFF6D6', time };
  if (data === 'done') return { a: who, c, t: '完成 ' + stepId + ' ✓', dot: '#2E9E5B', soft: '#E4F4EA', time };
  return { a: who, c, t: stepId + ' 失败,退回', dot: '#DC5B52', soft: '#FBE9E7', time }; // failed
}
function broadcast(ev) {
  const a = toActivity(ev);
  if (a) { activity.unshift(a); if (activity.length > 40) activity.length = 40; broadcastRaw({ type: 'activity', data: a }); }
  broadcastRaw(ev);
  if (ev.type === 'task' && process.env.ORCH_NOTIFY_URL) notifyOutbound(ev); // 出站推送:离机也能收结果
}
// 外部渠道推送(设 ORCH_NOTIFY_URL 即启用,指向自有 ntfy/Slack/Discord/飞书 webhook)。
// fire-and-forget + 超时 + 静默:绝不冒泡进引擎把好任务判 failed(同 broadcastRaw 隔离原则)。
const NOTIFY_STATES = new Set(['done', 'failed', 'paused', 'awaiting_input', 'cancelled']);
function notifyOutbound(ev) {
  try {
    const status = String(ev.data || '').split(':')[0].trim(); // 'failed: xxx'(catch分支)→ 'failed'
    if (!NOTIFY_STATES.has(status)) return;
    const t = store.getTask(ev.taskId); if (!t) return;
    const u = store.taskUsage ? store.taskUsage(ev.taskId) : { cost: 0 };
    let failReason = '';
    if (status === 'failed') { const fs = (t.steps || []).filter((s) => s.status === 'failed' && s.output); const last = fs[fs.length - 1]; if (last) failReason = String(last.output).replace(/\s+/g, ' ').slice(-200); }
    const body = JSON.stringify({ id: t.id, status, text: t.text, cost: (u && u.cost) || 0, failReason, url: 'http://localhost:3000/#task-' + t.id });
    fetch(process.env.ORCH_NOTIFY_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) }).catch(() => {});
  } catch (e) { /* 推送失败绝不影响任务 */ }
}
