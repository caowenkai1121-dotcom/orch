const { test } = require('node:test');
const assert = require('node:assert');
const { runJsonl } = require('../adapters/jsonl');

test('#10 runJsonl 骨架:逐行 parse 累计 output、tools 进 onLine 不入 output、usage 转 onUsage、退出0=成功', async () => {
  const lines = []; const usages = [];
  // node 打印三行:两行正文 + 一行标记用于给 usage(避免 shell 引号,用纯数字/字母行)
  const parse = (l) => {
    if (l === '900') return { usage: { input: 5, output: 1, cost: 0 } };
    return { text: 'P' + l, tools: ['T' + l] };
  };
  const r = await runJsonl({ cmd: 'node', args: ['-e', 'console.log(111);console.log(222);console.log(900)'], workdir: process.cwd(), parse, onLine: (x) => lines.push(x), onUsage: (u) => usages.push(u) });
  assert.equal(r.success, true);
  assert.match(r.output, /P111/); assert.match(r.output, /P222/); // 正文累计入 output
  assert.ok(!/T111/.test(r.output));                              // 工具行不入 output
  assert.ok(lines.includes('T111'));                             // 工具行进 onLine
  assert.deepEqual(usages, [{ input: 5, output: 1, cost: 0 }]);   // usage 透传
});

test('#10 runJsonl:命令不存在 → 优雅失败(不抛)', async () => {
  const r = await runJsonl({ cmd: 'definitely-no-such-cmd-xyz', args: [], workdir: process.cwd(), parse: () => ({}), onLine: () => {} });
  assert.equal(r.success, false); // spawn error 转为失败结果,不上抛
});
