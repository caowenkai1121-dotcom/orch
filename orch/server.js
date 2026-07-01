const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const { open } = require('./store');
const { makePlan } = require('./planner');
const { makeWorkspace, taskDir, worktreeDir } = require('./workspace');
const { runTask } = require('./runner');
const api = require('./api');
const generic = require('./adapters/generic');

const ROOT = process.cwd();
const store = open(path.join(__dirname, 'orch.db'));
store.seed();

// 适配器注册表从 DB 的 agent 定义构建,新增 agent 后重建
function buildAdapters() {
  const m = { echo: require('./adapters/echo') };
  store.listAgents().forEach((a) => { m[a.id] = generic.make(a); });
  m.claude = require('./adapters/claude'); // claude 用 stream-json 专用适配器
  return m;
}
let adapters = buildAdapters();
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

// 权限助手
const owns = (u, t) => !!(u && t && (u.admin || t.owner === u.name));
function visibleProjects(u) { // null=全部可见(管理员)
  if (!u || u.admin) return null;
  const set = new Set();
  store.listTasks().forEach((t) => { if (t.owner === u.name) set.add(t.project || '默认项目'); });
  store.listGrants().forEach((g) => { if (g.user_id === u.id) set.add(g.project); });
  store.listProjects().forEach((p) => { if (p.owner === u.id) set.add(p.name); });
  return set;
}
const canSeeTask = (u, t) => { if (!u || !t) return false; if (u.admin || t.owner === u.name) return true; const s = visibleProjects(u); return !!(s && s.has(t.project || '默认项目')); };

app.get('/tasks', (req, res) => res.json(store.listTasks()));
app.get('/task/:id', (req, res) => { const t = store.getTask(Number(req.params.id)); if (!canSeeTask(req.user, t)) return res.status(403).json({ error: '无权限' }); res.json(t); });
app.get('/task/:id/logs', (req, res) => { if (!canSeeTask(req.user, store.getTask(Number(req.params.id)))) return res.status(403).json([]); res.json(store.getLogs(Number(req.params.id))); });

// Maestro 前端的真实数据聚合(按当前用户过滤)
app.get('/api/all', (req, res) => res.json({ ...api.buildAll(store, req.user), activity: activity.slice(0, 18) }));
app.get('/api/relay/:id', (req, res) => { if (!canSeeTask(req.user, store.getTask(Number(req.params.id)))) return res.status(403).json([]); res.json(api.relay(store, Number(req.params.id))); });
app.get('/api/plan/:id', (req, res) => { if (!canSeeTask(req.user, store.getTask(Number(req.params.id)))) return res.status(403).json([]); res.json(api.plan(store, Number(req.params.id))); });
app.get('/api/agentlog/:id', (req, res) => res.json(api.agentLog(store, req.params.id)));

const adminOnly = (req, res, next) => req.user.admin ? next() : res.status(403).json({ error: '需管理员' });
app.post('/api/agents', adminOnly, (req, res) => {
  const id = store.addAgent(req.body || {});
  adapters = buildAdapters();
  broadcastRaw({ type: 'agents' });
  res.json({ id });
});
app.put('/api/agents/:id', adminOnly, (req, res) => { store.updateAgent(req.params.id, req.body || {}); adapters = buildAdapters(); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });
app.delete('/api/agents/:id', adminOnly, (req, res) => { store.deleteAgent(req.params.id); adapters = buildAdapters(); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });
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

// #3 部门 CRUD + 为部门设置 agent
app.post('/api/depts', adminOnly, (req, res) => { const id = store.addDept(req.body || {}); broadcastRaw({ type: 'agents' }); res.json({ id }); });
app.delete('/api/depts/:id', adminOnly, (req, res) => { store.deleteDept(req.params.id); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });
app.post('/api/depts/:id/agents', adminOnly, (req, res) => { ((req.body || {}).agentIds || []).forEach((a) => store.setAgentDept(a, req.params.id)); adapters = buildAdapters(); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });

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
  const id = store.createTask(req.body.text, project, owner, { budget: req.body.budget, approve: req.body.approve, isolate: req.body.isolate, ask: req.body.ask });
  const ws = taskWorkspace(store.getTask(id));
  store.setTaskDir(id, ws.make()); // 持久化产出目录(供预览/打开)
  res.json({ id });
  const allAgents = store.listAgents().map((a) => a.id);
  const sel = (Array.isArray(req.body.agents) && req.body.agents.length) ? req.body.agents.filter((a) => allAgents.includes(a)) : allAgents;
  const refine = req.body.refine === undefined ? true : !!req.body.refine;
  runTask(id, {
    store, adapters, workspace: ws, runs,
    makePlan: (text) => makePlan(text, { mode: req.body.mode, agents: sel.length ? sel : allAgents, orchestration: req.body.orchestration, refine, templatesDir, claude: adapters.claude }),
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

// 列出目录下所有文件(相对路径)
function listFilesIn(dir) {
  const out = [];
  const walk = (d, rel) => {
    if (out.length > 500) return;
    let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const it of items) {
      if (it.name === '.git' || it.name === 'node_modules') continue;
      const rp = rel ? rel + '/' + it.name : it.name;
      if (it.isDirectory()) walk(path.join(d, it.name), rp); else out.push(rp);
    }
  };
  walk(dir, '');
  return out;
}

// #1 一键发布到应用广场
app.post('/api/apps', (req, res) => {
  const taskId = Number(req.body && req.body.taskId); const t = store.getTask(taskId);
  if (!t || !t.dir) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  let entry = req.body && req.body.entry;
  if (!entry) { const fl = listFilesIn(t.dir); entry = fl.find((f) => /(^|\/)index\.html$/i.test(f)) || fl.find((f) => /\.html$/i.test(f)) || fl[0]; }
  if (!entry) return res.json({ ok: false, error: '无可发布入口' });
  const appId = store.addApp({ name: (req.body && req.body.name) || t.text, taskId, dir: t.dir, entry });
  broadcastRaw({ type: 'apps' });
  res.json({ id: appId, entry });
});
app.delete('/api/apps/:id', (req, res) => {
  const a = store.listApps().find((x) => x.id === Number(req.params.id));
  if (a && !owns(req.user, store.getTask(a.task_id))) return res.status(403).json({ ok: false });
  store.deleteApp(Number(req.params.id)); broadcastRaw({ type: 'apps' }); res.json({ ok: true });
});

// #2 继续开发:复用原任务产出目录,在已有文件上扩展
app.post('/task/:id/continue', (req, res) => {
  const pid = Number(req.params.id); const p = store.getTask(pid);
  const text = ((req.body && req.body.text) || '').trim();
  if (!p || !text) return res.json({ ok: false });
  if (!owns(req.user, p)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  const context = '【继续开发已有项目】当前工作目录已有之前产出的文件,请先查看现有文件,在其基础上扩展/修改实现新需求(不要从零重写)。新需求: ' + text;
  const id = store.createTask(text, p.project, req.user.name, { isolate: 'none', parent: pid, approve: p.approve, ask: p.ask });
  const dir = p.dir || ROOT;
  store.setTaskDir(id, dir);
  res.json({ id });
  runTask(id, {
    store, adapters, workspace: { make: () => dir }, runs,
    makePlan: () => makePlan(context, { mode: 'llm', agents: store.listAgents().map((a) => a.id), refine: false, templatesDir, claude: adapters.claude }),
    onEvent: broadcast,
  });
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
  const who = role ? role.label : '编排器';
  const c = role ? role.color : '#1A1814';
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
