const { spawn } = require('child_process');

// 跑一条 CLI，stdout/stderr 逐行回调，退出码 0 视为成功。
function runCli(cmd, args, workdir, onLine, onChild) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: workdir || process.cwd(), shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (onChild) onChild(p);
    const T = require('./steptimeout').arm(p);
    const { StringDecoder } = require('string_decoder'); // 跨 chunk 保留半个多字节序列,防中文被 stdout 分片切成乱码
    const dOut = new StringDecoder('utf8'), dErr = new StringDecoder('utf8'); // stdout/stderr 各自解码器(两流字节不能混一个)
    let output = '';
    const feed = (s) => { output += s; s.split('\n').filter(Boolean).forEach(onLine); };
    p.stdout.on('data', (b) => feed(dOut.write(b))); p.stderr.on('data', (b) => feed(dErr.write(b)));
    p.on('close', (code) => { T.clear(); const tail = dOut.end() + dErr.end(); if (tail) feed(tail); if (T.timedOut()) { onLine('⏱ 步骤超时被终止'); resolve({ output: output + '\n⏱ 步骤执行超时被终止(可重试续跑)', success: false }); } else resolve({ output, success: code === 0 }); });
    p.on('error', (e) => { onLine(String(e)); resolve({ output: String(e), success: false }); });
  });
}

module.exports = { runCli };
