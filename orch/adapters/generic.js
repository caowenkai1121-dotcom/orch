const { runCli } = require('./cli');
function make(def) {
  const args = Array.isArray(def.args) ? def.args : (def.args ? JSON.parse(def.args) : []);
  let pricing = null; try { pricing = def.pricing ? JSON.parse(def.pricing) : null; } catch (e) {}
  return {
    async run({ prompt, workdir, onLine, onChild, onUsage }) {
      const res = await runCli(def.command, [...args, JSON.stringify(prompt)], workdir, onLine, onChild);
      if (onUsage) { // inferred:按字符数/4 估 token
        const inTok = Math.ceil((prompt || '').length / 4), outTok = Math.ceil((res.output || '').length / 4);
        const c = pricing ? (inTok * (pricing.in || 0) + outTok * (pricing.out || 0)) / 1e6 : 0;
        onUsage({ input: inTok, output: outTok, cost: c, estimated: true });
      }
      return res;
    },
  };
}
module.exports = { make };
