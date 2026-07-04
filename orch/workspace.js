const fs = require('fs');
const path = require('path');

// 文件名安全:保留各语言字母/数字/-/_,其余→-,首尾去-,截断
function slug(s) {
  const out = String(s == null ? '' : s).trim().replace(/[^\p{L}\p{N}\-_]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return out || 'x';
}
// 每任务独立目录: root/data/<owner>/<project>/<text>-<id>
function taskDir(root, owner, project, text, id) {
  const dir = path.join(root, 'data', slug(owner), slug(project), slug(text) + '-' + id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
// 共享工作区(回退):同任务各步骤共用根目录
function makeWorkspace(rootRepo) {
  return { make() { return rootRepo; } };
}

// git worktree 隔离:每任务独立分支目录(root 须是 git 仓);失败回退普通目录
const { execSync } = require('child_process');
// #4 冷 worktree 供给:读 root/.orch.json {setup, preserve};新建 worktree 后把主 checkout 的依赖/密钥带进来再跑 setup,
// 让隔离 worktree 能真正构建/测试(否则冷 checkout 缺 node_modules/.env,build/test 步必挂)。全程 best-effort,失败不阻断任务。
// preserve 模式展开:字面路径原样;含 * 的按 basename 级 glob 展开其父目录。硬规则:绝不含 .orch.json 自身。
function expandPreserve(root, patterns) {
  const rels = [];
  for (const pat of (patterns || [])) {
    const p = String(pat);
    if (p === '.orch.json') continue;
    if (p.indexOf('*') < 0) { rels.push(p); continue; }
    const parent = path.dirname(p), bn = path.basename(p);
    const re = new RegExp('^' + bn.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    try { fs.readdirSync(path.join(root, parent)).forEach((f) => { if (re.test(f) && f !== '.orch.json') rels.push(parent === '.' ? f : path.join(parent, f)); }); } catch (e) {}
  }
  return rels;
}
function provisionWorktree(root, dir) {
  try {
    const cfgP = path.join(root, '.orch.json');
    if (!fs.existsSync(cfgP)) return;
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(cfgP, 'utf8')) || {}; } catch (e) { return; }
    // preserve 先于 setup:node_modules 软链省重装,.env 等直接拷。emdash 融合:支持 basename 级 glob(如 .env.*.local)
    // + 配置存在但未列 preserve 时默认带 env/keys(冷 worktree 缺 .env 会让 build/test 直接挂,开箱即用)。
    const patterns = Array.isArray(cfg.preserve) ? cfg.preserve : ['.env', '.env.local', '.env.*.local'];
    for (const rel of expandPreserve(root, patterns)) {
      try {
        const src = path.join(root, rel), dst = path.join(dir, rel);
        if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (fs.statSync(src).isDirectory()) { try { fs.symlinkSync(src, dst, 'junction'); } catch (e) { fs.cpSync(src, dst, { recursive: true }); } }
        else fs.copyFileSync(src, dst);
      } catch (e) {}
    }
    if (cfg.setup) { try { execSync(cfg.setup, { cwd: dir, stdio: 'ignore', timeout: 5 * 60 * 1000 }); } catch (e) {} }
  } catch (e) {}
}
function worktreeDir(root, id) {
  const dir = path.join(root, 'worktrees', 'task-' + id);
  if (!fs.existsSync(dir)) {
    let made = false;
    try { execSync('git worktree add -B orch/task-' + id + ' "' + dir + '"', { cwd: root, stdio: 'ignore' }); made = true; }
    catch (e) { fs.mkdirSync(dir, { recursive: true }); }
    if (made) provisionWorktree(root, dir); // 仅真正新建 worktree 时供给一次
  }
  return dir;
}
// 构造 docker run 挂载命令的参数数组
function dockerArgs(mountDir, image, cmd, args) {
  return ['run', '--rm', '-v', mountDir + ':/work', '-w', '/work', image, cmd, ...args];
}

// #15 doctor:回收某任务的 git worktree(删任务/清孤儿时)——移除 worktree 目录 + 对应分支;best-effort
function reapWorktree(root, id) {
  const dir = path.join(root, 'worktrees', 'task-' + id);
  let removed = false;
  try {
    if (fs.existsSync(dir)) {
      try { execSync('git worktree remove --force "' + dir + '"', { cwd: root, stdio: 'ignore' }); removed = true; }
      catch (e) { try { fs.rmSync(dir, { recursive: true, force: true }); removed = true; } catch (x) {} }
    }
    try { execSync('git branch -D orch/task-' + id, { cwd: root, stdio: 'ignore' }); } catch (e) {} // 分支可能已随 worktree 移除或不存在
  } catch (e) {}
  return removed;
}
// 列出 data/<owner>/<project>/<text>-<id> 叶子目录及其任务 id(供 doctor 找孤儿产出目录:任务已删但目录留存)
function listDataDirs(root) {
  const out = [];
  try {
    const base = path.join(root, 'data');
    if (!fs.existsSync(base)) return out;
    const dirs = (d) => fs.readdirSync(d).filter((n) => { try { return fs.statSync(path.join(d, n)).isDirectory(); } catch (e) { return false; } });
    for (const o of dirs(base)) for (const pr of dirs(path.join(base, o))) for (const tk of dirs(path.join(base, o, pr))) {
      const m = tk.match(/-(\d+)$/); if (m) out.push({ id: Number(m[1]), dir: path.join(base, o, pr, tk) });
    }
  } catch (e) {}
  return out;
}
// 列出 worktrees/ 下所有 orch worktree 的任务 id(供 doctor 找孤儿)
function listWorktreeIds(root) {
  try {
    const wt = path.join(root, 'worktrees');
    if (!fs.existsSync(wt)) return [];
    return fs.readdirSync(wt).map((n) => { const m = n.match(/^task-(\d+)$/); return m ? Number(m[1]) : null; }).filter((x) => x != null);
  } catch (e) { return []; }
}

// 元 LLM 调用(规划/需求细化/复盘)的中性工作目录:隔离在临时目录,防思考型 agent(skip-permissions)
// 万一误写文件时污染/损坏 orch 自身源码。这些调用只需一个有效 cwd,不需要目录内容。
let _metaDir = null;
function metaDir() {
  if (_metaDir) return _metaDir;
  _metaDir = path.join(require('os').tmpdir(), 'orch-meta');
  try { fs.mkdirSync(_metaDir, { recursive: true }); } catch (e) { _metaDir = require('os').tmpdir(); }
  return _metaDir;
}

module.exports = { makeWorkspace, slug, taskDir, worktreeDir, dockerArgs, metaDir, reapWorktree, listWorktreeIds, listDataDirs, expandPreserve };
