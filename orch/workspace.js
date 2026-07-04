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
function worktreeDir(root, id) {
  const dir = path.join(root, 'worktrees', 'task-' + id);
  if (!fs.existsSync(dir)) {
    try { execSync('git worktree add -B orch/task-' + id + ' "' + dir + '"', { cwd: root, stdio: 'ignore' }); }
    catch (e) { fs.mkdirSync(dir, { recursive: true }); }
  }
  return dir;
}
// 构造 docker run 挂载命令的参数数组
function dockerArgs(mountDir, image, cmd, args) {
  return ['run', '--rm', '-v', mountDir + ':/work', '-w', '/work', image, cmd, ...args];
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

module.exports = { makeWorkspace, slug, taskDir, worktreeDir, dockerArgs, metaDir };
