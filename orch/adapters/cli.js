const { spawn } = require('child_process');

// 跑一条 CLI，stdout/stderr 逐行回调，退出码 0 视为成功。
function runCli(cmd, args, workdir, onLine, onChild) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: workdir || process.cwd(), shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (onChild) onChild(p);
    const T = require('./steptimeout').arm(p);
    let output = '';
    const onData = (b) => { const s = b.toString(); output += s; s.split('\n').filter(Boolean).forEach(onLine); };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('close', (code) => { T.clear(); if (T.timedOut()) { onLine('⏱ 步骤超时被终止'); resolve({ output: output + '\n⏱ 步骤执行超时被终止(可重试续跑)', success: false }); } else resolve({ output, success: code === 0 }); });
    p.on('error', (e) => { onLine(String(e)); resolve({ output: String(e), success: false }); });
  });
}

module.exports = { runCli };
