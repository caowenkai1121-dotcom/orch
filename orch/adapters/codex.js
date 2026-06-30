const { runCli } = require('./cli');
module.exports = {
  run({ prompt, workdir, onLine }) {
    return runCli('codex', ['exec', JSON.stringify(prompt)], workdir, onLine);
  },
};
