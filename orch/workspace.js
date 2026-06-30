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

module.exports = { makeWorkspace, slug, taskDir };
