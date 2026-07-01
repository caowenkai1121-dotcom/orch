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

module.exports = { makeWorkspace, slug, taskDir, worktreeDir, dockerArgs };
