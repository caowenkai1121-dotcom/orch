const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { open } = require('./store');
const { makePlan } = require('./planner');
const { makeWorkspace } = require('./workspace');
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
  return m;
}
let adapters = buildAdapters();
const workspace = makeWorkspace(ROOT);
const templatesDir = path.join(__dirname, 'templates');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

app.get('/tasks', (req, res) => res.json(store.listTasks()));
app.get('/task/:id', (req, res) => res.json(store.getTask(Number(req.params.id))));
app.get('/task/:id/logs', (req, res) => res.json(store.getLogs(Number(req.params.id))));

// Maestro 前端的真实数据聚合
app.get('/api/all', (req, res) => res.json({ ...api.buildAll(store), activity: activity.slice(0, 18) }));
app.get('/api/relay/:id', (req, res) => res.json(api.relay(store, Number(req.params.id))));
app.get('/api/plan/:id', (req, res) => res.json(api.plan(store, Number(req.params.id))));
app.get('/api/agentlog/:id', (req, res) => res.json(api.agentLog(store, req.params.id)));

app.post('/api/agents', (req, res) => {
  const id = store.addAgent(req.body || {});
  adapters = buildAdapters();
  broadcastRaw({ type: 'agents' });
  res.json({ id });
});
app.post('/api/people', (req, res) => res.json({ id: store.addPerson(req.body || {}) }));
app.post('/api/people/:id/agents', (req, res) => { store.setPersonAgents(req.params.id, (req.body || {}).agentIds || []); res.json({ ok: true }); });

app.post('/task', (req, res) => {
  const id = store.createTask(req.body.text, req.body.project);
  res.json({ id });
  runTask(id, {
    store, adapters, workspace,
    makePlan: (text) => makePlan(text, { mode: req.body.mode, agents: store.listAgents().map((a) => a.id), templatesDir, claude: adapters.claude }),
    onEvent: broadcast,
  });
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
