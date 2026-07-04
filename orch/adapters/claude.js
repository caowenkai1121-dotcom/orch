const { runJsonl } = require('./jsonl');
const { parseClaudeStream } = require('./streamparse');
const { shArg } = require('./shquote');

// claude -p --output-format stream-json:文本+tool_use+真实 usage/cost 由 parseClaudeStream 解析,公共运行时走 jsonl 骨架。
function buildArgs({ prompt, model, effort, permission }) {
  // --safe-mode:禁用用户全局定制(caveman/ponytail 等插件+hook+CLAUDE.md自动发现),保留 OAuth 登录——
  // 否则那些插件的 SessionStart hook 会注入"terse/lazy"提示,让 orch 执行 agent 几乎不输出(如 out=13tok)、不干活致步骤空转失败。上下文靠 orch 的 -p 简报注入,不依赖 CLAUDE.md 自动加载。
  const args = ['-p', '--safe-mode', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
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
