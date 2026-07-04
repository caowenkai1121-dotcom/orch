// tool_use 块 → 可读一行(如「🔧 Read app.js」);挑输入里最有信息量的字段,截断
function toolBrief(name, input) {
  input = input || {};
  const v = input.file_path || input.path || input.command || input.pattern || input.url || input.query || input.description;
  let s = (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim();
  if (s.length > 80) s = s.slice(0, 80) + '…';
  return '🔧 ' + (name || 'tool') + (s ? ' ' + s : '');
}
// 解析 claude --output-format stream-json 的一行 JSON 事件
function parseClaudeStream(line) {
  let j; try { j = JSON.parse(line); } catch (e) { return { text: line }; } // 非 JSON 当普通文本
  if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
    const t = j.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    const tools = j.message.content.filter((c) => c.type === 'tool_use').map((c) => toolBrief(c.name, c.input)); // #6a 工具调用→实时可见
    const out = {};
    if (t) out.text = t;
    if (tools.length) out.tools = tools; // 仅进 onLine(实时流),不并入语义 output,免污染 handoff/gate/NEED_DECISION 判定
    return out;
  }
  if (j.type === 'result') {
    const u = j.usage || {};
    // result 事件只取 usage/cost;正文已由 assistant 事件流式采集,不重复取 j.result
    return { usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cost: j.total_cost_usd || 0 } };
  }
  return {};
}
module.exports = { parseClaudeStream };
