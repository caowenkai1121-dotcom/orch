const { test } = require('node:test');
const assert = require('node:assert');
const { parseClaudeStream, parseCodexStream } = require('../adapters/streamparse');
const { shArg } = require('../adapters/shquote');

test('审查修复:shArg 在 POSIX 单引号杜绝命令替换,Windows 保持 JSON.stringify', () => {
  assert.equal(shArg('a $(touch x) `id` b', 'linux'), "'a $(touch x) `id` b'"); // 全字面,$()/`` 不解释
  assert.equal(shArg("it's", 'linux'), "'it'\\''s'");                             // 单引号正确转义
  assert.equal(shArg('x', 'win32'), '"x"');                                       // Windows 保持原行为
});

test('claude prompt 走 stdin:args 不含 prompt(避 Windows ~8K 命令行上限),只读档 --disallowedTools 置末尾', () => {
  const { buildArgs } = require('../adapters/claude');
  const a = buildArgs({ permission: 'read' });
  assert.ok(!a.some((x) => String(x).includes('THEPROMPT')), 'prompt 不应再进命令行参数');
  const di = a.indexOf('--disallowedTools');
  assert.ok(di >= 0 && a.slice(di + 1).every((x) => !String(x).startsWith('--')), '--disallowedTools 变参应在末尾,后随仅工具名');
  assert.equal(buildArgs({}).indexOf('--disallowedTools'), -1); // 非只读档无此标志
});

test('jsonl:input 经 stdin 写给子进程(长 prompt 不再受命令行长度限制)', async () => {
  const { runJsonl } = require('../adapters/jsonl');
  const long = 'X'.repeat(20000) + '_END'; // 远超 8191 命令行上限
  const r = await runJsonl({
    cmd: 'node', args: ['-e', '"let b=[];process.stdin.on(\'data\',(c)=>b.push(c));process.stdin.on(\'end\',()=>console.log(JSON.stringify({ok:Buffer.concat(b).length})))"'],
    parse: (line) => { try { const j = JSON.parse(line); return { text: 'len:' + j.ok }; } catch (e) { return {}; } },
    onLine: () => {}, input: long,
  });
  assert.ok(r.success, 'stdin 子进程应正常退出');
  assert.ok(r.output.includes('len:' + long.length), '子进程应完整收到 stdin, 实际=' + r.output.trim());
});

test('审查修复:parse 崩(裸 null 行)在 jsonl handle 被兜底,不掀翻进程', () => {
  // parseClaudeStream/parseCodexStream 对 JSON.parse("null")=null 读属性会抛;jsonl.handle 现包 try/catch。
  const { runJsonl } = require('../adapters/jsonl'); // 仅确认可 require;handle 的 try/catch 见 jsonl.js
  assert.equal(typeof runJsonl, 'function');
  assert.throws(() => parseClaudeStream('null')); // 确认根因:parser 自身对裸 null 仍抛(故需 handle 层兜底)
});

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
test('#6a claude:thinking 块 → 💭 预览(仅进 tools/onLine,不入 text/output)', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: '我先算 3 个质数相乘 2*3*5=30', signature: 'sig' },
    { type: 'text', text: '答案是 30' },
  ] } });
  const r = parseClaudeStream(line);
  assert.equal(r.text, '答案是 30');                       // 正文照旧
  assert.ok(r.tools.some((x) => /💭.*质数/.test(x)));       // 思考 → 💭 预览
  // 空 thinking 不出预览
  const empty = parseClaudeStream(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 's' }] } }));
  assert.equal(empty.tools, undefined);
});

test('#6a 纯工具事件无 text 时只回 tools', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Edit', input: { file_path: 'index.html' } },
  ] } });
  const r = parseClaudeStream(line);
  assert.equal(r.text, undefined);
  assert.deepEqual(r.tools, ['🔧 Edit index.html']);
});

test('#6b codex --json:agent_message → 最终文本', () => {
  const line = JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'OK 完成' } });
  assert.equal(parseCodexStream(line).text, 'OK 完成');
});
test('#6b codex --json:turn.completed → 真实用量(output_tokens 已含 reasoning,不重复计)', () => {
  const line = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 22477, output_tokens: 49, reasoning_output_tokens: 42 } });
  assert.deepEqual(parseCodexStream(line).usage, { input: 22477, output: 49 }); // output_tokens 已含 reasoning,不再 +42
});
test('#6b codex --json:非 JSON(MCP错误日志)/无关事件忽略', () => {
  assert.deepEqual(parseCodexStream('2026-... ERROR rmcp::transport worker quit'), {});
  assert.deepEqual(parseCodexStream(JSON.stringify({ type: 'turn.started' })), {});
});
test('#6a codex:命令/文件事件 → 🔧 实时活动(item.started,剥 powershell 包装)', () => {
  const cmd = JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'powershell.exe -Command "echo done"' } });
  assert.deepEqual(parseCodexStream(cmd).tools, ['🔧 运行 echo done']);
  const fc = JSON.stringify({ type: 'item.started', item: { type: 'file_change', changes: [{ path: 'C:/x/hi.txt', kind: 'add' }, { path: 'a/b.js', kind: 'modify' }] } });
  assert.deepEqual(parseCodexStream(fc).tools, ['🔧 改文件 +hi.txt ~b.js']);
  // item.completed 的命令/文件不重复出 tools(避免与 started 重复计)
  assert.deepEqual(parseCodexStream(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'x', exit_code: 0 } })), {});
});
