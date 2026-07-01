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
async function fromLLM(text, claude, agentIds, orchestration) {
  const prompt = `把下面的开发任务拆成 JSON,字段 steps,每步 {id,agent,prompt,deps}。`
    + `agent 只能取这些 id 之一: ${agentIds.join(', ')}。`
    + (orchestration ? `严格按用户给出的编排来分步与指派 agent:「${orchestration}」。` : '')
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

// #2 需求分析:把用户简短需求扩写成高质量、可执行的 brief,提升产出质量
async function refineBrief(text, claude) {
  const p = '你是资深产品经理+架构师。把下面用户的简短需求扩写成一份高质量、可直接执行的开发任务说明(brief),'
    + '包含:明确目标;核心功能点(具体到可交付);页面/模块结构;技术选型(优先零依赖或 CDN、单文件优先);验收要点。'
    + '要具体可落地,不空话,不反问。直接输出 brief 正文(不超过 300 字)。\n\n用户需求: ' + text;
  const { output } = await claude.run({ prompt: p, workdir: process.cwd(), onLine: () => {} });
  const b = (output || '').trim();
  return b ? (text + '\n\n【需求细化】\n' + b).slice(0, 3500) : text;
}

// agents=所选 agent(约束);orchestration=文字编排;refine=是否先细化需求
async function makePlan(text, opts) {
  const { mode, agents, orchestration, refine, templatesDir, claude } = opts;
  const allowed = (agents && agents.length) ? agents : ['claude'];
  let brief = text;
  if (refine && claude) { try { brief = await refineBrief(text, claude); } catch (e) {} }
  const orch = (orchestration || '').trim();

  // 1) 有文字编排 → 按编排(约束到所选 agent)
  if (orch && claude) {
    try { const p = await fromLLM(brief, claude, allowed, orch); if (validate(p, allowed)) return p; } catch (e) {}
  }
  // 2) 只选了一个 agent + 无编排 → 该 agent 单步直做
  if (allowed.length === 1) {
    return { task: text, steps: [{ id: 'build', agent: allowed[0], prompt: brief, deps: [] }] };
  }
  // 3) 显式模板模式且含 claude+codex → 走模板
  if (mode === 'template' && allowed.includes('claude') && allowed.includes('codex')) {
    const tpl = fromTemplate(brief, templatesDir); if (tpl) return tpl;
  }
  // 4) 多 agent → LLM 用这些 agent 拆
  if (claude) {
    try { const p = await fromLLM(brief, claude, allowed); if (validate(p, allowed)) return p; } catch (e) {}
  }
  // 5) 兜底
  if (allowed.includes('claude') && allowed.includes('codex')) { const tpl = fromTemplate(brief, templatesDir); if (tpl) return tpl; }
  return { task: text, steps: [{ id: 'build', agent: allowed[0], prompt: brief, deps: [] }] };
}

module.exports = { fromTemplate, fromLLM, makePlan, validate, refineBrief };
