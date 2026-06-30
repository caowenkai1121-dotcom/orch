const { spawn } = require('child_process');

// 跑一条 CLI，stdout/stderr 逐行回调，退出码 0 视为成功。
function runCli(cmd, args, workdir, onLine) {
  return new Promise((resolve) => {
    // stdin 设为 ignore(关闭),否则 codex 会等 stdin 输入而挂起
    const p = spawn(cmd, args, { cwd: workdir || process.cwd(), shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const onData = (b) => {
      const s = b.toString();
      output += s;
      s.split('\n').filter(Boolean).forEach(onLine);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', (code) => resolve({ output, success: code === 0 }));
    p.on('error', (e) => { onLine(String(e)); resolve({ output: String(e), success: false }); });
  });
}

module.exports = { runCli };
