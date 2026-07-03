// 启动装配:历史产出导入 / 适配器注册表 / CLI 智能体自动发现 / 文件清单工具
const path = require('path');
const fs = require('fs');
const generic = require('./adapters/generic');

// 列出目录下所有文件(相对路径,最多500个)
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

// 扫描 data/ 目录,把历史产出(DB 里没有的)导入为已完成任务 → 换库/改代码后仍能看到以前的项目
function importDataDir(store, ROOT) {
  const dataRoot = path.join(ROOT, 'data');
  if (!fs.existsSync(dataRoot)) return;
  const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules').map((e) => e.name); } catch (e) { return []; } };
  const seen = new Set(store.listTasks().map((t) => t.dir).filter(Boolean).map((d) => path.resolve(d)));
  let n = 0;
  for (const owner of dirs(dataRoot)) {
    for (const project of dirs(path.join(dataRoot, owner))) {
      for (const folder of dirs(path.join(dataRoot, owner, project))) {
        const full = path.resolve(dataRoot, owner, project, folder);
        if (seen.has(full)) continue;
        if (!listFilesIn(full).length) continue; // 空目录跳过
        const text = folder.replace(/-\d+$/, '') || folder;
        const id = store.createTask(text, project, owner, {});
        store.setTaskStatus(id, 'done');
        store.setTaskDir(id, full);
        store.setStep(id, 'imported', 'claude', 'done', '历史产出(从 data 目录导入)');
        n++;
      }
    }
  }
  if (n) console.log('导入历史项目产出:', n, '个任务');
}

// 适配器注册表从 DB 的 agent 定义构建,新增 agent 后重建
function buildAdapters(store) {
  const m = { echo: require('./adapters/echo') };
  store.listAgents().forEach((a) => { m[a.id] = generic.make(a); });
  m.claude = require('./adapters/claude'); // claude 用 stream-json 专用适配器
  return m;
}

// 自动发现已安装的 CLI 智能体(claude/codex 已 seed;这里补 hermes/gemini/aider 等)。用户无需手动添加 CLI agent。
function cmdExists(cmd) { try { require('child_process').execSync((process.platform === 'win32' ? 'where ' : 'command -v ') + cmd, { stdio: 'ignore' }); return true; } catch (e) { return false; } }
const KNOWN_CLI = [
  { id: 'hermes', name: 'Hermes', command: 'hermes', args: ['-p'], model: 'hermes CLI', caps: ['代码生成'], color: '#2FAE9E', avatar: 'H', dept: 'dev' },
  { id: 'gemini', name: 'Gemini', command: 'gemini', args: ['-p', '--yolo'], model: 'gemini CLI', caps: ['代码生成'], color: '#E0922E', avatar: 'G', dept: 'dev' },
  { id: 'aider', name: 'Aider', command: 'aider', args: ['--yes-always'], model: 'aider CLI', caps: ['代码修改'], color: '#E06A63', avatar: 'A', dept: 'dev' },
  { id: 'qwen', name: 'Qwen', command: 'qwen', args: ['-p'], model: 'qwen CLI', caps: ['代码生成'], color: '#9B59B6', avatar: 'Q', dept: 'dev' },
  { id: 'cursor-agent', name: 'Cursor Agent', command: 'cursor-agent', args: [], model: 'cursor CLI', caps: ['代码生成'], color: '#3C3933', avatar: 'Cu', dept: 'dev' },
];
function scanAgents(store) {
  const have = new Set(store.listAgents().map((a) => a.id));
  let n = 0;
  KNOWN_CLI.forEach((a) => { if (!have.has(a.id) && cmdExists(a.command)) { store.addAgent(Object.assign({}, a, { kind: 'cli' })); n++; } });
  if (n) console.log('自动发现 CLI 智能体:', n, '个');
  return n;
}

// 服务重启恢复:上次进程死掉时 running/planning 的任务已成僵尸 → 标记失败并留提示,可「重试失败步骤」续跑
function recoverZombies(store) {
  const zombies = store.listTasks().filter((t) => t.status === 'running' || t.status === 'planning');
  zombies.forEach((t) => {
    store.setTaskStatus(t.id, 'failed');
    store.addEvent(t.id, 'task', 'interrupted');
    store.addLog(t.id, '', '⚠ 服务重启,任务执行被中断(非任务本身错误)。点「↻ 重试失败步骤」续跑,已完成步骤不会重跑。');
    // 运行中的步骤一并标失败,重试时会重跑这些步骤
    (store.getTask(t.id).steps || []).forEach((s) => { if (s.status === 'running') store.setStep(t.id, s.step_id, s.agent, 'failed', s.output); });
  });
  if (zombies.length) console.log('恢复中断任务:', zombies.length, '个(已标记失败,可重试续跑)');
}

// 执行器健康:每个 CLI agent 是否可调用 + 版本(启动跑一次,缓存)
function checkHealth(store) {
  const { execSync } = require('child_process');
  const map = {};
  store.listAgents().filter((a) => (a.kind || 'cli') === 'cli').forEach((a) => {
    const cmd = a.command || a.id;
    let ok = false, version = '';
    try {
      const out = execSync(cmd + ' --version', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).toString().trim();
      ok = true; version = (out.split('\n')[0] || '').slice(0, 40);
    } catch (e) { ok = cmdExists(cmd); } // --version 失败但命令存在也算装了
    map[a.id] = { ok, version };
  });
  return map;
}

module.exports = { listFilesIn, importDataDir, buildAdapters, scanAgents, recoverZombies, checkHealth };
