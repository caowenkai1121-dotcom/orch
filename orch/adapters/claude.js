const { runCli } = require('./cli');
module.exports = {
  run({ prompt, workdir, onLine }) {
    return runCli('claude', ['-p', JSON.stringify(prompt)], workdir, onLine);
  },
};
