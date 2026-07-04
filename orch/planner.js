const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { metaDir } = require('./workspace'); // 规划/细化的中性 cwd,隔离误写

// 把 plan 里所有 prompt 的 {task} 替换成任务文本
function fill(steps, task) {
  return steps.map((s) => {
    const out = { ...s };
    if (out.prompt) out.prompt = out.prompt.split('{task}').join(task); // split/join:全部替换 + 不把 task 里的 $&/$1 当特殊替换模式
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

// 从 LLM 输出抽 JSON 计划:剥代码围栏 + 括号配平扫描出所有平衡 {...} 候选,返回首个能 parse 且含 steps 的
//(旧贪婪正则 /\{[\s\S]*\}/ 会从"回显的格式说明如 {id,agent} 的 { "一路吃到最后一个 } → parse 崩 → 计划降级单步)
function extractJson(s) {
  s = String(s == null ? '' : s).replace(/```(?:json)?/gi, '');
  const cands = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') { if (depth === 0) start = j; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start >= 0) { cands.push(s.slice(start, j + 1)); start = -1; } }
  }
  for (const c of cands) { try { const o = JSON.parse(c); if (o && o.steps) return o; } catch (e) {} } // 优先含 steps 的真计划
  for (const c of cands) { try { return JSON.parse(c); } catch (e) {} }                                  // 退而求其次:任一可 parse
  return JSON.parse(s); // 全失败:原样 parse(抛错→上层降级,行为同旧)
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
async function fromLLM(text, claude, agentIds, orchestration, feedback) {
  const prompt = `把下面的开发任务拆成 JSON,字段 steps,每步 {id,agent,prompt,deps},可选 "expected_outcome":"一句话本步验收标准/预期产出"。`
    + `agent 只能取这些 id 之一: ${agentIds.join(', ')}。`
    + (orchestration ? `严格按用户给出的编排来分步与指派 agent:「${orchestration}」。` : '')
    + `可用 {id,type:"loop",until:"pass",max,deps,body:[...]} 表示"实现→验证,失败重试"。`
    + `多个无依赖的步骤会并行;并行且会改同一文件/目录的步骤给它们相同的 "lock":"名字" 字段使其互斥串行(不冲突的步不要加 lock)。纯审查/分析且确定不改文件的步可加 "permission":"read" 在只读沙箱运行(会改文件的步不要加)。`
    + `要求:每步必须自包含、可直接执行,不要假设存在外部设计文档/接口/数据——需要就让该步自己创建(如先建 mock 数据/页面);`
    + `每步 prompt 明确产出物(创建哪些文件),让 agent 直接动手做完,不要反问。`
    + (feedback ? `\n⚠ 上次拆分存在这些问题,请修正后重新拆分(agent 必须取上列 id,step id 不得重复,每步须指派 agent):${feedback}` : '')
    + `只输出 JSON,不要解释。任务: ${text}`;
  const { output } = await claude.run({ prompt, workdir: metaDir(), onLine: () => {} });
  const plan = extractJson(output);
  plan.task = text;
  return plan;
}

// #2 需求分析:把用户简短需求扩写成高质量、可执行的 brief,提升产出质量
async function refineBrief(text, claude) {
  const p = '你是资深产品经理+架构师。把下面用户的简短需求扩写成一份高质量、可直接执行的开发任务说明(brief),'
    + '包含:明确目标;核心功能点(具体到可交付);页面/模块结构;技术选型(优先零依赖或 CDN、单文件优先);验收要点。'
    + '要具体可落地,不空话,不反问。只用相对文件名描述产出,严禁写任何绝对路径或对工作目录的假设(执行时会在正确的工作目录运行)。' // 防细化时把本调用的中性 cwd(metaDir)当成工作目录写进 brief,害得执行步把交付物落到 metaDir
    + '直接输出 brief 正文(不超过 300 字)。\n\n用户需求: ' + text;
  const { output } = await claude.run({ prompt: p, workdir: metaDir(), onLine: () => {} });
  let b = (output || '').trim();
  if (b) b = b.split(metaDir()).join('.'); // 兜底:即使 LLM 仍吐出 metaDir 绝对路径也剥成相对,不让它污染执行步
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
  const stat = (r) => { const dn = r.done_count || 0, en = r.empty_count || 0; return (dn + en) >= 2 ? ' [记录:' + dn + '落盘/' + en + '空转]' : ''; };
  const catalog = scope.map((d) =>
    (dName[d] || d) + ': ' + (byDept[d] || []).map((r) => r.id + '(' + r.name + ':' + (r.description || '').slice(0, 40) + ')' + stat(r)).join('、') + flowLine(d)
  ).join('\n');
  const prompt = `你是「总调度」,公司的自主流水线管理者,拥有最高权限,可调度所有部门与员工。你见过项目因跳过质量环节或员工孤立工作而失败,因此严格执行:顺序交接(上游产出是下游输入)、质量门禁(评审/核查通过才推进)、按部门标准流程作业。\n`
    + (chiefMemo ? `你的过往调度复盘(优先吸取):\n${chiefMemo}\n` : '') + '\n'
    + (deptId ? `本任务是「${dName[deptId] || deptId}」的部门任务,只用该部门员工,严格按其标准流程拆分(可选环节由你判断是否需要;质量门环节用 loop 包住"产出员工→门禁员工",失败重做)。\n` : '')
    + `公司部门与员工目录:\n${catalog}\n\n`
    + `把下面的任务拆成 JSON,字段 steps,每步 {id,role,prompt,deps},可选 "expected_outcome":"一句话本步验收标准/预期产出(质量门据此判定)"。role 必须取员工目录中的员工 id。`
    + (orchestration ? `严格按用户给出的编排来分步与指派:「${orchestration}」。` : '')
    + `可用 {id,type:"loop",until:"pass",max:3,deps,body:[实现步,验证步]} 表示"实现→质量门,FAIL 重做,最多3次"。多个无依赖的步骤会并行;并行且会改同一文件/目录的步骤给它们相同的 "lock":"名字" 字段使其互斥串行(不冲突的步不要加 lock)。纯审查/分析且确定不改文件的步可加 "permission":"read" 在只读沙箱运行(会改文件的步不要加)。`
    + `(员工后的[记录:X落盘/Y空转]是历史表现,空转=声称做了却没产出文件;同类岗位优先选落盘多空转少的。)`
    + `调度要求:0)先判复杂度:【简单任务】(单文件/脚本/小改动/单一明确产出)1-2步直接做,不强加质量门;【复杂任务】(多模块/前后端/多角色协作)按模块/功能点细分成多步(会自动在前面插入"方案会议"阶段,你只需专注把实现步拆细拆清,别自己加会议步)。1)拆解要细且可追溯:每步只做一件明确的事,step id 用能看出在做什么的名字(如 clarify_req/design_ui/impl_login/test_auth),prompt 写清"你(角色)负责什么、产出哪些文件";实现按功能点/模块拆成多步,让流水线能看出每个角色何时做什么,别把多件事塞进一步(简单任务仍保持1-2步,别为拆而拆);2)只挑真正需要的员工,部门有标准流程的按流程顺序,不需要的可选环节跳过;3)每步 prompt 自包含可直接执行,明确产出物(创建哪些文件),并写明"参考上游交接备忘"(上游产出会自动注入);4)不假设存在外部文档;5)非代码类员工产出 Markdown 文档,写明文件名。只输出 JSON,不要解释。`
    + (feedback ? `\n\n⚠ 上次拆分存在这些问题,请修正后重新拆分(员工 id 必须取目录中真实存在的,step id 不得重复,每步须指派员工):${feedback}` : '')
    + `\n任务: ${text}`;
  const { output } = await claude.run({ prompt, workdir: metaDir(), onLine: () => {} });
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

// #9 计划结构体检:返回问题清单(空=健康)。捕 sanitizeDeps 不管的结构错——重复 id(runPlan done[id] 碰撞丢步)、
// 步缺指派、loop 缺 body。供 makePlan 带具体问题回喂 planner 重拆一次(而非静默 sanitize 成降级计划)。
function lintPlan(plan, hasRole) {
  const steps = (plan && plan.steps) || [];
  if (!Array.isArray(steps) || !steps.length) return ['计划无任何步骤'];
  const problems = []; const seen = new Set();
  const walk = (arr) => (arr || []).forEach((s) => {
    if (!s || s.id == null) { problems.push('存在无 id 的步骤'); return; }
    if (seen.has(s.id)) problems.push('步骤 id 重复:' + s.id);
    seen.add(s.id);
    if (s.type === 'loop') { if (!Array.isArray(s.body) || !s.body.length) problems.push('loop 步骤「' + s.id + '」缺 body 子步骤'); walk(s.body); }
    else if (hasRole ? !s.role : !s.agent) problems.push('步骤「' + s.id + '」未指派' + (hasRole ? '员工(role)' : '执行器(agent)'));
  });
  walk(steps);
  return [...new Set(problems)];
}

// #16 合并编辑后的计划:已完成步(doneIds)原样保留(防客户端误删/误改历史),其余用客户端编辑后的,再 sanitizeDeps
function mergeEditedPlan(cur, incoming, doneIds) {
  const done = new Set(doneIds || []);
  const kept = ((cur && cur.steps) || []).filter((s) => s && done.has(s.id));
  const edited = ((incoming && incoming.steps) || []).filter((s) => s && s.id != null && !done.has(s.id));
  return sanitizeDeps({ task: (cur && cur.task) || (incoming && incoming.task), steps: kept.concat(edited) });
}

// 依赖健全化:剔除指向不存在步骤的依赖、自依赖,拓扑排序断环(防 runPlan 静默卡死)
function sanitizeDeps(plan) {
  if (!plan || typeof plan !== 'object') return { steps: [] };
  // 用户编辑的计划可能 steps 非数组或含非法项 → 归一化为合法步骤数组(防 execute 崩)
  if (!Array.isArray(plan.steps)) plan.steps = [];
  plan.steps = plan.steps.filter((s) => s && typeof s === 'object' && s.id != null);
  // 重复 step id 去重(保留首个):runPlan 的 done/started 以 id 键化,重复 id 会静默丢步/互相覆盖、误判完成。
  // lint 会先尝试回喂重拆,这是最后兜底(也护住 edit-plan 客户端可写路径)。
  { const seen = new Set(); plan.steps = plan.steps.filter((s) => { if (seen.has(s.id)) return false; seen.add(s.id); return true; }); }
  // loop body 子步同样去重 id + 剔自依赖:runLoop 顺序跑虽不用 body deps,但 api.plan 画布展开(按 body id 建节点)与 lint 需一致,防重复节点/残留
  plan.steps.forEach((s) => { if (Array.isArray(s.body)) { const bs = new Set(); s.body = s.body.filter((b) => b && b.id != null && !bs.has(b.id) && bs.add(b.id)); s.body.forEach((b) => { if (b.deps) b.deps = b.deps.filter((d) => d !== b.id); }); } });
  const steps = plan.steps;
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
  // role 模式合法执行器 = 各部门执行器池并集(∩allowed);LLM 有时不给 role 而直接吐裸 agent,
  // 若该 agent 越出角色池(如自动发现但未纳入任何池的 gemini/qwen,可能 args 不对而失败)则 coerce 回池内,与有 role 的步同规则,防未验证 agent 混入 role 模式。
  const poolUnion = [];
  Object.keys(deptPools || {}).forEach((d) => (deptPools[d] || []).forEach((a) => { if (allowed.indexOf(a) >= 0 && poolUnion.indexOf(a) < 0) poolUnion.push(a); }));
  const roleAllowed = poolUnion.length ? poolUnion : allowed;
  (steps || []).forEach((s) => {
    if (s.body) { resolveRoles(s.body, roleMap, allowed, deptPools, taskText, depts); return; }
    if (!s.role) { if (s.agent && roleAllowed.indexOf(s.agent) < 0) s.agent = roleAllowed[0]; return; }
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

// 用户需求:复杂任务先开"方案会议"(代码强制,不靠 LLM 自觉)。计划够复杂(≥4步且≥2不同角色)则前置:
// 每个参会角色并行写本视角方案要点 md → 一个"方案综合"步产出《方案.md》→ 原实现步的根全部改为依赖综合步、按方案做。
// 让编排画布清楚看到"先开会定方案、再各角色分头实现"。简单任务(<4步或角色单一)不开会,直接做。
function prependMeeting(plan, roleMap) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length < 4) return plan; // 简单任务不开会
  const ids = Object.keys(roleMap || {});
  if (ids.length < 2) return plan; // 无员工目录(执行器模式),不开会
  // 参会角色从员工目录挑:优先设计/规划类(架构/产品/评审/测试/负责人),不足则补其它——不依赖 LLM 是否在实现步用了 role
  const want = ['architect', 'product', 'reviewer', 'lead', 'qa', 'test', 'design', 'prototyper', 'manager', 'engineer'];
  const score = (id) => want.reduce((n, w) => n + (String(id).toLowerCase().includes(w) ? 1 : 0), 0);
  const attendees = ids.slice().sort((a, b) => score(b) - score(a)).slice(0, 3);
  if (attendees.length < 2) return plan;
  const fid = (r) => 'meet_' + String(r).replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 24);
  const ex = (r) => (roleMap[r] && roleMap[r].executor) || 'claude'; // 用参会角色的执行器,会议步直接带 agent(role/执行器两种模式都能用,不依赖 resolveRoles)
  const nm = (r) => (roleMap[r] && (roleMap[r].name || roleMap[r].label)) || r;
  const meetSteps = attendees.map((r) => ({
    id: fid(r), agent: ex(r), deps: [],
    prompt: '【方案会议·你的视角】你是「' + nm(r) + '」。就本任务从你的专业视角给出方案要点:需求边界/技术选型或做法/接口与数据约定/风险/验收口径。只写一个文件 ' + fid(r) + '.md,不改其它文件。',
    expected_outcome: '你这一视角的方案要点(' + fid(r) + '.md)',
  }));
  const decide = {
    id: 'decide_plan', agent: ex(attendees[0]), deps: meetSteps.map((m) => m.id),
    prompt: '【方案综合·会议主持】读齐各位的 ' + meetSteps.map((m) => m.id + '.md').join('、') + ',综合成最终《方案.md》:确定总体架构、模块划分、接口/数据约定、各部分分工、验收口径。这是后续所有实现步的唯一依据。',
    expected_outcome: '《方案.md》——定架构/接口/分工/验收',
  };
  plan.steps.forEach((s) => { if (!Array.isArray(s.deps) || !s.deps.length) s.deps = ['decide_plan']; }); // 原实现步的根改为依赖会议结论
  plan.steps = [...meetSteps, decide, ...plan.steps];
  return plan;
}

// agents=所选执行器;roles/depts=员工目录;dept=部门任务;deptPools=部门执行器池;orchestration=文字编排;refine=需求细化
async function makePlan(text, opts) {
  const { mode, agents, roles, depts, dept, deptPools, explicit, orchestration, refine, templatesDir, onChild } = opts;
  // 包装 claude:①注入 onChild(规划期 LLM 子进程注册运行态,支持取消)②过并发信号量(规划/细化调用也受 ORCH_CONCURRENCY 约束,防突发 fork 风暴)
  const base = opts.claude;
  const claude = base ? { run: async (o) => { const s = require('./engine').sem(); await s.acquire(); try { return await base.run(onChild ? Object.assign({}, o, { onChild }) : o); } finally { s.release(); } } } : base;
  const allowed = (agents && agents.length) ? agents : ['claude'];
  let brief = text;
  // 需求细化只对"短/含糊"的需求做(长需求已足够详细,省一次 LLM 调用与延迟)
  // 细化仅针对"短且笼统"的需求(如"做个网站");已列多个需求点(≥2个、/,/;分隔)的任务本就够具体,跳过细化省一次昂贵 LLM 调用(提速规划)
  const needRefine = refine && claude && (text || '').length < 160 && ((text || '').match(/[、,，;；]/g) || []).length < 2;
  if (needRefine) { try { brief = await refineBrief(text, claude); } catch (e) {} }
  const orch = (orchestration || '').trim();
  const chief = (roles || []).find((r) => r.id === 'chief-orchestrator'); // 总调度经验行
  const chiefMemo = chief && chief.memo ? relevantMemo(chief.memo, brief, 6) : ''; // 与员工一致:调度复盘也按当前任务相关性优选,不无脑塞全部
  const empRoles = (roles || []).filter((r) => r.dept !== '__system');    // __system 不进员工目录
  const deptRoles = dept ? empRoles.filter((r) => r.dept === dept) : empRoles;
  const roleMap = {}; deptRoles.forEach((r) => { roleMap[r.id] = r; });
  const roleIds = Object.keys(roleMap);

  let empModeFell = false; // 员工模式该走却没成功 → 后续回退标记为"降级"(丢了团队协作)
  const mark = (p) => (empModeFell && p ? Object.assign(p, { degraded: true }) : p);
  // 1) 用户显式只选一个执行器 + 无编排 + 非部门任务 → 该执行器单步直做(保持既有行为)
  if (explicit && allowed.length === 1 && !orch && !dept) {
    return { task: text, steps: [{ id: 'build', agent: allowed[0], prompt: brief, deps: [] }] };
  }
  // 2) 员工模式(默认):总调度按部门员工目录与流程规范拆分;部门任务只用该部门员工
  //    自愈:非法 role → 就近纠正;仍非法 → 带错误反馈让 LLM 重拆一次(避免默默丢角色回退到裸执行器)
  if (roleIds.length && claude && mode !== 'template') {
    try {
      let p = await fromLLMRoles(brief, claude, deptRoles, depts, orch, dept, chiefMemo);
      // 接受条件:每步是合法 role,或 LLM 夹带的裸合法 agent(容忍夹带,resolveRoles 会把裸 agent coerce 到部门执行器池);非法 role 仍视为失败
      const rmOk = (s) => s.type === 'loop' ? (Array.isArray(s.body) && s.body.length && s.body.every(rmOk)) : (roleIds.includes(s.role) || (!s.role && allowed.includes(s.agent)));
      // 提速:首版计划已可接受(结构合法)就直接用,不再花一次昂贵 LLM 回喂重拆;仅当首版不可接受(非法员工/缺指派/loop缺body)才带问题回喂一次
      if (!p.steps.every(rmOk)) {
        if (!validateRoles(p, roleIds)) coerceRoles(p.steps, roleIds);
        const bad = validateRoles(p, roleIds) ? [] : badRoles(p, roleIds);
        const lint = lintPlan(p, true);
        if (bad.length || lint.length) {
          const fb = [...bad.map((r) => '员工id「' + r + '」不在员工目录'), ...lint].join('；');
          try { const p2 = await fromLLMRoles(brief, claude, deptRoles, depts, orch, dept, chiefMemo, fb); coerceRoles(p2.steps, roleIds); if (p2.steps.every(rmOk)) p = p2; } catch (e) {}
        }
      }
      prependMeeting(p, roleMap); // 复杂计划前置"方案会议":讨论步→方案综合→实现步依赖它(代码强制,画布可见先开会再实现)
      if (p.steps.every(rmOk)) { sanitizeDeps(p); resolveRoles(p.steps, roleMap, allowed, deptPools, text, depts); return p; } // 解析:role→executor、裸 agent→coerce 到池(防 broken 自动发现 agent 混入)
    } catch (e) { /* 落到执行器模式 */ }
    empModeFell = true; // 员工模式进了但没成功返回 → 下面回退即降级
  }
  // 3) 有文字编排 → 按编排(执行器模式)
  if (orch && claude) {
    try {
      let p = await fromLLM(brief, claude, allowed, orch);
      const lint = lintPlan(p, false); // #9 执行器模式同样体检:坏计划带问题回喂重拆一次
      if (lint.length) { try { const p2 = await fromLLM(brief, claude, allowed, orch, lint.join('；')); if (validate(p2, allowed) && !lintPlan(p2, false).length) p = p2; } catch (e) {} }
      if (validate(p, allowed)) { prependMeeting(p, roleMap); return mark(sanitizeDeps(p)); } // 执行器模式也前置方案会议(复杂计划)
    } catch (e) {}
  }
  // 4) 显式模板模式且含 claude+codex → 走模板
  if (mode === 'template' && allowed.includes('claude') && allowed.includes('codex')) {
    const tpl = fromTemplate(brief, templatesDir); if (tpl) return mark(tpl);
  }
  // 5) 多执行器 → LLM 拆
  if (claude && allowed.length > 1) {
    try {
      let p = await fromLLM(brief, claude, allowed);
      const lint = lintPlan(p, false); // #9 执行器模式体检 + 回喂
      if (lint.length) { try { const p2 = await fromLLM(brief, claude, allowed, undefined, lint.join('；')); if (validate(p2, allowed) && !lintPlan(p2, false).length) p = p2; } catch (e) {} }
      if (validate(p, allowed)) { prependMeeting(p, roleMap); return mark(sanitizeDeps(p)); } // 执行器模式也前置方案会议(复杂计划)
    } catch (e) {}
  }
  // 6) 兜底
  if (allowed.includes('claude') && allowed.includes('codex')) { const tpl = fromTemplate(brief, templatesDir); if (tpl) return mark(tpl); }
  return mark({ task: text, steps: [{ id: 'build', agent: allowed[0], prompt: brief, deps: [] }] });
}

module.exports = { fromTemplate, fromLLM, fromLLMRoles, makePlan, validate, validateRoles, resolveRoles, refineBrief, coerceRoles, badRoles, sanitizeDeps, lintPlan, mergeEditedPlan, extractJson, fill, prependMeeting };
