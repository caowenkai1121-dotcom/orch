const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

function makeWorkspace(rootRepo) {
  const git = isGitRepo(rootRepo);
  return {
    make(stepId) {
      if (!git) return rootRepo; // 回退:共享目录
      const dir = path.join(rootRepo, 'worktrees', stepId);
      const branch = `orch/${stepId}`;
      if (!fs.existsSync(dir)) {
        execSync(`git worktree add -B ${branch} "${dir}"`, { cwd: rootRepo });
      }
      return dir;
    },
    // ponytail: 顺序 merge,无冲突解决;冲突时抛错由上层提示人工处理。
    merge(stepId) {
      if (!git) return;
      execSync(`git merge --no-edit orch/${stepId}`, { cwd: rootRepo });
    },
  };
}

module.exports = { makeWorkspace };
