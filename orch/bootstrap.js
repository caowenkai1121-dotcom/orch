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
  const tomb = new Set((store.deletedDirs ? store.deletedDirs() : []).map((d) => path.resolve(String(d)))); // 已删任务目录:reap 因锁失败残留时,别再当历史产出复活
  let n = 0;
  for (const owner of dirs(dataRoot)) {
    for (const project of dirs(path.join(dataRoot, owner))) {
      for (const folder of dirs(path.join(dataRoot, owner, project))) {
        const full = path.resolve(dataRoot, owner, project, folder);
        if (seen.has(full) || tomb.has(full)) continue;
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
  const openai = require('./adapters/openai');
  // API 型大模型(kind≠cli 且配了 base_url)走 OpenAI 兼容适配器(三项接入:地址/Key/模型,可做会议发言/文本步);其余走 CLI generic
  store.listAgents().forEach((a) => { m[a.id] = ((a.kind || 'cli') !== 'cli' && a.base_url) ? openai.make(a) : generic.make(a); });
  m.claude = require('./adapters/claude'); // claude 用 stream-json 专用适配器
  if (m.codex) m.codex = require('./adapters/codex'); // codex 用 --json 专用适配器(真实 token/成本,替代 char/4 估算)
  return m;
}

// 服务进程(systemd/nohup/pm2)的 PATH 常比登录 shell 精简(通常只有 /usr/bin:/bin),导致明明装了的 CLI
// (claude/codex,多经 npm-global/nvm/homebrew 安装)检测和执行都找不到,前端显示"未检测到"。
// 启动时智能补全 process.env.PATH:①取 login shell 的完整 PATH ②扫常见安装目录 ③用 login shell 定位各 CLI 真实目录。
// 补进 process.env.PATH 后,后续 cmdExists/checkHealth 检测 + spawn 执行都能找到。Windows 本地不适用,跳过。
function augmentPath() {
  if (process.platform === 'win32') return;
  const { execSync } = require('child_process');
  const path = require('path');
  const dirs = new Set((process.env.PATH || '').split(':').filter(Boolean));
  const sh = (c) => { try { return execSync(c, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { return ''; } };
  const loginPath = sh("bash -lc 'echo -n \"$PATH\"'"); // login shell 完整 PATH(含 nvm/npm-global/rc 里配的)
  loginPath.split(':').filter(Boolean).forEach((d) => dirs.add(d));
  const home = process.env.HOME || '';
  [home + '/.npm-global/bin', home + '/.local/bin', '/usr/local/bin', home + '/.bun/bin', '/opt/homebrew/bin', '/usr/local/lib/node_modules/.bin'].forEach((d) => { if (d && d[0] === '/') dirs.add(d); });
  ['claude', 'codex'].forEach((c) => { const loc = sh("bash -lc 'command -v " + c + " 2>/dev/null'"); if (loc && loc[0] === '/') dirs.add(path.dirname(loc)); }); // login shell 定位真实路径,取其目录
  process.env.PATH = [...dirs].join(':');
}

// 自动发现已安装的 CLI 智能体(claude/codex 已 seed;这里补 hermes/gemini/aider 等)。用户无需手动添加 CLI agent。
function cmdExists(cmd) { try { require('child_process').execSync((process.platform === 'win32' ? 'where ' : 'command -v ') + cmd, { stdio: 'ignore' }); return true; } catch (e) { return false; } }
const KNOWN_CLI = [
  { id: 'hermes', name: 'Hermes', command: 'hermes', args: ['-p'], model: 'hermes CLI', caps: ['代码生成'], color: '#2FAE9E', avatar: 'H', dept: 'engineering' },
  { id: 'gemini', name: 'Gemini', command: 'gemini', args: ['-p', '--yolo'], model: 'gemini CLI', caps: ['代码生成'], color: '#E0922E', avatar: 'G', dept: 'engineering' },
  { id: 'aider', name: 'Aider', command: 'aider', args: ['--yes-always'], model: 'aider CLI', caps: ['代码修改'], color: '#E06A63', avatar: 'A', dept: 'engineering' },
  { id: 'qwen', name: 'Qwen', command: 'qwen', args: ['-p'], model: 'qwen CLI', caps: ['代码生成'], color: '#9B59B6', avatar: 'Q', dept: 'engineering' },
  { id: 'cursor-agent', name: 'Cursor Agent', command: 'cursor-agent', args: [], model: 'cursor CLI', caps: ['代码生成'], color: '#3C3933', avatar: 'Cu', dept: 'engineering' },
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
    // 运行中的步骤一并标失败,重试时会重跑这些步骤;补状态事件——否则 events 里只有 running 没有终态,
    // 耗时统计(stepDurations/agentAvgSeconds)会把这些步永远显示为"⏱ 运行中"且越走越大
    (store.getTask(t.id).steps || []).forEach((s) => { if (s.status === 'running') { store.setStep(t.id, s.step_id, s.agent, 'failed', s.output); store.addEvent(t.id, 'status', { step: s.step_id, v: 'failed' }); } });
  });
  if (zombies.length) console.log('恢复中断任务:', zombies.length, '个(已标记失败,可重试续跑)');
  // meeting 态任务:会议数据全在库里,重启只丢了自动收敛协程(开场发言/共识判定)。
  // 链路仍通——用户发言会触发员工回应+重新判定,手动结束也可;但没人提示的话用户会干等。不标失败(数据没坏)。
  store.listTasks().filter((t) => t.status === 'meeting').forEach((t) => {
    const mt = store.getMeeting && store.getMeeting(t.id);
    if (!mt || mt.status !== 'open') return;
    store.addTaskMsg(t.id, 'system', '⚠ 服务重启过:会议仍开着,自动讨论已中断。进入会议室发言(员工会回应并重新判定收束),或点「结束会议 · 生成方案」直接继续。');
    if (store.addMeetingMsg) store.addMeetingMsg(t.id, { role: 'system', name: '会议室', avatar: '🏛', text: '服务重启过,自动讨论中断。你发言即可唤醒讨论,或直接点「结束会议 · 生成方案」。' });
  });
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

module.exports = { listFilesIn, importDataDir, buildAdapters, scanAgents, recoverZombies, checkHealth, augmentPath };
