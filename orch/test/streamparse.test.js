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
