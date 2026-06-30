const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// 把 plan 里所有 prompt 的 {task} 替换成任务文本
function fill(steps, task) {
  return steps.map((s) => {
    const out = { ...s };
    if (out.prompt) out.prompt = out.prompt.replace('{task}', task);
    if (out.body) out.body = fill(out.body, task);
    return out;
  });
}

function fromTemplate(text, templatesDir) {
  if (!fs.existsSync(templatesDir)) return null;
  const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.yaml'));
  for (const f of files) {
    const tpl = yaml.load(fs.readFileSync(path.join(templatesDir, f), 'utf8'));
    const m = tpl.match || '';
    if (text.includes(m)) { // 空 match 兜底匹配所有
      return { task: text, steps: fill(tpl.steps, text) };
    }
  }
  return null;
}

function extractJson(s) {
  const m = s.match(/\{[\s\S]*\}/); // 抓第一个 {...} 块
  return JSON.parse(m ? m[0] : s);
}

function collectIds(steps, acc) {
  steps.forEach((s) => { acc.push(s.id); if (s.body) collectIds(s.body, acc); });
  return acc;
}
function validate(plan, agentIds) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return false;
  const ids = collectIds(plan.steps, []);
  const checkStep = (s) => {
    if (s.type === 'loop') return Array.isArray(s.body) && s.body.length && s.body.every(checkStep);
    if (!agentIds.includes(s.agent)) return false;
    if (s.deps && s.deps.some((d) => !ids.includes(d))) return false;
    return true;
  };
  return plan.steps.every(checkStep);
}
async function fromLLM(text, claude, agentIds) {
  const prompt = `把下面的开发任务拆成 JSON,字段 steps,每步 {id,agent,prompt,deps}。`
    + `agent 只能取这些 id 之一: ${agentIds.join(', ')}。`
    + `可用 {id,type:"loop",until:"pass",max,deps,body:[...]} 表示"实现→验证,失败重试"。`
    + `多个无依赖的步骤会并行。`
    + `要求:每步必须自包含、可直接执行,不要假设存在外部设计文档/接口/数据——需要就让该步自己创建(如先建 mock 数据/页面);`
    + `每步 prompt 明确产出物(创建哪些文件),让 agent 直接动手做完,不要反问。`
    + `只输出 JSON,不要解释。任务: ${text}`;
  const { output } = await claude.run({ prompt, workdir: process.cwd(), onLine: () => {} });
  const plan = extractJson(output);
  plan.task = text;
  return plan;
}

async function makePlan(text, opts) {
  const { mode, agents, templatesDir, claude } = opts;
  if (mode === 'llm' && claude && agents && agents.length) {
    try {
      const plan = await fromLLM(text, claude, agents);
      if (validate(plan, agents)) return plan;
    } catch (e) { /* 落到模板 */ }
  }
  return fromTemplate(text, templatesDir) || { task: text, steps: [] };
}

module.exports = { fromTemplate, fromLLM, makePlan, validate };
