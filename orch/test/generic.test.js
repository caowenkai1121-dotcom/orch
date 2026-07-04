const { test } = require('node:test');
const assert = require('node:assert');
const generic = require('../adapters/generic');

test('按 command+args 跑,退出码0=成功', async () => {
  const a = generic.make({ command: 'node', args: ['-e', 'console.log(1+1)'] });
  const lines = [];
  const r = await a.run({ prompt: '忽略', workdir: process.cwd(), onLine: (l) => lines.push(l) });
  assert.equal(r.success, true);
  assert.ok(lines.join('').includes('2'));
});

test('审查修复:generic/cli 中文多字节输出正确解码(StringDecoder)', async () => {
  const a = generic.make({ command: 'node', args: ['-e', 'process.stdout.write(String.fromCharCode(20320,22909))'] }); // 你好,charCode 避免命令行编码干扰
  const r = await a.run({ prompt: 'x', workdir: process.cwd(), onLine: () => {} });
  assert.match(r.output, /你好/); // 无 U+FFFD 乱码
});

test('#18 codexReadArgs:只读沙箱替代 bypass,保留其余参数', () => {
  assert.deepEqual(
    generic.codexReadArgs(['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']),
    ['exec', '--sandbox', 'read-only', '--skip-git-repo-check']
  );
});

test('args 接受 JSON 字符串', async () => {
  const a = generic.make({ command: 'node', args: '["-e","process.exit(0)"]' });
  const r = await a.run({ prompt: 'x', workdir: process.cwd(), onLine: () => {} });
  assert.equal(r.success, true);
});
