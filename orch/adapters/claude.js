const { runCli } = require('./cli');
module.exports = {
  run({ prompt, workdir, onLine }) {
    // --dangerously-skip-permissions: 无头自主模式必须,否则 claude 只输出文本不落地文件
    return runCli('claude', ['-p', '--dangerously-skip-permissions', JSON.stringify(prompt)], workdir, onLine);
  },
};
