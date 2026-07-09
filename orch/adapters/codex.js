const { runJsonl } = require('./jsonl');
const { parseCodexStream } = require('./streamparse');

// codex 定价(与 roles seed 的 codex pricing 一致),$/百万 token。codex --json 只给 token 不给 cost,故据此算。
const PRICE = { in: 1.25, out: 10 };
// parseCodexStream 出真实 token,这里补算 cost(input 未扣 cached,略偏高但对预算门保守),其余走 jsonl 骨架。
const parse = (line) => {
  const r = parseCodexStream(line);
  if (r.usage) r.usage = { input: r.usage.input, output: r.usage.output, cost: (r.usage.input * PRICE.in + r.usage.output * PRICE.out) / 1e6 };
  return r;
};

module.exports = {
  run({ prompt, workdir, model, effort, permission, onLine, onChild, onUsage }) {
    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (permission === 'read') args.push('--sandbox', 'read-only'); // #18 只读档
    else args.push('--dangerously-bypass-approvals-and-sandbox');
    if (model) args.push('--model', model);
    if (effort) args.push('-c', 'model_reasoning_effort="' + effort + '"');
    args.push('-'); // prompt 走 stdin(codex exec - 读 stdin,已实测):避开 Windows ~8K 命令行上限与引号转义
    return runJsonl({ cmd: 'codex', args, workdir, parse, onLine, onChild, onUsage, input: String(prompt == null ? '' : prompt) });
  },
};
