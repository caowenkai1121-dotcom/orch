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

// —— 员工模式:按「部门→员工」目录拆分任务 ——
function validateRoles(plan, roleIds) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return false;
  const ids = collectIds(plan.steps, []);
  const check = (s) => {
    if (s.type === 'loop') return Array.isArray(s.body) && s.body.length && s.body.every(check);
    if (!roleIds.includes(s.role)) return false;
    if (s.deps && s.deps.some((d) => !ids.includes(d))) return false;
    return true;
  };
  return plan.steps.every(check);
}

// 总调度员:最高权限,可调度所有部门所有员工;注入部门流程规范与质量门方法论(参考 agents-orchestrator)
async function fromLLMRoles(text, claude, roles, depts, orchestration, deptId, chiefMemo, feedback) {
  const byDept = {};
  roles.forEach((r) => { (byDept[r.dept] = byDept[r.dept] || []).push(r); });
  const dName = {}; const dFlow = {};
  (depts || []).forEach((d) => { dName[d.id] = d.name; try { dFlow[d.id] = JSON.parse(d.flow) || []; } catch (e) { dFlow[d.id] = []; } });
  const flowLine = (d) => {
    const f = dFlow[d] || [];
    if (!f.length) return '';
    const names = {}; (byDept[d] || []).forEach((r) => { names[r.id] = r.name; });
    return ' 标准流程: ' + f.map((s) => (names[s.role] || s.role) + (s.optional ? '(可选)' : '') + (s.gate ? '(质量门)' : '')).join('→');
  };
  const scope = deptId ? [deptId] : Object.keys(byDept);
  const catalog = scope.map((d) =>
    (dName[d] || d) + ': ' + (byDept[d] || []).map((r) => r.id + '(' + r.name + ':' + (r.description || '').slice(0, 40) + ')').join('、') + flowLine(d)
  ).join('\n');
  const prompt = `你是「总调度」,公司的自主流水线管理者,拥有最高权限,可调度所有部门与员工。你见过项目因跳过质量环节或员工孤立工作而失败,因此严格执行:顺序交接(上游产出是下游输入)、质量门禁(评审/核查通过才推进)、按部门标准流程作业。\n`
    + (chiefMemo ? `你的过往调度复盘(优先吸取):\n${chiefMemo}\n` : '') + '\n'
    + (deptId ? `本任务是「${dName[deptId] || deptId}」的部门任务,只用该部门员工,严格按其标准流程拆分(可选环节由你判断是否需要;质量门环节用 loop 包住"产出员工→门禁员工",失败重做)。\n` : '')
    + `公司部门与员工目录:\n${catalog}\n\n`
    + `把下面的任务拆成 JSON,字段 steps,每步 {id,role,prompt,deps}。role 必须取员工目录中的员工 id。`
    + (orchestration ? `严格按用户给出的编排来分步与指派:「${orchestration}」。` : '')
    + `可用 {id,type:"loop",until:"pass",max:3,deps,body:[实现步,验证步]} 表示"实现→质量门,FAIL 重做,最多3次"。多个无依赖的步骤会并行。`
    + `调度要求:1)只挑真正需要的员工(通常2-5步),部门有标准流程的按流程顺序,不需要的可选环节跳过;2)每步 prompt 自包含可直接执行,明确产出物(创建哪些文件),并写明"参考上游交接备忘"(上游产出会自动注入);3)不假设存在外部文档;4)非代码类员工产出 Markdown 文档,写明文件名。只输出 JSON,不要解释。`
    + (feedback ? `\n\n⚠ 上次拆分的这些 role 不在员工目录里,请只用目录中真实存在的员工 id 重新拆分:${feedback}` : '')
    + `\n任务: ${text}`;
  const { output } = await claude.run({ prompt, workdir: process.cwd(), onLine: () => {} });
  const plan = extractJson(output);
  plan.task = text;
  return plan;
}

