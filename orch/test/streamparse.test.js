const { test } = require('node:test');
const assert = require('node:assert');
const { parseClaudeStream } = require('../adapters/streamparse');

test('提取 assistant 文本', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '写好了 index.html' }] } });
  assert.equal(parseClaudeStream(line).text, '写好了 index.html');
});
test('提取 result 的 usage 与 cost', () => {
  const line = JSON.stringify({ type: 'result', usage: { input_tokens: 100, output_tokens: 40 }, total_cost_usd: 0.012 });
  const r = parseClaudeStream(line);
  assert.deepEqual(r.usage, { input: 100, output: 40, cost: 0.012 });
});
test('非 JSON 行返回原文本', () => {
  assert.equal(parseClaudeStream('plain log line').text, 'plain log line');
});
test('#6a 提取 tool_use → 可读工具行(不并入 text)', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'text', text: '开始改' },
    { type: 'tool_use', name: 'Read', input: { file_path: 'src/app.js' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
  ] } });
  const r = parseClaudeStream(line);
  assert.equal(r.text, '开始改');                        // 文本照旧
  assert.deepEqual(r.tools, ['🔧 Read src/app.js', '🔧 Bash npm test']); // 工具单列,不混入 text
});
test('#6a 纯工具事件无 text 时只回 tools', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Edit', input: { file_path: 'index.html' } },
  ] } });
  const r = parseClaudeStream(line);
  assert.equal(r.text, undefined);
  assert.deepEqual(r.tools, ['🔧 Edit index.html']);
});
