const { runJsonl } = require('./jsonl');
const { parseClaudeStream } = require('./streamparse');
const { shArg } = require('./shquote');

// claude -p --output-format stream-json:文本+tool_use+真实 usage/cost 由 parseClaudeStream 解析,公共运行时走 jsonl 骨架。
function buildArgs({ prompt, model, effort, permission }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (model) args.push('--model', model);   // 如 claude-fable-5 / claude-opus-4-8
  if (effort) args.push('--effort', effort); // low/medium/high/xhigh/max
  args.push(shArg(prompt));
  // #18 只读档:禁改写/执行工具(仍绕权限提示,不卡)。必须放在 prompt 之后——--disallowedTools 是变参会贪婪吞掉后随的 prompt,
  // 否则(尤其未选 model/effort 时)prompt 被当成 deny 规则吃光,claude 报「Input must be provided」整步失败(只读审查/门禁步全废)。
  if (permission === 'read') args.push('--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash');
  return args;
}
module.exports = {
  run({ prompt, workdir, model, effort, permission, onLine, onChild, onUsage }) {
    return runJsonl({ cmd: 'claude', args: buildArgs({ prompt, model, effort, permission }), workdir, parse: parseClaudeStream, onLine, onChild, onUsage });
  },
  buildArgs,
};