// 收集 plan 里用到的所有 role id(含 loop body)
function collectRoles(steps, acc) {
  (steps || []).forEach((s) => { if (s.role) acc.push(s.role); if (s.body) collectRoles(s.body, acc); });
  return acc;
}
// 计划里非法(不在员工目录)的 role id 列表
function badRoles(plan, roleIds) {
  const set = new Set(roleIds);
  return [...new Set(collectRoles(plan && plan.steps, []).filter((r) => !set.has(r)))];
}
// 自愈:把非法 role 就近纠正到最接近的合法 id(忽略大小写/子串/去部门前缀/词集重叠)
function coerceRoles(steps, roleIds) {
  const lower = roleIds.map((id) => ({ id, l: id.toLowerCase() }));
  const nearest = (bad) => {
    const b = bad.toLowerCase();
    let hit = lower.find((x) => x.l === b); if (hit) return hit.id;
    hit = lower.find((x) => x.l.includes(b) || b.includes(x.l)); if (hit) return hit.id;
    const bw = new Set(b.split(/[-_\s]+/).filter(Boolean));
    let best = null, bestN = 0;
    lower.forEach((x) => { const n = x.l.split(/[-_\s]+/).filter((w) => bw.has(w)).length; if (n > bestN) { bestN = n; best = x.id; } });
    return bestN >= 1 ? best : null;
  };
  const walk = (arr) => (arr || []).forEach((s) => {
    if (s.body) walk(s.body);
    if (s.role && roleIds.indexOf(s.role) < 0) { const fix = nearest(s.role); if (fix) s.role = fix; }
  });
  walk(steps);
}

// 经验按与当前任务的相关性排序,取最相关的若干条(避免无脑注入不相关经验)
function relevantMemo(memo, taskText, keep) {
  const lines = (memo || '').split('\n').filter(Boolean);
  if (lines.length <= keep) return lines.join('\n');
  const toks = (s) => (s.toLowerCase().match(/[a-z0-9]+|[一-鿿]/gi) || []); // 英文词+中文字
  const tw = new Set(toks(taskText || ''));
  const score = (l) => toks(l).filter((w) => tw.has(w)).length;
  return lines.map((l, i) => ({ l, s: score(l), i })).sort((a, b) => b.s - a.s || b.i - a.i).slice(0, keep).sort((a, b) => a.i - b.i).map((x) => x.l).join('\n');
}

// 依赖健全化:剔除指向不存在步骤的依赖、自依赖,拓扑排序断环(防 runPlan 静默卡死)
function sanitizeDeps(plan) {
  const steps = (plan && plan.steps) || [];
  const ids = new Set(steps.map((s) => s.id));
  steps.forEach((s) => { s.deps = (s.deps || []).filter((d) => d !== s.id && ids.has(d)); });
  // 检测环:能拓扑排完则无环;排不动的步骤,清空其依赖(打断环,至少能跑)
  const done = new Set(); let progress = true;
  while (done.size < steps.length && progress) {
    progress = false;
    steps.forEach((s) => { if (!done.has(s.id) && s.deps.every((d) => done.has(d))) { done.add(s.id); progress = true; } });
  }
  if (done.size < steps.length) steps.forEach((s) => { if (!done.has(s.id)) s.deps = []; }); // 环内步骤解依赖
  return plan;
}

// 员工在本部门标准流程中的位置:上游→你(是否质量门)→下游,给员工交接预期
function flowPosition(depts, roleMap, r) {
  const d = (depts || []).find((x) => x.id === r.dept);
  if (!d || !d.flow) return '';
  let f = []; try { f = JSON.parse(d.flow) || []; } catch (e) { return ''; }
  const i = f.findIndex((x) => x.role === r.id);
  if (i < 0) return '';
  const nm = (id) => (roleMap[id] && roleMap[id].name) || id;
  const up = i > 0 ? nm(f[i - 1].role) : '（流程起点）';
  const down = i < f.length - 1 ? nm(f[i + 1].role) : '（流程终点）';
  return '\n【本部门流程位置】上游:' + up + ' → 你' + (f[i].gate ? '(质量门)' : '') + ' → 下游:' + down + '。承接上游产出,产出供下游直接使用。';
}

