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

async function fromLLM(text, claude) {
  const prompt = `把下面的开发任务拆成 JSON,字段 steps,每步 {id,agent,prompt,deps}。`
    + `agent 取值 claude 或 codex。只输出 JSON。任务: ${text}`;
  const { output } = await claude.run({ prompt, workdir: process.cwd(), onLine: () => {} });
  const plan = extractJson(output);
  plan.task = text;
  return plan;
}

async function makePlan(text, { templatesDir, claude }) {
  return fromTemplate(text, templatesDir) || await fromLLM(text, claude);
}

module.exports = { fromTemplate, fromLLM, makePlan };
