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
boot.recoverZombies(store); // 上次进程中断的任务 → 标失败可重试
let adapters = boot.buildAdapters(store);
if (boot.scanAgents(store)) adapters = boot.buildAdapters(store);
const listFilesIn = boot.listFilesIn;
let health = boot.checkHealth(store); // 执行器健康(启动检测,缓存)

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
// Webhook 触发(鉴权闸前,凭 token):外部系统 POST /hook/<token> {text,project?} 即建任务
app.post('/hook/:token', (req, res) => {
  const p = store.personByHookToken(req.params.token);
  if (!p) return res.status(401).json({ error: 'bad token' });
  const text = ((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: '缺 text' });
  const id = createAndRunTask(p.name, { text, project: (req.body || {}).project, refine: false });
  store.addEvent(id, 'webhook', { by: p.id });
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
app.get('/api/agentlog/:id', (req, res) => res.json(api.agentLog(store, req.params.id)));
// 执行器健康(缓存;?refresh=1 重测)
app.get('/api/health', (req, res) => { if (req.query.refresh) health = boot.checkHealth(store); res.json(health); });

app.post('/api/agents', adminOnly, (req, res) => {
  const id = store.addAgent(req.body || {});
  adapters = boot.buildAdapters(store);
  health = boot.checkHealth(store);
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
app.get('/api/roles/:id', adminOnly, (req, res) => { const r = store.getRole(req.params.id); if (!r) return res.status(404).json({ error: '员工不存在' }); res.json({ id: r.id, dept: r.dept, name: r.name, description: r.description || '', prompt: r.prompt || '', executor: r.executor || 'claude' }); });
app.put('/api/roles/:id', adminOnly, (req, res) => { const ok = store.updateRole(req.params.id, req.body || {}); broadcastRaw({ type: 'agents' }); res.json({ ok }); });

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

// 建任务并启动:表单/定时任务/Webhook 共用
function createAndRunTask(ownerName, body) {
  const project = body.project || '默认项目';
  const models = body.models && typeof body.models === 'object' ? body.models : null; // {执行器id:{model,effort}}
  const id = store.createTask(body.text, project, ownerName, { budget: body.budget, approve: body.approve, isolate: body.isolate, ask: body.ask, models });
  const ws = taskWorkspace(store.getTask(id));
  store.setTaskDir(id, ws.make()); // 持久化产出目录(供预览/打开)
  const allAgents = store.listAgents().filter((a) => (a.kind || 'cli') === 'cli').map((a) => a.id);
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
app.get('/api/playbooks', (req, res) => res.json(store.listPlaybooks().map((p) => ({ id: p.id, name: p.name, description: p.description }))));
app.delete('/api/playbooks/:id', adminOnly, (req, res) => { store.deletePlaybook(Number(req.params.id)); broadcastRaw({ type: 'agents' }); res.json({ ok: true }); });

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
  if (!canSeeTask(req.user, t)) return res.sendStatus(403);
  if (!t || !t.dir) return res.sendStatus(404);
  const rel = [].concat(req.params.splat || []).join('/'); // Express5 命名通配
  const full = path.resolve(t.dir, rel);
  if (!full.startsWith(path.resolve(t.dir))) return res.sendStatus(403);
  res.sendFile(full);
});

// —— 任务会话化:统一消息入口(按任务状态智能路由) + 实时控制面 ——
const runnerMod = require('./runner');
app.get('/api/msgs/:id', (req, res) => {
  const t = store.getTask(Number(req.params.id));
  if (!canSeeTask(req.user, t)) return res.status(403).json([]);
  res.json(store.getTaskMsgs(t.id));
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
  if (t.status === 'awaiting_input') { res.json({ ok: true, mode: 'answer' }); return runnerMod.resumeTask(id, deps(), t.blocked_step, text); }
  if (t.status === 'awaiting') { store.addTaskMsg(id, 'system', '任务在等审批,请先「批准并运行」(可先编辑计划)。'); broadcastRaw({ type: 'msg', taskId: id }); return res.json({ ok: true, mode: 'info' }); }
  // done/failed/cancelled → 继续开发
  res.json({ ok: true, mode: 'continue' });
  runnerMod.continueTask(id, {
    store, adapters, workspace: { make: () => (t.dir || ROOT) }, runs,
    makePlan: (txt) => makePlan(txt, { mode: 'llm', agents: store.listAgents().filter((a) => (a.kind || 'cli') === 'cli').map((a) => a.id), roles: store.listRoles(), depts: store.listDepts(), refine: false, templatesDir, claude: adapters.claude }),
    onEvent: broadcast,
  }, text);
});
app.post('/task/:id/pause', (req, res) => {
  const id = Number(req.params.id);
  if (!owns(req.user, store.getTask(id))) return res.status(403).json({ ok: false });
  const ok = runnerMod.pauseTask(id, runs, store);
  broadcastRaw({ type: 'msg', taskId: id });
  res.json({ ok });
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
  if (store.addEvent) store.addEvent(id, 'replan', {});
  store.addTaskMsg(id, 'system', '🔄 已推翻原计划,正在按原需求重新拆分。');
  res.json({ ok: true });
  const allAgents = store.listAgents().filter((a) => (a.kind || 'cli') === 'cli').map((a) => a.id);
  runTask(id, {
    store, adapters, workspace: taskWorkspace(t), runs, onEvent: broadcast,
    makePlan: (text) => makePlan(text, { agents: allAgents, roles: store.listRoles(), depts: store.listDepts(), deptPools: store.allDeptExecutors(), refine: true, templatesDir, claude: adapters.claude }),
  });
});

// 批量清理:删除本人指定状态的任务(默认失败/取消的废弃任务);运行中的不动
app.post('/api/tasks/cleanup', (req, res) => {
  const statuses = Array.isArray(req.body && req.body.statuses) && req.body.statuses.length ? req.body.statuses : ['failed', 'cancelled'];
  const safe = statuses.filter((s) => ['failed', 'cancelled', 'done'].includes(s)); // 只允许清终态,不清运行中
  const del = store.listTasks().filter((t) => safe.includes(t.status) && owns(req.user, t)).map((t) => t.id);
  del.forEach((id) => store.deleteTask(id));
  broadcastRaw({ type: 'task' });
  res.json({ ok: true, n: del.length });
});

// 删除任务(+全部关联数据);运行中需先停
app.delete('/task/:id', (req, res) => {
  const id = Number(req.params.id); const t = store.getTask(id);
  if (!t) return res.json({ ok: false });
  if (!owns(req.user, t)) return res.status(403).json({ ok: false, error: '无权限:非本人任务' });
  if (t.status === 'running' || t.status === 'planning') return res.json({ ok: false, error: '运行中不能删除,请先停止' });
  store.deleteTask(id);
  broadcastRaw({ type: 'task' });
  res.json({ ok: true });
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
app.get('/api/schedules', (req, res) => res.json(store.listSchedules().filter((s) => req.user.admin || s.owner === req.user.name).map((s) => ({ ...s, spec: JSON.parse(s.spec || '{}') }))));
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

// 到点判断:daily HH:MM / weekly dow+HH:MM / every N 小时
function scheduleDue(s, now) {
  let spec = {}; try { spec = JSON.parse(s.spec || '{}'); } catch (e) { return false; }
  const last = s.last_run ? new Date(s.last_run) : null;
  const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (spec.kind === 'hours') return !last || (now - last) >= (Number(spec.n) || 1) * 3600e3;
  if (spec.kind === 'daily') return hhmm(now) === spec.at && (!last || last.toDateString() !== now.toDateString());
  if (spec.kind === 'weekly') return now.getDay() === Number(spec.dow) && hhmm(now) === spec.at && (!last || (now - last) > 6 * 24 * 3600e3);
  return false;
}
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
