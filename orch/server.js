const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { open } = require('./store');
const { makePlan } = require('./planner');
const { makeWorkspace } = require('./workspace');
const { runTask } = require('./runner');

const ROOT = process.cwd();
const store = open(path.join(__dirname, 'orch.db'));
const adapters = {
  claude: require('./adapters/claude'),
  codex: require('./adapters/codex'),
};
const workspace = makeWorkspace(ROOT);
const templatesDir = path.join(__dirname, 'templates');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

app.get('/tasks', (req, res) => res.json(store.listTasks()));
app.get('/task/:id', (req, res) => res.json(store.getTask(Number(req.params.id))));
app.get('/task/:id/logs', (req, res) => res.json(store.getLogs(Number(req.params.id))));
app.post('/task', (req, res) => {
  const id = store.createTask(req.body.text);
  res.json({ id });
  runTask(id, {
    store, adapters, workspace,
    makePlan: (text) => makePlan(text, { templatesDir, claude: adapters.claude }),
    onEvent: broadcast,
  });
});

const server = app.listen(3000, () => console.log('orch http://localhost:3000'));
const wss = new WebSocketServer({ server });
function broadcast(ev) {
  const msg = JSON.stringify(ev);
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
}
