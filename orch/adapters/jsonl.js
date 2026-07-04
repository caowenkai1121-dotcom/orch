const { spawn } = require('child_process');

// #10 共享 JSONL 流式 CLI-agent 运行时骨架(参考 Tolaria):只管 spawn + 行缓冲 + 生命周期 + 超时守卫,
// 每个 stream-json/--json agent 只需给 cmd/args + parse(line)->{text?,tools?,usage?}。加新此类 agent = 一个小适配器。
function runJsonl({ cmd, args, workdir, parse, onLine, onChild, onUsage }) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: workdir || process.cwd(), shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (onChild) onChild(p);
    const T = require('./steptimeout').arm(p);
    const dec = new (require('string_decoder').StringDecoder)('utf8'); // 跨 chunk 保留半个多字节序列,防中文被 stdout 分片切成乱码(claude/codex 共享此骨架)
    let buf = '', output = '';
    const handle = (line) => {
      if (!line) return;
      const r = parse(line) || {};
      if (r.text) { output += r.text + '\n'; onLine(r.text); } // 语义正文累计 → 交接/门禁/NEED_DECISION 检测用
      if (r.tools) r.tools.forEach((t) => onLine(t));           // 工具活动仅进实时流,不入 output
      if (r.usage && onUsage) onUsage(r.usage);
    };
    p.stdout.on('data', (b) => { buf += dec.write(b); const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(handle); });
    p.stderr.on('data', (b) => onLine(b.toString()));
    p.on('close', (code) => { T.clear(); buf += dec.end(); if (buf) handle(buf); if (T.timedOut()) { onLine('⏱ 步骤超时被终止'); resolve({ output: output + '\n⏱ 步骤执行超时被终止(可重试续跑)', success: false }); } else resolve({ output, success: code === 0 }); });
    p.on('error', (e) => { onLine(String(e)); resolve({ output: String(e), success: false }); });
  });
}
module.exports = { runJsonl };
