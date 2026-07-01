const { spawn } = require('child_process');
const { parseClaudeStream } = require('./streamparse');

module.exports = {
  run({ prompt, workdir, onLine, onChild, onUsage }) {
    return new Promise((resolve) => {
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', JSON.stringify(prompt)];
      const p = spawn('claude', args, { cwd: workdir || process.cwd(), shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (onChild) onChild(p);
      let buf = '', output = '';
      const handle = (line) => { if (!line) return; const r = parseClaudeStream(line); if (r.text) { output += r.text + '\n'; onLine(r.text); } if (r.usage && onUsage) onUsage(r.usage); };
      p.stdout.on('data', (b) => { buf += b.toString(); const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(handle); });
      p.stderr.on('data', (b) => onLine(b.toString()));
      p.on('close', (code) => { if (buf) handle(buf); resolve({ output, success: code === 0 }); });
      p.on('error', (e) => { onLine(String(e)); resolve({ output: String(e), success: false }); });
    });
  },
};
