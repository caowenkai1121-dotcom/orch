const { runJsonl } = require('./jsonl');
const { parseClaudeStream } = require('./streamparse');

// claude -p --output-format stream-json:文本+tool_use+真实 usage/cost 由 parseClaudeStream 解析,公共运行时走 jsonl 骨架。
// prompt 走 stdin(claude -p 无位置参数时读 stdin 到 EOF,已实测):命令行传参有 Windows ~8K 字符硬上限,
// 简报+findings+交接+角色卡常态 5-9K,超限 spawn 整步失败且报错难懂;stdin 无长度限制、零引号转义。
function buildArgs({ model, effort, permission }) {
  // --safe-mode:禁用用户全局定制(caveman/ponytail 等插件+hook+CLAUDE.md自动发现),保留 OAuth 登录——
  // 否则那些插件的 SessionStart hook 会注入"terse/lazy"提示,让 orch 执行 agent 几乎不输出(如 out=13tok)、不干活致步骤空转失败。上下文靠 orch 的 stdin 简报注入,不依赖 CLAUDE.md 自动加载。
  const args = ['-p', '--safe-mode', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (model) args.push('--model', model);   // 如 claude-fable-5 / claude-opus-4-8
  if (effort) args.push('--effort', effort); // low/medium/high/xhigh/max
  // #18 只读档:禁改写/执行工具(仍绕权限提示,不卡)。prompt 已走 stdin,变参 --disallowedTools 吞不到 prompt;仍放末尾防吞后随参数。
  if (permission === 'read') args.push('--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash');
  return args;
}
module.exports = {
  run({ prompt, workdir, model, effort, permission, onLine, onChild, onUsage, timeoutScale }) {
    return runJsonl({ cmd: 'claude', args: buildArgs({ model, effort, permission }), workdir, parse: parseClaudeStream, onLine, onChild, onUsage, input: String(prompt == null ? '' : prompt), timeoutScale });
  },
  buildArgs,
};
