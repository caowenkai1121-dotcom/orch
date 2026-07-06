const { runCli } = require('./cli');
const { shArg } = require('./shquote');
const { dockerArgs } = require('../workspace');
const { execSync } = require('child_process');
function dockerOk() { try { execSync('docker --version', { stdio: 'ignore' }); return true; } catch (e) { return false; } }
// #18 只读档:codex 用 --sandbox read-only 替代 --dangerously-bypass-approvals-and-sandbox(exec 仍非交互,不卡)
function codexReadArgs(args) {
  return ['exec', '--sandbox', 'read-only'].concat((args || []).filter((x) => x !== 'exec' && x !== '--dangerously-bypass-approvals-and-sandbox'));
}
function make(def) {
  const args = Array.isArray(def.args) ? def.args : (def.args ? JSON.parse(def.args) : []);
  let pricing = null; try { pricing = def.pricing ? JSON.parse(def.pricing) : null; } catch (e) {}
  return {
    async run({ prompt, workdir, model, effort, permission, onLine, onChild, onUsage }) {
      const modelArgs = model ? ['--model', model] : []; // 用户选的大模型
      if (effort && def.command === 'codex') modelArgs.push('-c', 'model_reasoning_effort="' + effort + '"'); // codex 思考级别
      const baseArgs = (permission === 'read' && def.command === 'codex') ? codexReadArgs(args) : args; // #18 只读档
      let cmd = def.command, callArgs = [...baseArgs, ...modelArgs, shArg(prompt)];
      // 容器隔离(opt-in,仅设了 image 的自定义 agent):Docker 可用则在容器里跑,否则回退本地
      if (def.image) {
        if (dockerOk()) { callArgs = dockerArgs(workdir, def.image, def.command, [...baseArgs, ...modelArgs, shArg(prompt)]); cmd = 'docker'; }
        else onLine('[warn] Docker 不可用,回退本地执行');
      }
      // Windows 命令行 ~8191 字符硬上限:自定义 CLI 的 prompt 仍走命令行(各家 stdin 支持不一,不盲改)。
      // 超限与其神秘 spawn 失败,不如明确报错——可诊断、可换 claude/codex(prompt 走 stdin,无长度限制)重派。
      const cmdLen = String(cmd || '').length + callArgs.join(' ').length;
      if (process.platform === 'win32' && cmdLen > 7500) {
        const msg = '提示词组装后约 ' + cmdLen + ' 字符,超出自定义 CLI 命令行上限(~8K)。本步请改用 claude/codex 执行(它们的提示词走 stdin,无长度限制)。';
        onLine('✗ ' + msg);
        return { output: msg, success: false };
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
module.exports = { make, codexReadArgs };
