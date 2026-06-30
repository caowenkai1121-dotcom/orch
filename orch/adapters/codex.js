const { runCli } = require('./cli');
module.exports = {
  run({ prompt, workdir, onLine }) {
    // 无头自主:绕过审批+沙箱(Windows 沙箱不一定支持),并跳过 git 仓检查
    return runCli('codex',
      ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', JSON.stringify(prompt)],
      workdir, onLine);
  },
};
