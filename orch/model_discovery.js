const fs = require('fs');
const os = require('os');
const path = require('path');

function homeOf(opts) {
  return (opts && opts.home) || process.env.USERPROFILE || os.homedir();
}

function safeModelId(v) {
  const s = String(v || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,}$/.test(s)) return '';
  if (/^(model|models|default|true|false|null|none)$/i.test(s)) return '';
  if (/^\d+m?$/i.test(s)) return '';
  if (!/[.:\-\/]/.test(s) && !/^(o\d|gpt|claude|deepseek|gemini|qwen|kimi|glm|llama|mistral|sonnet|opus|fable)$/i.test(s)) return '';
  if (/^[A-Z][a-z]+$/.test(s)) return '';
  return s;
}

function safeEffort(v) {
  const s = String(v || '').trim();
  return /^(low|medium|high|xhigh|max)$/i.test(s) ? s : '';
}

function modelTokens(v) {
  const s = String(v || '').replace(/\x1b\[[0-9;]*m/g, ' ');
  return (s.match(/[A-Za-z0-9][A-Za-z0-9._:/-]{1,}/g) || []).map(safeModelId).filter(Boolean);
}

function addModel(map, id, source) {
  const clean = safeModelId(id);
  if (!clean || map.has(clean)) return;
  map.set(clean, { id: clean, name: clean, source });
}

function readText(file) {
  try { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; } catch (e) { return ''; }
}

function codexConfig(home) {
  const text = readText(path.join(home, '.codex', 'config.toml'));
  const models = [];
  let m;
  const re = /^\s*model\s*=\s*["']([^"']+)["']/mg;
  while ((m = re.exec(text))) modelTokens(m[1]).forEach((x) => models.push(x));
  const effort = (text.match(/^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m) || [])[1] || '';
  return { current: models[0] || '', effort: safeEffort(effort), models };
}

function collectClaudeJsonModels(obj, out, key) {
  if (obj == null) return;
  if (typeof obj === 'string') {
    if (/^(model|currentModel|defaultModel|selectedModel|activeModel)$/i.test(key || '')) modelTokens(obj).forEach((x) => out.push(x));
    return;
  }
  if (Array.isArray(obj)) {
    if (/model.*(options|access|cache|list)|models$/i.test(key || '')) {
      obj.forEach((x) => {
        if (typeof x === 'string') modelTokens(x).forEach((v) => out.push(v));
        else if (x && typeof x === 'object') collectClaudeJsonModels(x, out, 'model');
      });
    } else obj.forEach((x) => collectClaudeJsonModels(x, out, key));
    return;
  }
  if (typeof obj === 'object') {
    Object.keys(obj).forEach((k) => collectClaudeJsonModels(obj[k], out, k));
  }
}

function readJsonModels(file) {
  const text = readText(file);
  if (!text) return [];
  try {
    const out = [];
    collectClaudeJsonModels(JSON.parse(text), out, '');
    return out;
  } catch (e) {
    return [];
  }
}

function claudeConfig(home) {
  const models = []
    .concat(readJsonModels(path.join(home, '.claude', 'settings.json')))
    .concat(readJsonModels(path.join(home, '.claude.json')));
  return { current: models[0] || '', models };
}

function modelsEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return '';
  if (/\/models$/i.test(base)) return base;
  if (/\/chat\/completions$/i.test(base)) return base.replace(/\/chat\/completions$/i, '/models');
  if (/\/v1$/i.test(base)) return base + '/models';
  return base + '/v1/models';
}

async function apiModels(agent, opts) {
  if (!agent || !agent.base_url) return { models: [], error: '' };
  const fetchImpl = (opts && opts.fetch) || fetch;
  const url = modelsEndpoint(agent.base_url);
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), (opts && opts.timeoutMs) || 3000) : null;
  try {
    const res = await fetchImpl(url, {
      headers: agent.api_key ? { authorization: 'Bearer ' + agent.api_key } : {},
      signal: ac ? ac.signal : undefined,
    });
    if (!res.ok) return { models: [], error: 'HTTP ' + res.status };
    const data = await res.json();
    const rows = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
    return { models: rows.map((r) => safeModelId((r && (r.id || r.name)) || r)).filter(Boolean), error: '' };
  } catch (e) {
    return { models: [], error: (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || String(e)) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isClaude(agent) {
  return /claude/i.test((agent && (agent.id + ' ' + agent.name + ' ' + agent.command)) || '');
}

function isCodex(agent) {
  return /codex/i.test((agent && (agent.id + ' ' + agent.name + ' ' + agent.command)) || '');
}

async function discoverModels(store, opts) {
  const home = homeOf(opts || {});
  const codex = codexConfig(home);
  const claude = claudeConfig(home);
  const agents = {};
  for (const agent of store.listAgents()) {
    const options = new Map();
    const sources = [];
    let current = safeModelId(agent.default_model) || '';
    let effort = safeEffort(agent.default_effort) || '';
    let error = '';
    if (current) { addModel(options, current, 'saved-default'); sources.push('saved-default'); }
    if ((agent.kind || 'cli') !== 'cli' && agent.base_url) {
      const found = await apiModels(agent, opts || {});
      found.models.forEach((id) => addModel(options, id, 'api:/models'));
      if (found.models.length) sources.push('api:/models');
      error = found.error || '';
      if (!current) current = safeModelId(agent.model) || found.models[0] || '';
    } else if (isCodex(agent)) {
      codex.models.forEach((id) => addModel(options, id, 'codex-config'));
      if (codex.models.length) sources.push('codex-config');
      if (!current) current = codex.current || '';
      if (!effort) effort = codex.effort || '';
    } else if (isClaude(agent)) {
      claude.models.forEach((id) => addModel(options, id, 'claude-config'));
      if (claude.models.length) sources.push('claude-config');
      if (!current) current = claude.current || '';
    }
    if (current) addModel(options, current, 'current');
    agents[agent.id] = {
      current,
      effort,
      options: Array.from(options.values()),
      source: Array.from(new Set(sources)).join(', '),
      error,
    };
  }
  return { agents };
}

module.exports = { discoverModels, modelsEndpoint, safeModelId, safeEffort };
