const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const { open } = require('./store');
const { makePlan } = require('./planner');
const { makeWorkspace, taskDir, worktreeDir } = require('./workspace');
const { runTask } = require('./runner');
const api = require('./api');
const boot = require('./bootstrap');
const perm = require('./perm');

const ROOT = process.cwd();
const store = open(path.join(__dirname, 'orch.db'));
store.seed();
boot.importDataDir(store, ROOT);
let adapters = boot.buildAdapters(store);
if (boot.scanAgents(store)) adapters = boot.buildAdapters(store);
const listFilesIn = boot.listFilesIn;

const runs = new Map(); // 运行态注册表:taskId -> { cancelled, children }
const workspace = makeWorkspace(ROOT);
const templatesDir = path.join(__dirname, 'templates');

const app = express();
const auth = require('./auth');
app.use(express.json());
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
app.post('/logout', (req, res) => { auth.logout(auth.tokenFromReq(req)); res.setHeader('Set-Cookie', 'orch_sess=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => req.user ? res.json(pubUser(req.user)) : res.status(401).json({ error: 'unauthorized' }));
app.post('/api/me/password', (req, res) => { if (!req.user) return res.status(401).json({ error: 'unauthorized' }); store.setPassword(req.user.id, (req.body || {}).password || 'admin'); res.json({ ok: true }); });
// 鉴权闸:此后所有接口都要求登录
app.use((req, res, next) => { if (req.user) return next(); res.status(401).json({ error: 'unauthorized' }); });

// 权限助手(perm.js,服务端强制)
const { owns, canSeeTask, adminOnly } = perm.make(store);

app.get('/tasks', (req, res) => res.json(store.listTasks()));
app.get('/task/:id', (req, res) => { const t = store.getTask(Number(req.params.id)); if (!canSeeTask(req.user, t)) return res.status(403).json({ error: '无权限' }); res.json(t); });
app.get('/task/:id/logs', (req, res) => { if (!canSeeTask(req.user, store.getTask(Number(req.params.id)))) return res.status(403).json([]); res.json(store.getLogs(Number(req.params.id))); });

// Maestro 前端的真实数据聚合(按当前用户过滤)
app.get('/api/all', (req, res) => res.json({ ...api.buildAll(store, req.user), activity: activity.slice(0, 18) }));
app.get('/api/relay/:id', (req, res) => { if (!canSeeTask(req.user, store.getTask(Number(req.params.id)))) return res.status(403).json([]); res.json(api.relay(store, Number(req.params.id))); });
app.get('/api/plan/:id', (req, res) => { if (!canSeeTask(req.user, store.getTask(Number(req.params.id)))) return res.status(403).json([]); res.json(api.plan(store, Number(req.params.id))); });
app.get('/api/agentlog/:id', (req, res) => res.json(api.agentLog(store, req.params.id)));

app.post('/api/agents', adminOnly, (req, res) => {
  const id = store.addAgent(req.body || {});
  adapters = boot.buildAdapters(store);
  broadcastRaw({ type: 'agents' });
  res.json({ id });
});
app.put('/api/agents/:id', adminOnly, (req, res) => { store.updateAgent(req.params.id, req.body || {}); adapters = boot.buildAdapters(store); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });
app.delete('/api/agents/:id', adminOnly, (req, res) => { store.deleteAgent(req.params.id); adapters = boot.buildAdapters(store); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });
app.get('/api/projects', (req, res) => res.json(store.listProjects()));
app.post('/api/projects', (req, res) => {
  const id = store.addProject({ ...(req.body || {}), owner: req.user.id });
  const name = (req.body || {}).name;
  ((req.body || {}).members || []).forEach((uid) => name && store.grantProject(name, uid)); // 归属用户
  broadcastRaw({ type: 'task' });
  res.json({ id });
});
app.post('/api/people', adminOnly, (req, res) => res.json({ id: store.addPerson(req.body || {}) }));
app.post('/api/people/:id/agents', adminOnly, (req, res) => { store.setPersonAgents(req.params.id, (req.body || {}).agentIds || []); res.json({ ok: true }); });

// 员工(角色) CRUD:管理员
app.post('/api/roles', adminOnly, (req, res) => { const id = store.addRole(req.body || {}); broadcastRaw({ type: 'agents' }); res.json({ id }); });
app.delete('/api/roles/:id', adminOnly, (req, res) => { store.deleteRole(req.params.id); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });

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

app.post('/task', (req, res) => {
  const owner = req.user.name; // 归属=当前登录用户,忽略客户端传值
  const project = req.body.project || '默认项目';
  const models = req.body.models && typeof req.body.models === 'object' ? req.body.models : null; // {执行器id:模型}
  const id = store.createTask(req.body.text, project, owner, { budget: req.body.budget, approve: req.body.approve, isolate: req.body.isolate, ask: req.body.ask, models });
  const ws = taskWorkspace(store.getTask(id));
  store.setTaskDir(id, ws.make()); // 持久化产出目录(供预览/打开)
  res.json({ id });
  const allAgents = store.listAgents().filter((a) => (a.kind || 'cli') === 'cli').map((a) => a.id);
  const explicit = Array.isArray(req.body.agents) && req.body.agents.length > 0;
  const sel = explicit ? req.body.agents.filter((a) => allAgents.includes(a)) : allAgents;
  const refine = req.body.refine === undefined ? true : !!req.body.refine;
  runTask(id, {
    store, adapters, workspace: ws, runs,
    makePlan: (text) => makePlan(text, { mode: req.body.mode, agents: sel.length ? sel : allAgents, explicit, roles: store.listRoles(), depts: store.listDepts(), dept: req.body.dept || null, deptPools: store.allDeptExecutors(), orchestration: req.body.orchestration, refine, templatesDir, claude: adapters.claude }),
    onEvent: broadcast,
  });
});

// 按任务的 isolate 选工作目录:worktree(git仓内) / 每任务 data 目录(回退)
function isGit(d) { try { execSync('git rev-parse --is-inside-work-tree', { cwd: d, stdio: 'ignore' }); return true; } catch (e) { return false; } }
function taskWorkspace(t) {
  let dir = ROOT;
  try {
    if (t.isolate === 'worktree' && isGit(ROOT)) dir = worktreeDir(ROOT, t.id);
    else dir = taskDir(ROOT, t.owner, t.project, t.text, t.id);
  } catch (e) {}
  return { make: () => dir };
}
// 用户回答决策 → 续跑
app.post('/task/:id/answer', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  if (!t) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  const stepId = (req.body && req.body.stepId) || t.blocked_step;
  const answer = (req.body && req.body.answer) || '';
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
  const dir = t.dir || ROOT;
  res.json({ id });
  require('./runner').continueTask(id, {
    store, adapters, workspace: { make: () => dir }, runs,
    makePlan: (txt) => makePlan(txt, { mode: 'llm', agents: store.listAgents().filter((a) => (a.kind || 'cli') === 'cli').map((a) => a.id), roles: store.listRoles(), depts: store.listDepts(), refine: false, templatesDir, claude: adapters.claude }),
    onEvent: broadcast,
  }, text);
});

// 静态服务产出文件(供预览);防目录穿越
app.get('/output/:id/*splat', (req, res) => {
  const t = store.getTask(Number(req.params.id));
  if (!canSeeTask(req.user, t)) return res.sendStatus(403);
  if (!t || !t.dir) return res.sendStatus(404);
  const rel = [].concat(req.params.splat || []).join('/'); // Express5 命名通配
  const full = path.resolve(t.dir, rel);
  if (!full.startsWith(path.resolve(t.dir))) return res.sendStatus(403);
  res.sendFile(full);
});

// 重试失败步骤:已完成的不重跑(限额/临时故障恢复后续跑)
app.post('/task/:id/retry', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  if (!t) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  res.json({ ok: true });
  require('./runner').retryFailed(id, { store, adapters, workspace: taskWorkspace(t), runs, onEvent: broadcast });
});

// 审批批准:用(可能编辑过的)plan 执行
app.post('/task/:id/approve', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  if (!t) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  let plan = req.body && req.body.plan;
  if (!plan) { try { plan = JSON.parse(t.plan); } catch (e) { plan = { steps: [] }; } }
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
    rec.children.forEach((c) => {
      try {
        if (!c || !c.pid || c.exitCode !== null || c.killed) return; // 已退出/已杀:跳过,防 PID 回收误伤
        if (process.platform === 'win32') execSync('taskkill /T /F /PID ' + c.pid);
        else c.kill('SIGKILL');
      } catch (e) {}
    });
  }
  store.setTaskStatus(id, 'cancelled'); store.addEvent(id, 'task', 'cancelled'); broadcast({ taskId: id, type: 'task', data: 'cancelled' });
  res.json({ ok: true });
});

