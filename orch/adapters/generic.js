const { runCli } = require('./cli');
const { dockerArgs } = require('../workspace');
const { execSync } = require('child_process');
function dockerOk() { try { execSync('docker --version', { stdio: 'ignore' }); return true; } catch (e) { return false; } }
function make(def) {
  const args = Array.isArray(def.args) ? def.args : (def.args ? JSON.parse(def.args) : []);
  let pricing = null; try { pricing = def.pricing ? JSON.parse(def.pricing) : null; } catch (e) {}
  return {
    async run({ prompt, workdir, onLine, onChild, onUsage }) {
      let cmd = def.command, callArgs = [...args, JSON.stringify(prompt)];
      // 容器隔离(opt-in,仅设了 image 的自定义 agent):Docker 可用则在容器里跑,否则回退本地
      if (def.image) {
        if (dockerOk()) { callArgs = dockerArgs(workdir, def.image, def.command, [...args, JSON.stringify(prompt)]); cmd = 'docker'; }
        else onLine('[warn] Docker 不可用,回退本地执行');
      }
      const res = await runCli(cmd, callArgs, workdir, onLine, onChild);
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
