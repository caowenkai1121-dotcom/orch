const { spawn } = require('child_process');

// #10 共享 JSONL 流式 CLI-agent 运行时骨架(参考 Tolaria):只管 spawn + 行缓冲 + 生命周期 + 超时守卫,
// 每个 stream-json/--json agent 只需给 cmd/args + parse(line)->{text?,tools?,usage?}。加新此类 agent = 一个小适配器。
// input:prompt 走 stdin 而非命令行参数——命令行传参在 Windows 有 ~8K 字符硬上限(简报+findings+交接+角色卡轻松超限,
// spawn 直接失败且报错难懂),且需 shell 引号转义(POSIX 有注入面)。stdin 无长度限制、零转义。
function runJsonl({ cmd, args, workdir, parse, onLine, onChild, onUsage, input }) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: workdir || process.cwd(), shell: true, stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (onChild) onChild(p);
    if (input != null && p.stdin) { p.stdin.on('error', () => {}); p.stdin.end(input, 'utf8'); } // EPIPE(进程未起/秒退)吞掉,错误由 close/error 事件如实上报
    const T = require('./steptimeout').arm(p);
    const dec = new (require('string_decoder').StringDecoder)('utf8'); // 跨 chunk 保留半个多字节序列,防中文被 stdout 分片切成乱码(claude/codex 共享此骨架)
    let buf = '', output = '';
    const handle = (line) => {
      if (!line) return;
      let r;
      try { r = parse(line) || {}; } catch (e) { return; } // parser 对畸形/意外形态行(如裸 'null'、字段非预期)抛错不该崩:此处在 stdout data 同步回调内,无上层保护会成 uncaughtException 拖垮整个服务进程
      if (r.text) { output += r.text + '\n'; onLine(r.text); } // 语义正文累计 → 交接/门禁/NEED_DECISION 检测用
      if (r.tools) r.tools.forEach((t) => onLine(t));           // 工具活动仅进实时流,不入 output
      if (r.usage && onUsage) onUsage(r.usage);
    };
    p.stdout.on('data', (b) => { buf += dec.write(b); const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(handle); });
    // stderr 同样跨 chunk 解码+行缓冲:原 b.toString() 逐块转换,中文多字节被分片切断出乱码,多行错误也整块挤成一条日志
    const decErr = new (require('string_decoder').StringDecoder)('utf8');
    let ebuf = '';
    p.stderr.on('data', (b) => { ebuf += decErr.write(b); const lines = ebuf.split('\n'); ebuf = lines.pop(); lines.filter(Boolean).forEach(onLine); });
    p.on('close', (code) => { T.clear(); buf += dec.end(); if (buf) handle(buf); ebuf += decErr.end(); if (ebuf) onLine(ebuf); if (T.timedOut()) { onLine('⏱ 步骤超时被终止'); resolve({ output: output + '\n⏱ 步骤执行超时被终止(可重试续跑)', success: false }); } else resolve({ output, success: code === 0 }); });
    p.on('error', (e) => { onLine(String(e)); resolve({ output: String(e), success: false }); });
  });
}
module.exports = { runJsonl };