const server = app.listen(3000, () => console.log('orch http://localhost:3000'));
const wss = new WebSocketServer({ server });

const activity = []; // 真实活动流环形缓冲(最新在前)
function broadcastRaw(ev) {
  const msg = JSON.stringify(ev);
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
}
function hhmmss() { const d = new Date(), z = (n) => (n < 10 ? '0' + n : '' + n); return z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds()); }
function toActivity(ev) {
  const { taskId, stepId, type, data } = ev;
  const t = store.getTask(taskId);
  const st = t && t.steps ? t.steps.find((x) => x.step_id === stepId) : null;
  const role = st && api.roleMap(store)[st.agent];
  // 员工署名优先:「工程部·前端开发工程师」而非执行器名
  const emp = t && stepId ? (api.roleView(store)[api.planRoleMap(t)[stepId]] || null) : null;
  const who = emp ? (emp.deptName + '·' + emp.name) : (role ? role.label : '编排器');
  const c = emp ? emp.color : (role ? role.color : '#1A1814');
  const time = hhmmss();
  if (type === 'plan') return { a: '编排器', c: '#1A1814', t: '拆解为 ' + ((data && data.steps && data.steps.length) || 0) + ' 步流水线', dot: '#F0B400', soft: '#FFF6D6', time };
  if (type === 'status') {
    if (data === 'running') return { a: who, c, t: '开始 ' + stepId, dot: '#F0B400', soft: '#FFF6D6', time };
    if (data === 'done') return { a: who, c, t: '完成 ' + stepId + ' ✓', dot: '#2E9E5B', soft: '#E4F4EA', time };
    if (data === 'failed') return { a: who, c, t: stepId + ' 失败,退回', dot: '#DC5B52', soft: '#FBE9E7', time };
    return null;
  }
  if (type === 'task') return { a: '编排器', c: '#1A1814', t: data === 'done' ? '任务完成 ✓' : ('任务结束: ' + data), dot: data === 'done' ? '#2E9E5B' : '#DC5B52', soft: data === 'done' ? '#E4F4EA' : '#FBE9E7', time };
  return null; // log 等不进活动流(太碎)
}
function broadcast(ev) {
  const a = toActivity(ev);
  if (a) { activity.unshift(a); if (activity.length > 40) activity.length = 40; broadcastRaw({ type: 'activity', data: a }); }
  broadcastRaw(ev);
}
