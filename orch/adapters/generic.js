const { runCli } = require('./cli');

// 数据驱动:按 agent 定义的 command + args 跑,prompt 作为末尾参数(加引号防空格拆分)。
function make(def) {
  const args = Array.isArray(def.args) ? def.args : (def.args ? JSON.parse(def.args) : []);
  return {
    run({ prompt, workdir, onLine }) {
      return runCli(def.command, [...args, JSON.stringify(prompt)], workdir, onLine);
    },
  };
}

module.exports = { make };
