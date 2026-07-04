// 解析 claude --output-format stream-json 的一行 JSON 事件
function parseClaudeStream(line) {
  let j; try { j = JSON.parse(line); } catch (e) { return { text: line }; } // 非 JSON 当普通文本
  if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
    const t = j.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    return t ? { text: t } : {};
  }
  if (j.type === 'result') {
    const u = j.usage || {};
    // result 事件只取 usage/cost;正文已由 assistant 事件流式采集,不重复取 j.result
    return { usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cost: j.total_cost_usd || 0 } };
  }
  return {};
}
module.exports = { parseClaudeStream };
