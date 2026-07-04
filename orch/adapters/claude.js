const { runJsonl } = require('./jsonl');
const { parseClaudeStream } = require('./streamparse');
const { shArg } = require('./shquote');

// claude -p --output-format stream-json:文本+tool_use+真实 usage/cost 由 parseClaudeStream 解析,公共运行时走 jsonl 骨架。
module.exports = {
  run({ prompt, workdir, model, effort, permission, onLine, onChild, onUsage }) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (permission === 'read') args.push('--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit,Bash'); // #18 只读档:禁改写/执行工具(仍绕权限提示,不卡)
    if (model) args.push('--model', model);   // 如 claude-fable-5 / claude-opus-4-8
    if (effort) args.push('--effort', effort); // low/medium/high/xhigh/max
    args.push(shArg(prompt));
    return runJsonl({ cmd: 'claude', args, workdir, parse: parseClaudeStream, onLine, onChild, onUsage });
  },
};
