const { spawn } = require('child_process');
const { parseCodexStream } = require('./streamparse');

// codex 定价(与 roles seed 的 codex pricing 一致),$/百万 token。codex --json 只给 token 不给 cost,故据此算。
const PRICE = { in: 1.25, out: 10 };

// codex exec --json:逐行 JSONL,agent_message=最终文本,turn.completed.usage=真实 token。替代 generic 的 char/4 估算。
module.exports = {
  run({ prompt, workdir, model, effort, permission, onLine, onChild, onUsage }) {
    return new Promise((resolve) => {
      const args = ['exec', '--json', '--skip-git-repo-check'];
      if (permission === 'read') args.push('--sandbox', 'read-only'); // #18 只读档
      else args.push('--dangerously-bypass-approvals-and-sandbox');
      if (model) args.push('--model', model);
      if (effort) args.push('-c', 'model_reasoning_effort="' + effort + '"');
      args.push(JSON.stringify(prompt));
      const p = spawn('codex', args, { cwd: workdir || process.cwd(), shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (onChild) onChild(p);
      const T = require('./steptimeout').arm(p);
      let buf = '', output = '';
      const handle = (line) => {
        if (!line) return;
        const r = parseCodexStream(line);
        if (r.text) { output += r.text + '\n'; onLine(r.text); }
        if (r.usage && onUsage) onUsage({ input: r.usage.input, output: r.usage.output, cost: (r.usage.input * PRICE.in + r.usage.output * PRICE.out) / 1e6 });
      };
      p.stdout.on('data', (b) => { buf += b.toString(); const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(handle); });
      p.stderr.on('data', (b) => onLine(b.toString())); // codex 把 MCP/tracing 日志写 stderr,原样透传给日志(不进语义 output)
      p.on('close', (code) => { T.clear(); if (buf) handle(buf); if (T.timedOut()) { onLine('⏱ 步骤超时被终止'); resolve({ output: output + '\n⏱ 步骤执行超时被终止(可重试续跑)', success: false }); } else resolve({ output, success: code === 0 }); });
      p.on('error', (e) => { onLine(String(e)); resolve({ output: String(e), success: false }); });
    });
  },
};
