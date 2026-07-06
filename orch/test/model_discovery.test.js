const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { open } = require('../store');
const { discoverModels } = require('../model_discovery');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-models-'));
}

test('发现 Codex 当前配置模型和思考级别', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n');
  const store = open(':memory:');
  store.seed();

  const out = await discoverModels(store, { home });
  const row = out.agents.codex;

  assert.equal(row.current, 'gpt-5.5');
  assert.equal(row.effort, 'xhigh');
  assert.deepEqual(row.options.map((o) => o.id), ['gpt-5.5']);
  assert.match(row.source, /codex/);
});

test('发现 Claude 配置中的可用模型并清理 ANSI 残片', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-fable-5\u001b[1m' }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ model: 'claude-opus-4-8', additionalModelOptionsCache: ['claude-sonnet-4-5', 'Fable'] }));
  const store = open(':memory:');
  store.seed();
  store.setAgentDefaults('claude', '', '');

  const out = await discoverModels(store, { home });
  const ids = out.agents.claude.options.map((o) => o.id);

  assert.equal(out.agents.claude.current, 'claude-fable-5');
  assert.ok(ids.includes('claude-fable-5'));
  assert.ok(ids.includes('claude-opus-4-8'));
  assert.ok(ids.includes('claude-sonnet-4-5'));
  assert.ok(!ids.includes('Fable'));
});

test('发现 OpenAI 兼容 API Agent 的 /models 列表且不输出密钥', async () => {
  let auth = '';
  const srv = http.createServer((req, res) => {
    auth = req.headers.authorization || '';
    assert.equal(req.url, '/v1/models');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  const store = open(':memory:');
  store.seed();
  store.addAgent({ id: 'ds', name: 'DeepSeek', kind: 'llm', base_url: 'http://127.0.0.1:' + port + '/v1', api_key: 'sk-secret', model: 'deepseek-chat' });

  try {
    const out = await discoverModels(store, { home: tmpHome() });
    const row = out.agents.ds;
    assert.equal(auth, 'Bearer sk-secret');
    assert.equal(JSON.stringify(row).includes('sk-secret'), false);
    assert.equal(row.current, 'deepseek-chat');
    assert.deepEqual(row.options.map((o) => o.id), ['deepseek-chat', 'deepseek-reasoner']);
    assert.match(row.source, /api/);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});
