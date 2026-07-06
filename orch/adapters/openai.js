// OpenAI 兼容 Chat Completions 适配器:kind≠cli 且配了 base_url 的「大模型 Agent」(DeepSeek/Kimi/GLM/通义 等)。
// 三项即接入:地址(base_url)+ Key(api_key)+ 模型(model)。纯文本产出——适合会议发言/文档/分析类调用;
// 执行步需要读写文件,resolveRoles 会把此类 agent 自动回退到 CLI 执行器,不会误接实现步。
function endpointOf(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : base + '/chat/completions'; // 填到 /v1 或裸域名都行
}
function make(def) {
  let pricing = null; try { pricing = def.pricing ? JSON.parse(def.pricing) : null; } catch (e) {}
  const url = endpointOf(def.base_url);
  return {
    async run({ prompt, model, onLine, onUsage }) {
      const mdl = model || def.model || '';
      const ms = process.env.ORCH_STEP_TIMEOUT_MS != null ? Number(process.env.ORCH_STEP_TIMEOUT_MS) : 1200000;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(def.api_key ? { authorization: 'Bearer ' + def.api_key } : {}) },
          body: JSON.stringify({ model: mdl, messages: [{ role: 'user', content: String(prompt || '') }] }),
          signal: ms > 0 ? AbortSignal.timeout(ms) : undefined,
        });
        if (!res.ok) {
          const t = (await res.text().catch(() => '')).slice(0, 300);
          onLine && onLine('✗ API ' + res.status + ' ' + t);
          return { output: 'API 错误 ' + res.status + ': ' + t, success: false };
        }
        const j = await res.json();
        const output = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        if (onLine) output.split('\n').filter(Boolean).slice(0, 40).forEach(onLine);
        const u = j.usage || {};
        if (onUsage) onUsage({ input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cost: pricing ? ((u.prompt_tokens || 0) * (pricing.in || 0) + (u.completion_tokens || 0) * (pricing.out || 0)) / 1e6 : 0 });
        return { output, success: true };
      } catch (e) {
        const msg = 'API 调用失败: ' + ((e && e.message) || e);
        onLine && onLine('✗ ' + msg);
        return { output: msg, success: false };
      }
    },
  };
}
module.exports = { make, endpointOf };