// 把员工解析进步骤:角色提示词前置 + 绑定执行器(约束在 allowed 与部门执行器池内)
function resolveRoles(steps, roleMap, allowed, deptPools, taskText, depts) {
  (steps || []).forEach((s) => {
    if (s.body) { resolveRoles(s.body, roleMap, allowed, deptPools, taskText, depts); return; }
    if (!s.role) return;
    const r = roleMap[s.role];
    if (!r) { s.agent = s.agent || allowed[0]; return; }
    // 该员工所属部门若设了执行器池,只能用池内执行器
    const pool = deptPools && deptPools[r.dept] && deptPools[r.dept].length ? allowed.filter((a) => deptPools[r.dept].indexOf(a) >= 0) : allowed;
    const eff = pool.length ? pool : allowed;
    let ex = r.executor || 'claude';
    if (eff.length && eff.indexOf(ex) < 0) ex = eff[0];
    s.agent = ex;
    const memo = r.memo ? relevantMemo(r.memo, taskText || s.prompt, 5) : '';
    if (r.prompt) s.prompt = '【你的角色】' + r.prompt + flowPosition(depts, roleMap, r) + (memo ? '\n【过往经验】(此前任务复盘沉淀,已按当前任务相关性优选,优先复用)\n' + memo : '') + '\n\n【任务】' + s.prompt;
  });
}

// agents=所选执行器;roles/depts=员工目录;dept=部门任务;deptPools=部门执行器池;orchestration=文字编排;refine=需求细化
async function makePlan(text, opts) {
  const { mode, agents, roles, depts, dept, deptPools, explicit, orchestration, refine, templatesDir, claude } = opts;
  const allowed = (agents && agents.length) ? agents : ['claude'];
  let brief = text;
  if (refine && claude) { try { brief = await refineBrief(text, claude); } catch (e) {} }
  const orch = (orchestration || '').trim();
  const chief = (roles || []).find((r) => r.id === 'chief-orchestrator'); // 总调度经验行
  const empRoles = (roles || []).filter((r) => r.dept !== '__system');    // __system 不进员工目录
  const deptRoles = dept ? empRoles.filter((r) => r.dept === dept) : empRoles;
  const roleMap = {}; deptRoles.forEach((r) => { roleMap[r.id] = r; });
  const roleIds = Object.keys(roleMap);

  // 1) 用户显式只选一个执行器 + 无编排 + 非部门任务 → 该执行器单步直做(保持既有行为)
  if (explicit && allowed.length === 1 && !orch && !dept) {
    return { task: text, steps: [{ id: 'build', agent: allowed[0], prompt: brief, deps: [] }] };
  }
  // 2) 员工模式(默认):总调度按部门员工目录与流程规范拆分;部门任务只用该部门员工
  //    自愈:非法 role → 就近纠正;仍非法 → 带错误反馈让 LLM 重拆一次(避免默默丢角色回退到裸执行器)
  if (roleIds.length && claude && mode !== 'template') {
    try {
      let p = await fromLLMRoles(brief, claude, deptRoles, depts, orch, dept, chief && chief.memo);
      if (!validateRoles(p, roleIds)) coerceRoles(p.steps, roleIds);
      if (!validateRoles(p, roleIds)) {
        const bad = badRoles(p, roleIds);
        if (bad.length) { const p2 = await fromLLMRoles(brief, claude, deptRoles, depts, orch, dept, chief && chief.memo, bad.join(', ')); coerceRoles(p2.steps, roleIds); if (validateRoles(p2, roleIds)) p = p2; }
      }
      if (validateRoles(p, roleIds)) { sanitizeDeps(p); resolveRoles(p.steps, roleMap, allowed, deptPools, text, depts); return p; }
    } catch (e) { /* 落到执行器模式 */ }
  }
  // 3) 有文字编排 → 按编排(执行器模式)
  if (orch && claude) {
    try { const p = await fromLLM(brief, claude, allowed, orch); if (validate(p, allowed)) return sanitizeDeps(p); } catch (e) {}
  }
  // 4) 显式模板模式且含 claude+codex → 走模板
  if (mode === 'template' && allowed.includes('claude') && allowed.includes('codex')) {
    const tpl = fromTemplate(brief, templatesDir); if (tpl) return tpl;
  }
  // 5) 多执行器 → LLM 拆
  if (claude && allowed.length > 1) {
    try { const p = await fromLLM(brief, claude, allowed); if (validate(p, allowed)) return sanitizeDeps(p); } catch (e) {}
  }
  // 6) 兜底
  if (allowed.includes('claude') && allowed.includes('codex')) { const tpl = fromTemplate(brief, templatesDir); if (tpl) return tpl; }
  return { task: text, steps: [{ id: 'build', agent: allowed[0], prompt: brief, deps: [] }] };
}

module.exports = { fromTemplate, fromLLM, fromLLMRoles, makePlan, validate, validateRoles, resolveRoles, refineBrief, coerceRoles, badRoles, sanitizeDeps };
