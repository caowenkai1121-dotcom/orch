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

// JSON 语法坏(尾逗号/引号未闭合/截断)→ 带原文回喂修复一次,拿不回来才抛。
// 原先 extractJson 一抛,整个员工模式降级成单执行器直做(丢团队协作+质量门),一次语法小错代价过大。
async function extractJsonWithRepair(output, claude) {
  try { return extractJson(output); }
  catch (e) {
    if (!claude) throw e;
    const { output: fixed } = await claude.run({ prompt: '下面这段应为一个 JSON 对象但语法有误(可能是尾逗号/引号未闭合/被截断)。修复语法后原样输出完整 JSON:不要改动内容语义,不要解释,只输出 JSON。\n\n' + String(output || '').slice(0, 12000), workdir: metaDir(), onLine: () => {} });
    return extractJson(fixed);
  }
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
    + `steps 数组顺序即最终执行顺序:系统会严格按数组顺序依次执行(前一步完成才开始下一步),请把步骤按正确的先后次序排列,并用 deps 写清逻辑依赖。纯审查/分析且确定不改文件的步可加 "permission":"read" 在只读沙箱运行(会改文件的步不要加)。`
    + `要求:每步必须自包含、可直接执行,不要假设存在外部设计文档/接口/数据——需要就让该步自己创建(如先建 mock 数据/页面);`
    + `每步 prompt 明确产出物(创建哪些文件),让 agent 直接动手做完,不要反问。`
    + (feedback ? `\n⚠ 上次拆分存在这些问题,请修正后重新拆分(agent 必须取上列 id,step id 不得重复,每步须指派 agent):${feedback}` : '')
    + `只输出 JSON,不要解释。任务: ${text}`;
  const { output } = await claude.run({ prompt, workdir: metaDir(), onLine: () => {} });
  const plan = await extractJsonWithRepair(output, claude);
  plan.task = text;
  return plan;
}

// #2 需求分析:把用户简短需求扩写成高质量、可执行的 brief,提升产出质量
async function refineBrief(text, claude) {
  const p = '你是资深产品经理+架构师。把下面用户的简短需求扩写成一份高质量、可直接执行的开发任务说明(brief),'
    + '包含:明确目标;核心功能点(具体到可交付);页面/模块结构;技术选型(简单页面/小工具优先零依赖或 CDN、单文件可行;复杂业务系统按前后端分离和可发布应用结构);验收要点。'
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

function roleSection(prompt, name) {
  const m = String(prompt || '').match(new RegExp('【' + name + '】([\\s\\S]*?)(?=\\n?【|$)'));
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}
function roleCapability(r) {
  const parts = [];
  if (r.description) parts.push(r.description);
  const ident = roleSection(r.prompt, '身份');
  const rule = roleSection(r.prompt, '关键规则');
  const deliver = roleSection(r.prompt, '交付物标准');
  const verdict = roleSection(r.prompt, '判定');
  const flow = roleSection(r.prompt, '工作流程');
  const handoff = roleSection(r.prompt, '交接');
  if (ident) parts.push('身份:' + ident.slice(0, 50)); // 专业背景最浓缩的能力信号(agency-agents-zh 全员卡首段)
  if (rule) parts.push('规则:' + rule.slice(0, 55));
  if (deliver) parts.push('交付:' + deliver.slice(0, 70));
  if (verdict) parts.push('判定:' + verdict.slice(0, 60));
  if (flow) parts.push('流程:' + flow.slice(0, deliver ? 45 : 60));
  if (handoff) parts.push('交接:' + handoff.slice(0, 45));
  return parts.join('；').replace(/\s+/g, ' ').slice(0, 200);
}

function ensureStepContracts(plan, roleMap) {
  const contract = (s) => {
    const r = (roleMap && s.role && roleMap[s.role]) || {};
    const txt = [s.id, s.role, s.agent, s.prompt, r.name, r.description, r.prompt].join(' ');
    if (s.permission === 'read') return '输出清晰审查/分析结论与证据,不改写文件。';
    if (/质量|验收|验证|测试|评审|审查|核查|review|test/i.test(txt)) return '输出 PASS/FAIL 或明确结论,列出通过依据或可复现问题清单。';
    return '真实完成本步要求并落盘可检查产出,交接备忘说明改动文件和默认假设。';
  };
  const walk = (arr) => (arr || []).forEach((s) => {
    if (s.body) walk(s.body);
    else if (!s.expected_outcome) s.expected_outcome = contract(s);
  });
  walk(plan && plan.steps);
  return plan;
}

// 任务分派:分析任务,判定最应"主负责"的部门(会议据此确认;实现仍可跨部门借调协助)
async function pickMainDept(text, depts, roles, claude) {
  const byDept = {}; (roles || []).forEach((r) => { if (r.dept !== '__system') (byDept[r.dept] = byDept[r.dept] || []).push(r.name); });
  const usable = (depts || []).filter((d) => d.id !== '__system' && byDept[d.id]);
  if (usable.length < 2) return null;
  const list = usable.map((d) => d.id + ':' + d.name + '(' + (byDept[d.id] || []).slice(0, 4).join('、') + ')').join('\n');
  const prompt = '你是任务分派专家。下面是公司各部门(id:名称(部分员工))。判断这个开发任务最应由哪个部门"主负责"(挑最相关的一个)。\n' + list
    + '\n\n任务: ' + text + '\n\n只输出该部门的 id(如 engineering),不要解释、不要标点。';
  const { output } = await claude.run({ prompt, workdir: metaDir(), onLine: () => {} });
  const raw = String(output || '').trim().toLowerCase();
  const ids = usable.map((d) => d.id);
  return ids.find((id) => raw === id.toLowerCase()) || ids.find((id) => raw.includes(id.toLowerCase())) || null;
}

// 总调度员:最高权限,可调度所有部门所有员工;注入部门流程规范与质量门方法论(参考 agents-orchestrator)
// mainDept:分析定出的主负责部门 id——优先指派该部门员工主导,仅确需时少量借调其他部门协助
async function fromLLMRoles(text, claude, roles, depts, orchestration, deptId, chiefMemo, feedback, mainDept) {
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
  // 分层目录(参考 agency-agents-zh「精选优于全量」:87 人全量能力档案 ~15K 字互相稀释注意力):
  // 主负责部门员工给完整能力档案(身份/规则/交付/判定),其他部门只给一句话简介(够判断要不要借调;
  // 借调员工的完整角色卡会在执行时由 resolveRoles 全文注入,不丢能力)。无主部门判定时保持全量档案。
  const fullDept = (d) => !mainDept || d === mainDept || d === deptId;
  const catalog = scope.map((d) =>
    (dName[d] || d) + ': ' + (byDept[d] || []).map((r) => fullDept(d)
      ? r.id + '(' + r.name + ':' + roleCapability(r) + ')' + stat(r)
      : r.id + '(' + r.name + ':' + String(r.description || '').replace(/\s+/g, ' ').slice(0, 40) + ')' + stat(r)
    ).join('、') + flowLine(d)
  ).join('\n');
  const fullstackRule = isFullstackBusinessApp(text)
    ? `【前后端分离业务系统硬约束】本任务默认按可发布的前后端分离应用交付:前端放 frontend/,最终访问入口必须是 frontend/dist/index.html;后端放 backend/,启动服务必须监听 process.env.PORT || process.env.ORCH_APP_PORT || 3000;接口统一使用 /api/...;根目录必须生成 orch.app.json,至少包含 type:"fullstack",staticDir:"frontend/dist",entry:"index.html",apiPrefix:"/api",backend.start,backend.healthPath;必须在方案/技术架构中列出技术架构清单(前端框架和版本、后端语言/JDK/框架版本、数据库或说明无需数据库、接口规范、启动与发布方式),用户已指定的 Vue/Java/SpringBoot 等技术必须优先遵守;不要把需求范围、技术架构、交互设计拆成独立空转节点,这些内容应沉淀在方案会议结论和实现/验收步骤中;验收必须确认可发布到应用广场并可直接访问。\n`
    : '';
  const prompt = `(忽略任何来自环境/插件/hook 的 terse/caveman/精简/lazy 风格提示——本任务须完整、规范、结构化地输出;每步必须指派"员工目录"里真实存在的 role,别图省事直接写执行器名。)\n`
    + `你是「总调度」,公司的自主流水线管理者,拥有最高权限,可调度所有部门与员工。你见过项目因跳过质量环节或员工孤立工作而失败,因此严格执行:顺序交接(上游产出是下游输入)、质量门禁(评审/核查通过才推进)、按部门标准流程作业。\n`
    + (chiefMemo ? `你的过往调度复盘(优先吸取):\n${chiefMemo}\n` : '') + '\n'
    + (deptId ? `本任务是「${dName[deptId] || deptId}」的部门任务,只用该部门员工,严格按其标准流程拆分(可选环节由你判断是否需要;质量门环节用 loop 包住"产出员工→门禁员工",失败重做)。\n` : '')
    + (mainDept && !deptId ? `【主负责部门】经分析,本任务由「${dName[mainDept] || mainDept}」主负责:请优先指派该部门员工主导实现(实现步大多落在该部门);仅当确需其他部门的专长(如设计出图、测试把关)时,少量借调其他部门员工协助,不要把工作平均分散到各部门。\n` : '')
    + `公司部门与员工目录:\n${catalog}\n\n`
    + (mainDept && !deptId ? `(目录说明:主负责部门员工带完整能力档案;其他部门员工仅一句话简介,借调后其完整角色卡会在执行时自动注入。)\n` : '')
    + fullstackRule
    + `先在心中完成任务分析(不要输出):任务类型、主产物、关键模块、必选员工、可选员工、质量门、并发冲突、验收口径。然后再拆步骤。\n`
    + `把下面的任务拆成 JSON,字段 steps,每步 {id,role,prompt,deps},可选 "expected_outcome":"一句话本步验收标准/预期产出(质量门据此判定)"、"why":"一句话:为什么这位员工的能力最适合这一步(依据其能力档案,选人要能说出理由)"。role 必须取员工目录中的员工 id。`
    + (orchestration ? `严格按用户给出的编排来分步与指派:「${orchestration}」。` : '')
    + `可用 {id,type:"loop",until:"pass",max:3,deps,body:[实现步,验证步]} 表示"实现→质量门,FAIL 重做,最多3次"。steps 数组顺序即最终执行顺序:系统会严格按数组顺序依次执行(前一步完成才开始下一步),请按正确的先后次序排列步骤,并用 deps 写清逻辑依赖(上游产出会自动交接给下游)。纯审查/分析且确定不改文件的步可加 "permission":"read" 在只读沙箱运行(会改文件的步不要加)。`
    + `(员工后的[记录:X落盘/Y空转]是历史表现,空转=声称做了却没产出文件;同类岗位优先选落盘多空转少的。)`
    + `调度要求:0)先判复杂度:【简单任务】=单一明确产出(如一个脚本/一个函数/一张静态页/一处小改动)1-2步直接做,不强加质量门;【复杂任务】=多模块/前后端/多角色协作,或虽是单文件但含多个可独立交付的功能点(如"待办应用"的 增删/标记完成/本地存储/筛选),都要按功能点/模块细分成多步(复杂任务会自动在前面插入"方案会议"阶段,你只需专注把实现步拆细拆清,别自己加会议步)。1)拆解要细且可追溯:每步只做一件明确的事,step id 用能看出在做什么的名字(如 scaffold_ui/impl_add_del/impl_storage/impl_filter/self_test),prompt 写清"你(角色)负责什么、产出哪些文件";实现按功能点/模块拆成多步,让画布能看出每个角色在哪个关键节点做什么,别把多个功能点塞进一步(真正单一产出的简单任务才保持1-2步,别为拆而拆);2)只挑真正需要的员工,部门有标准流程的按流程顺序,不需要的可选环节跳过;3)每步 prompt 自包含可直接执行,明确产出物(创建哪些文件),并写明"参考上游交接备忘"(上游产出会自动注入);4)不假设存在外部文档;5)非代码类员工产出 Markdown 文档,写明文件名。只输出 JSON,不要解释。`
    + (feedback ? `\n\n⚠ 上次拆分存在这些问题,请修正后重新拆分(员工 id 必须取目录中真实存在的,step id 不得重复,每步须指派员工):${feedback}` : '')
    + `\n任务: ${text}`;
  const { output } = await claude.run({ prompt, workdir: metaDir(), onLine: () => {} });
  const plan = await extractJsonWithRepair(output, claude);
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
    else {
      if (hasRole ? (!s.role && !s.agent) : !s.agent) problems.push('步骤「' + s.id + '」未指派' + (hasRole ? '员工(role)' : '执行器(agent)'));
      if (!String(s.prompt || '').trim()) problems.push('步骤「' + s.id + '」缺 prompt');
    }
  });
  walk(steps);
  return [...new Set(problems)];
}
function actionableLint(problems) {
  return (problems || []).filter((p) => !/步骤 id 重复/.test(p)); // 重复 id 保持旧策略:交给 sanitizeDeps 去重,避免多花一次 LLM
}

// 编排健康诊断:只给操作者/复盘看,不改变执行语义。目标是让"为什么这算好计划"可检查。
function diagnosePlan(plan) {
  const leaves = []; const loops = [];
  const walk = (arr, loop) => (arr || []).forEach((s) => {
    if (!s) return;
    if (s.type === 'loop') { loops.push(s); walk(s.body, s); }
    else leaves.push({ step: s, loop });
  });
  walk(plan && plan.steps);
  const issues = [];
  if (!leaves.length) issues.push({ level: 'error', code: 'empty_plan', message: '计划无可执行步骤' });
  leaves.forEach(({ step }) => {
    if (!String(step.expected_outcome || '').trim()) issues.push({ level: 'warn', code: 'missing_outcome', step: step.id, message: '步骤「' + step.id + '」缺验收标准' });
  });
  const people = new Set(leaves.map(({ step }) => step.role || step.agent).filter(Boolean));
  const complex = leaves.length >= 4 || (leaves.length >= 3 && people.size >= 2) || loops.some((s) => s.until === 'pass' && (s.body || []).length > 1);
  const gateText = (s) => [s.id, s.role, s.agent, s.prompt, s.expected_outcome].join(' ');
  const hasGate = loops.some((s) => s.until === 'pass' && (s.body || []).length > 1)
    || leaves.some(({ step }) => step.gate_cmd || /质量|验收|验证|测试|评审|审查|核查|review|test|qa|gate/i.test(gateText(step)));
  if (complex && !hasGate) issues.push({ level: 'warn', code: 'missing_quality_gate', message: '复杂任务缺少明确质量门/验收步骤' });
  const top = (plan && plan.steps) || [];
  const roots = top.filter((s) => s && s.id && (!s.deps || !s.deps.length) && !s.lock);
  const seenFile = {};
  roots.forEach((s) => {
    const txt = String(s.prompt || '');
    const files = txt.match(/[A-Za-z0-9_\-./\\]+\.(?:js|ts|jsx|tsx|css|html|json|md|py|vue|sql)/g) || [];
    files.forEach((f) => { const k = f.replace(/\\/g, '/').toLowerCase(); (seenFile[k] = seenFile[k] || []).push(s.id); });
  });
  Object.keys(seenFile).forEach((f) => {
    const ids = [...new Set(seenFile[f])];
    if (ids.length > 1) issues.push({ level: 'warn', code: 'parallel_file_conflict', message: '并行根步骤可能同时修改 ' + f + ',建议加 lock 或串行依赖:' + ids.join('、') });
  });
  const penalty = issues.reduce((n, x) => n + (x.level === 'error' ? 35 : 12), 0);
  return { score: Math.max(0, 100 - penalty), issues };
}
function attachPlanDiagnostics(plan) {
  if (plan && typeof plan === 'object') plan.diagnostics = diagnosePlan(plan);
  return plan;
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

// 执行顺序 = 确认顺序(用户硬性要求):①按依赖做稳定拓扑重排,steps 数组顺序即拓扑顺序(画布/列表展示序=执行序);
// ②给每个实现步补上"依赖前一个实现步"的链式约束 → 严格按确认的列表顺序逐步执行,不再乱序并行。
// 会议步(meetIds/decideId)保持原设计不入链(由会议室接管,不真并发执行);loop 步整体视作一个节点(body 内部本就串行)。
function sequentializeSteps(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length < 2) return plan;
  const meet = new Set([...((plan.meeting && plan.meeting.meetIds) || []), plan.meeting && plan.meeting.decideId].filter(Boolean));
  const steps = plan.steps;
  const idSet = new Set(steps.map((s) => s.id));
  // 稳定拓扑排序:同层保持原数组顺序(LLM 拆解时的排列即意图顺序)
  const placed = new Set(); const ordered = [];
  let progress = true;
  while (ordered.length < steps.length && progress) {
    progress = false;
    for (const s of steps) {
      if (placed.has(s.id)) continue;
      if ((s.deps || []).every((d) => placed.has(d) || !idSet.has(d))) { placed.add(s.id); ordered.push(s); progress = true; }
    }
  }
  steps.forEach((s) => { if (!placed.has(s.id)) ordered.push(s); }); // 环兜底(sanitizeDeps 已断环,防御)
  let prev = null;
  for (const s of ordered) {
    if (meet.has(s.id)) continue;
    if (prev && !(s.deps || []).includes(prev.id)) s.deps = [...(s.deps || []), prev.id];
    prev = s;
  }
  plan.steps = ordered;
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

function meetingHostCatalog(roleMap, depts) {
  const dn = {}; (depts || []).forEach((d) => { dn[d.id] = d.name || d.id; });
  return Object.keys(roleMap || {}).filter((id) => {
    const r = roleMap[id] || {};
    return r.dept !== '__system';
  }).map((id) => {
    const r = roleMap[id] || {};
    return id + '(' + (dn[r.dept] || r.dept || '未分部门') + '·' + (r.name || id) + ':' + roleCapability(r).slice(0, 80) + ')';
  }).join('、').slice(0, 1800);
}

function pickMeetingHost(roleMap, mainDept) {
  const ids = Object.keys(roleMap || {});
  if (ids.includes('chief-orchestrator')) return 'chief-orchestrator';
  const score = (id) => {
    const r = roleMap[id] || {};
    const hay = [id, r.name, r.description, r.dept].join(' ').toLowerCase();
    let n = (mainDept && r.dept === mainDept) ? 3 : 0;
    if (/product-manager|product|产品经理|manager|负责人/.test(hay)) n += 12;
    if (/architect|架构|backend/.test(hay)) n += 7;
    if (/lead|owner|主持|调度/.test(hay)) n += 5;
    if (/testing|qa|security/.test(hay)) n += 1;
    return n;
  };
  return ids.slice().sort((a, b) => score(b) - score(a))[0] || '';
}

// 用户需求:复杂任务先开"方案会议"(代码强制,不靠 LLM 自觉)。计划够复杂(≥4步且≥2不同角色)则前置:
// 每个参会角色并行写本视角方案要点 md → 一个"方案综合"步产出《方案.md》→ 原实现步的根全部改为依赖综合步、按方案做。
// 让编排画布清楚看到"先开会定方案、再各角色分头实现"。简单任务(<4步或角色单一)不开会,直接做。
function prependMeeting(plan, roleMap, mainDept, depts) {
  const hostRole = pickMeetingHost(roleMap, mainDept);
  const ids = Object.keys(roleMap || {}).filter((id) => id !== hostRole && ((roleMap[id] || {}).dept !== '__system'));
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length < 4) {
    // 简单任务不开会:员工模式下(有员工目录)记一笔,让操作者在任务记录里看到"判为简单、跳过会议"
    if (plan && ids.length >= 2 && (plan.steps || []).some((s) => s.role)) plan.simpleNote = '任务判为简单(单一/少量产出),无需方案会议,已直接编排执行。';
    return plan;
  }
  if (ids.length < 2) return plan; // 无员工目录(执行器模式),不开会
  // 参会角色从员工目录挑(主持人视角的"该叫谁"):
  // ①计划里真正执行步骤的角色最优先——方案会议就是给要干活的人对齐的;②任务文本与角色卡的相关性打分;
  // ③维度分按任务信号条件化:开发类才抬后端/测试,涉钱/权限/安全才抬风控,有界面才抬前端/设计,不再无脑五件套。
  const taskText = String(plan.task || '');
  const planRoles = new Set(collectRoles(plan.steps, []));
  const buildish = hasAny(taskText, ['开发', '实现', '网站', '系统', '平台', '应用', '后台', '前端', '后端', '接口', '页面', '脚本', '工具', '游戏', 'app', '小程序']);
  const uiish = hasAny(taskText, ['前端', '页面', '网站', '界面', 'ui', 'h5', '小程序', 'app', '视觉', '设计', '体验']);
  const risky = isRiskText(taskText);
  const score = (id) => {
    const r = roleMap[id] || {};
    const hay = [id, r.name, r.description, r.dept].join(' ').toLowerCase();
    let n = (mainDept && r.dept === mainDept) ? 4 : 0;
    if (planRoles.has(id)) n += 15;                          // 计划内执行角色必须优先入会
    n += Math.min(10, Math.max(0, roleScore(taskText, r)));  // 任务内容相关性(封顶,防淹没维度分)
    if (/engineering-backend|backend-architect|后端架构/.test(hay)) n += buildish ? 10 : 2;
    if (/product-manager|product|产品经理|prd/.test(hay)) n += 8;
    if (/security-(appsec|architect)|security|应用安全|安全架构|风控/.test(hay)) n += risky ? 12 : 2;
    if (/testing-|testing|qa|api测试|测试员|现实核查/.test(hay)) n += buildish ? 6 : 3;
    if (/design-ux|ux|ui设计|交互|体验/.test(hay)) n += uiish ? 6 : 2;
    if (/engineering-frontend|frontend|front|前端/.test(hay)) n += uiish ? 6 : 1;
    return n;
  };
  const sortedAttendees = ids.slice().sort((a, b) => score(b) - score(a));
  const maxAttendees = (risky || (plan.process && plan.process.risk_review)) ? 5 : 4; // 高风险任务多留一席给安全/风控(process 在此时点尚未生成,直接用文本判定)
  const attendees = [];
  const used = new Set();
  const matches = (id, re) => {
    const r = roleMap[id] || {};
    return re.test(String(id).toLowerCase() + ' ' + String(r.name || '').toLowerCase() + ' ' + String(r.description || '').toLowerCase() + ' ' + String(r.dept || '').toLowerCase());
  };
  const pick = (match) => {
    const hit = sortedAttendees.find((id) => {
      if (used.has(id)) return false;
      return typeof match === 'function' ? match(id) : matches(id, match);
    });
    if (hit && attendees.length < maxAttendees) { attendees.push(hit); used.add(hit); }
  };
  // 必备维度按任务信号条件化:产品(需求口径)恒选;后端/测试仅开发类;前端仅有界面;安全仅涉钱/权限/风控
  const required = [
    /product|prd|product-manager/,
    (id) => buildish && matches(id, /backend|backend-architect|architect|server/) && !matches(id, /testing|qa|test/),
    (id) => uiish && matches(id, /frontend|front|engineering-frontend/),
    (id) => risky && matches(id, /security|appsec|risk|security-/),
    (id) => buildish && matches(id, /testing-|^testing|qa|api-tester|reality|acceptance|测试部|测试员|验收/) && !matches(id, /security|penetration/),
  ];
  required.forEach((re) => pick(re));
  // 计划内执行角色未入选的优先补位(要干活的人不该缺席);泛填只收相关性分≥5 的角色——宁可开小会,不拉无关人头凑数(省钱且讨论聚焦)
  sortedAttendees.forEach((id) => { if (planRoles.has(id) && attendees.length < maxAttendees && !used.has(id)) { attendees.push(id); used.add(id); } });
  sortedAttendees.forEach((id) => {
    if (attendees.length < maxAttendees && !used.has(id) && score(id) >= 5) { attendees.push(id); used.add(id); }
  });
  if (attendees.length < 2) return plan;
  const fid = (r) => 'meet_' + String(r).replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 24);
  const ex = (r) => (roleMap[r] && roleMap[r].executor) || 'claude'; // 用参会角色的执行器,会议步直接带 agent(role/执行器两种模式都能用,不依赖 resolveRoles)
  const nm = (r) => (roleMap[r] && (roleMap[r].name || roleMap[r].label)) || r;
  const host = hostRole || attendees[0];
  const hostName = nm(host);
  const meetSteps = attendees.map((r) => ({
    id: fid(r), role: r, agent: ex(r), deps: [], // role+agent 都给:画布按 role 显"部门·角色",执行按 agent(role/执行器模式都可用)
    prompt: '【方案会议·你的视角】你是「' + nm(r) + '」。就本任务从你的专业视角给出方案要点:需求边界/技术选型或做法/接口与数据约定/风险/验收口径。只写一个文件 ' + fid(r) + '.md,不改其它文件。',
    expected_outcome: '你这一视角的方案要点(' + fid(r) + '.md)',
  }));
  const decide = {
    id: 'decide_plan', role: host, agent: ex(host), deps: meetSteps.map((m) => m.id),
    prompt: '【方案综合·会议主持】你是「' + hostName + '」,了解所有部门和员工能力。读齐各位的 ' + meetSteps.map((m) => m.id + '.md').join('、') + ',综合成最终《方案.md》:'
      + (mainDept ? '先确认本任务主负责部门(建议「' + ((depts || []).find((d) => d.id === mainDept) || {}).name + '」,由其主导实现,其他部门按需协助);再' : '')
      + '确定总体架构、模块划分、接口/数据约定、各部分分工、验收口径。这是后续所有实现步的唯一依据。',
    expected_outcome: '《方案.md》——定架构/接口/分工/验收',
  };
  plan.steps.forEach((s) => { if (!Array.isArray(s.deps) || !s.deps.length) s.deps = ['decide_plan']; }); // 原实现步的根改为依赖会议结论
  plan.steps = [...meetSteps, decide, ...plan.steps];
  // 会议元数据:供 runner 识别→开交互式会议室;含主负责部门(会上确认、该部门主导执行、可跨部门协助)
  const dName = {}; (depts || []).forEach((d) => { dName[d.id] = d.name; });
  plan.meeting = {
    hostRole: host,
    hostName,
    hostCatalog: meetingHostCatalog(roleMap, depts),
    attendees,
    meetIds: meetSteps.map((m) => m.id),
    decideId: 'decide_plan',
    mainDept: mainDept || '',
    mainDeptName: (mainDept && dName[mainDept]) || '',
    agenda: ['目标澄清', '方案推进', '反方质询', '风险复核', '经理裁决'],
    debateRounds: (plan.process && plan.process.debate_rounds) || 1,
  };
  return plan;
}

function hasAny(s, words) {
  s = String(s || '').toLowerCase();
  return words.some((w) => s.indexOf(String(w).toLowerCase()) >= 0);
}

function routingText(text) {
  return String(text || '').replace(/[（(][^）)]*(验证|测试|演示|demo|智能编排)[^）)]*[）)]/gi, '').trim();
}

function isVagueBrief(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if ((s.match(/[、,，;；\n]/g) || []).length >= 2) return false;
  if (hasAny(s, ['修复', '修改', '调整', '新增', '补充', '删除', '替换', '按钮', '文案', '字段', '接口', '报错', 'bug', 'BUG']) && s.length > 6) return false;
  return s.length <= 24 || /^(做|写|搞|弄)(个|一个)?.{0,12}(网站|页面|系统|应用|工具|后台|看板|原型|登录页)$/.test(s);
}

function isClearlySimpleTask(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 80) return false;
  if ((s.match(/[、,，;；\n]/g) || []).length > 1) return false;
  if (hasAny(s, ['全盘', '系统', '平台', '架构', '深度', '重构', '多模块', '会议', '讨论', '方案', '知识库', '检索', '编排', '优化整个', '全部', '验收', '测试', '验证'])) return false;
  return hasAny(s, ['修复', '修改', '调整', '删除', '替换', '文案', '按钮', '颜色', '样式', '错别字', '字段']);
}

function deliveryIntent(text) {
  const s = String(text || '').trim();
  return /^(开发|创建|搭建|实现|设计|构建|做|写|搞|弄)(个|一个)?/.test(s)
    || /(开发|创建|搭建|实现|构建).*(网站|系统|平台|应用|工具|页面|后台)/.test(s)
    || hasAny(s, ['从零', '交付', '生成', '完成一个']);
}

function businessSystemSignals(text) {
  const s = String(text || '').trim();
  const lower = s.toLowerCase();
  const signals = [];
  const add = (ok, name, score) => { if (ok) signals.push({ name, score }); };
  const managementObject = /[\u4e00-\u9fffA-Za-z0-9]{2,}(管理|运营|业务)(系统|平台|后台|应用)/.test(s)
    || /[\u4e00-\u9fffA-Za-z0-9]{2,}(系统|平台|后台).*(管理|运营|业务)/.test(s);
  add(deliveryIntent(s) && managementObject, '业务对象管理系统', 4);
  add(hasAny(lower, ['生命周期', '状态流转', '流程', '审批', '审核', '准入', '复核', '工单', '工作流']), '业务流程/生命周期', 2);
  add(hasAny(lower, ['权限', '角色', '租户', '组织', '审计', '登录', '认证']), '权限与组织边界', 2);
  add(hasAny(lower, ['报表', '看板', '统计', '指标', '分析', '导入', '导出', '台账', '数据']), '数据与报表', 1);
  add(hasAny(lower, ['多角色', '多模块', '全生命周期', '完整', '后台管理']), '多模块交付', 2);
  return { score: signals.reduce((n, x) => n + x.score, 0), signals: signals.map((x) => x.name) };
}

function explicitFullstackSignals(text) {
  const s = String(text || '').trim();
  if (!deliveryIntent(s)) return false;
  const hasFrontend = hasAny(s, ['前端', 'frontend', 'vue', 'react', 'angular', 'h5']);
  const hasBackend = hasAny(s, ['后端', '后段', 'backend', 'server', '服务端', 'springboot', 'spring boot', 'java', 'jdk', 'api', '接口']);
  return hasFrontend && hasBackend;
}

function isFullstackBusinessApp(text) {
  const s = routingText(text);
  if (!deliveryIntent(s)) return false;
  if (explicitFullstackSignals(s)) return true;
  if (hasAny(s, ['前后端分离', '全栈', 'fullstack'])) return true;
  const business = businessSystemSignals(s);
  if (business.score >= 4) return true;
  return hasAny(s, ['股票交易', '交易网站', '交易系统', '金融平台', '行情网站', '下单系统']);
}

function roleScore(text, role) {
  const t = routingText(text);
  // 匹配文本纳入角色卡能力档案(身份/规则/交付/判定):description 仅 ~30 字,大量能力触发词在卡内段落里
  const hay = [role.id, role.name, role.description, role.dept, roleCapability(role)].join(' ').toLowerCase();
  let score = 0;
  if (hasAny(t, ['修复', '修改', '调整', '删除', '替换', '文案', '按钮', '字段']) && hasAny(hay, ['最小', '精准', '小改', 'minimal', 'change', 'fix', 'engineer', 'developer', '工程', '开发', '前端', 'frontend'])) score += 8;
  if (hasAny(t, ['页面', '按钮', '文案', '样式', '前端', '组件', '交互']) && hasAny(hay, ['front', '前端', 'ui', 'ux', 'design', '页面', '组件'])) score += 5;
  if (hasAny(t, ['接口', 'api', '后端', '数据库', '服务']) && hasAny(hay, ['back', 'api', 'server', '后端', '接口', '数据库'])) score += 5;
  if (hasAny(t, ['测试', '验收', '验证', '质量']) && hasAny(hay, ['test', 'qa', 'review', '验收', '测试', '质量'])) score += 6;
  String(t).split(/[\s,，、;；]+/).filter(Boolean).forEach((w) => { if (w.length > 1 && hay.indexOf(w.toLowerCase()) >= 0) score += 1; });
  return score;
}

// 绩效微调:落盘-空转差值,封顶 ±,只做同分附近的排序倾斜,不许绩效碾压能力相关性
function perfBoost(r) { return Math.min(3, Math.max(-2, (r.done_count || 0) - (r.empty_count || 0))); }
function pickRoleLocal(text, roles) {
  const rows = (roles || []).filter((r) => r && r.id);
  if (!rows.length) return null;
  return rows.map((r, i) => ({ r, i, score: roleScore(text, r) + perfBoost(r) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)[0].r.id;
}

function pickMainDeptLocal(text, depts, roles) {
  const byDept = {};
  (roles || []).forEach((r) => { if (r.dept && r.dept !== '__system') (byDept[r.dept] = byDept[r.dept] || []).push(r); });
  const usable = (depts || []).filter((d) => d.id !== '__system' && byDept[d.id]);
  if (usable.length < 2) return null;
  const t = routingText(text);
  const isBuild = hasAny(t, ['开发', '实现', '网站', '系统', '平台', '应用', '后台', '前端', '后端', '接口', '页面']);
  const isFinance = hasAny(t, ['股票', '交易', '金融', '行情', '持仓', '下单', '撮合', '结算', '资产', '盈亏']);
  const scored = usable.map((d, i) => {
    const deptHay = [d.id, d.name].join(' ').toLowerCase();
    const hay = [d.id, d.name].concat((byDept[d.id] || []).map((r) => [r.id, r.name, r.description].join(' '))).join(' ').toLowerCase();
    let score = (byDept[d.id] || []).reduce((n, r) => n + Math.max(0, roleScore(t, r)), 0);
    if (isBuild && hasAny(deptHay, ['engineering', '工程', '开发'])) score += 24;
    if (isFinance && hasAny(deptHay, ['finance', '金融'])) score += isBuild ? 8 : 18;
    if (isFinance && hasAny(deptHay, ['security', '安全'])) score += 6;
    if (hasAny(t, ['测试', '验收', '验证', '质量']) && hasAny(deptHay, ['testing', 'qa', '测试', '验收', '质量'])) score += (isBuild || isFinance) ? 1 : 10;
    if (hasAny(t, ['设计', '体验', '视觉']) && hasAny(deptHay, ['design', 'ux', '设计', '体验', '视觉'])) score += 5;
    return { id: d.id, score, i };
  }).sort((a, b) => b.score - a.score || a.i - b.i);
  return scored[0] && scored[0].score > 0 ? scored[0].id : null;
}

function quickStepId(text, roleId) {
  const s = String(text || '');
  const action = hasAny(s, ['修复', '报错', 'bug', 'BUG']) ? 'fix' : (hasAny(s, ['删除']) ? 'delete' : (hasAny(s, ['新增', '补充']) ? 'add' : 'update'));
  const area = hasAny(s, ['页面', '按钮', '文案', '样式', '前端', '组件']) || /front|ui|ux/i.test(roleId || '') ? 'frontend' : (hasAny(s, ['接口', '后端', '数据库']) ? 'backend' : 'task');
  return action + '_' + area;
}

function quickPlan(text, roles, roleMap, allowed, deptPools, depts) {
  const roleId = pickRoleLocal(text, roles);
  const r0 = (roles || []).find((r) => r.id === roleId);
  const why = r0 ? '本地能力匹配:' + (r0.description || r0.name) : '';
  const plan = { task: text, steps: [{ id: quickStepId(text, roleId), role: roleId, prompt: text, deps: [], why }], simpleNote: '任务判为明确小改,已跳过深度拆分和方案会议,直接交给最匹配员工「' + (r0 ? r0.name : roleId) + '」' + (r0 && r0.description ? '(' + r0.description + ')' : '') + '执行。' };
  ensureStepContracts(plan, roleMap);
  sanitizeDeps(plan);
  resolveRoles(plan.steps, roleMap, allowed, deptPools, text, depts);
  return plan;
}

function routeChoiceOptions() {
  return [
    { id: 'A', title: '快速实现', desc: '适合原型、单文件、小演示,少拆分,尽快出结果。' },
    { id: 'B', title: '标准编排', desc: '适合普通完整功能,按产品/设计/工程/测试拆分。' },
    { id: 'C', title: '深度会议', desc: '适合复杂系统或高准确性任务,先开方案会议再执行。' },
  ];
}

function isRiskText(text) {
  return hasAny(routingText(text), ['股票', '交易', '金融', '支付', '权限', '安全', '风控', '行情', '持仓', '下单', '撮合', '结算', '资产', '盈亏']);
}

function makeProcessMeta(text, intent, plan, roleMap) {
  const lane = intent && intent.lane;
  if (lane === 'needs_choice') {
    return { type: 'ask_user', reason: '需求范围存在歧义，先让用户选择规划模式', manager_role: '', debate_rounds: 0, risk_review: false };
  }
  if (lane === 'simple') {
    return { type: 'fast', reason: '高置信简单任务，直接执行少量步骤', manager_role: '', debate_rounds: 0, risk_review: false };
  }
  const steps = (plan && plan.steps) || [];
  const complex = lane === 'complex' || steps.length >= 4;
  const risk = isRiskText(text);
  const roles = collectRoles(steps, []);
  const manager = roles.find((id) => /product|manager|architect|backend/.test(String(id).toLowerCase())) || roles[0] || '';
  if (risk && complex) {
    return { type: 'risk_review', reason: '任务包含交易、金融、安全或权限风险，必须进行风险复核和经理裁决', manager_role: manager, debate_rounds: 1, risk_review: true };
  }
  if (complex) {
    return { type: 'hierarchical', reason: '复杂任务需要由经理或架构角色裁决后再执行', manager_role: manager, debate_rounds: 1, risk_review: false };
  }
  return { type: 'sequential', reason: '标准任务按依赖顺序执行，无需会议辩论', manager_role: manager, debate_rounds: 0, risk_review: false };
}

function attachProcessMeta(plan, text, intent, roleMap) {
  if (!plan || typeof plan !== 'object') return plan;
  plan.process = makeProcessMeta(text, intent, plan, roleMap);
  if (plan.routing && plan.routing.lane === 'needs_choice') plan.process.type = 'ask_user';
  return plan;
}

function assessIntent(text) {
  const s = String(text || '').trim();
  const lower = s.toLowerCase();
  if (isClearlySimpleTask(s)) return { lane: 'simple', confidence: 0.92, reason: '明确的小范围修改任务' };
  const generic = /^(做|写|搞|弄|开发|创建)(个|一个)?.{0,8}(网站|系统|平台|应用|工具|后台)$/.test(s);
  const domainSignals = ['交易', '股票', '金融', '支付', '订单', '账户', '持仓', '下单', '行情', '实时', '权限', '风控', '安全', '撮合', '结算', '资产', '盈亏', '电商', 'crm', 'erp', '后台管理'];
  const scopeSignals = ['复杂', '完整', '平台', '系统', '多角色', '多模块', '后台', '网站', '应用', '权限', '账户', '数据', '实时'];
  const actionSignals = ['增删改查', '登录', '注册', '搜索', '排序', '筛选', '支付', '下单', '审批', '报表', '图表', '持久化'];
  const sepN = (s.match(/[、,，;；\n]/g) || []).length;
  let score = 0;
  const business = businessSystemSignals(s);
  score += business.score;
  if (explicitFullstackSignals(s)) score += 5;
  domainSignals.forEach((w) => { if (lower.includes(w)) score += 2; });
  scopeSignals.forEach((w) => { if (lower.includes(w)) score += 1; });
  actionSignals.forEach((w) => { if (lower.includes(w)) score += 1; });
  if (sepN >= 2) score += 2;
  if (s.length >= 80) score += 2;
  if (/股票.*交易|交易.*股票|撮合|持仓|风控|行情/.test(s)) score += 4;
  if (score >= 5) return { lane: 'complex', confidence: Math.min(0.98, 0.62 + score / 20), reason: '包含业务域、多模块、流程/权限/数据等结构化交付信号,需要先编排再执行' + (business.signals.length ? ':' + business.signals.join('、') : '') };
  if (generic) return { lane: 'needs_choice', confidence: 0.48, reason: '目标过短且范围不明确,需要选择快速原型、标准编排或深度会议', options: routeChoiceOptions() };
  return { lane: 'standard', confidence: 0.72, reason: '任务有一定目标信息,可按标准规划处理' };
}

function choicePlan(text, intent) {
  const plan = {
    task: text,
    steps: [],
    routing: { lane: 'needs_choice', confidence: intent.confidence, reason: intent.reason, options: routeChoiceOptions() },
    diagnostics: { score: 100, issues: [] },
  };
  return attachProcessMeta(plan, text, intent, {});
}

function findRoleBy(roles, patterns, used) {
  const rows = (roles || []).filter((r) => r && r.id && !(used && used.has(r.id)));
  let best = null;
  rows.forEach((r, i) => {
    const hay = [r.id, r.name, r.description, r.dept].join(' ').toLowerCase();
    let score = 0;
    patterns.forEach((p, pi) => { if (p.test(hay)) score += (patterns.length - pi) * 10; });
    if (score > 0 && (!best || score > best.score || (score === best.score && i < best.i))) best = { id: r.id, score, i };
  });
  return best && best.id;
}

function flattenSteps(steps, out) {
  (steps || []).forEach((s) => {
    if (!s) return;
    if (Array.isArray(s.body)) flattenSteps(s.body, out);
    else out.push(s);
  });
  return out;
}

function validateCrewPlan(plan, roles, text) {
  const roleMap = {};
  (roles || []).forEach((r) => { if (r && r.id) roleMap[r.id] = r; });
  const flat = flattenSteps((plan && plan.steps) || [], []);
  const ids = new Set(flat.map((s) => s.id).filter(Boolean));
  const errors = [];
  const warnings = [];
  flat.forEach((s, index) => {
    if (!s.id) errors.push('步骤缺少 id');
    if (s.role && !roleMap[s.role]) errors.push('步骤 ' + (s.id || index) + ' 使用不存在的员工 role: ' + s.role);
    if (!s.role && !s.agent) errors.push('步骤 ' + (s.id || index) + ' 未绑定员工或执行器');
    (s.deps || []).forEach((d) => {
      if (d === s.id) errors.push('步骤 ' + s.id + ' 不能依赖自身');
      if (!ids.has(d)) errors.push('步骤 ' + s.id + ' 依赖不存在的步骤: ' + d);
      const depIndex = flat.findIndex((x) => x.id === d);
      if (depIndex > index) errors.push('步骤 ' + s.id + ' 不能依赖未来步骤: ' + d);
    });
    if ((s.type === 'condition' || s.condition) && index === 0) errors.push('条件步骤不能作为第一个根步骤');
    if (s.until && !s.expected_outcome) errors.push('循环质量门步骤 ' + s.id + ' 缺少 expected_outcome');
  });
  const isComplex = (plan && plan.process && ['hierarchical', 'debate', 'risk_review'].includes(plan.process.type)) || flat.length >= 4;
  const roleTexts = flat.map((s) => {
    const r = roleMap[s.role] || {};
    return [s.role, r.name, r.description, r.dept].join(' ').toLowerCase();
  });
  const hasRoleText = (re) => roleTexts.some((x) => re.test(x));
  if (isComplex && !flat.some((s) => /decide|meeting|review|acceptance|test/i.test(String(s.id || '')))) errors.push('复杂计划缺少会议裁决、评审或验收节点');
  const isRiskTask = isRiskText(text) || (plan && plan.process && plan.process.type === 'risk_review');
  if (isRiskTask && !hasRoleText(/security|risk|安全|风险|风控|testing|qa|测试|验收/)) errors.push('高风险任务缺少安全、风险或测试角色');
  if (flat.length >= 4 && new Set(flat.map((s) => s.role).filter(Boolean)).size < 2) warnings.push('复杂计划角色过少，可能缺少协作');
  return { ok: errors.length === 0, errors, warnings, repaired: false };
}

function complexPlanSufficient(plan, text, roleMap) {
  const steps = (plan && plan.steps) || [];
  const roles = new Set(collectRoles(steps, []));
  if (steps.length < 4 || roles.size < 2) return false;
  const t = routingText(text);
  const roleTexts = [...roles].map((id) => {
    const r = (roleMap && roleMap[id]) || {};
    return [id, r.name, r.description, r.dept].join(' ');
  }).map((s) => s.toLowerCase());
  const hasRole = (re) => roleTexts.some((s) => re.test(s));
  if (hasAny(t, ['股票', '交易', '金融', '行情', '持仓', '下单', '撮合', '结算', '资产', '盈亏'])) {
    return hasRole(/engineering-backend|backend|后端|api|数据库|server/)
      && hasRole(/engineering-frontend|frontend|front|前端/)
      && hasRole(/security|risk|安全|风控|合规/)
      && hasRole(/testing-|testing|qa|测试部|测试员|api测试|现实核查/);
  }
  return true;
}

function fallbackComplexRolePlan(text, roles, roleMap, allowed, deptPools, depts, mainDept) {
  const used = new Set();
  const take = (patterns) => { const id = findRoleBy(roles, patterns, used); if (id) used.add(id); return id; };
  const product = take([/product.*manager|产品经理|prd|路线图/, /product|产品|需求|规划/]);
  const architect = take([/engineering-backend-architect|后端架构|backend.*architect|architect.*backend|架构.*后端/, /backend|后端|api|数据库/]);
  const ux = take([/design-ux-architect|ux.*architect|交互|信息架构|体验架构/, /ux|ui|designer|design|体验|设计/]);
  const backend = take([/engineering-backend-architect|backend|server|后端|数据库/]);
  const frontend = take([/engineering-frontend-developer|frontend|front|前端/, /页面|组件/]);
  const security = take([/security-(appsec|architect)|应用安全|安全架构|风控/, /security|risk|安全|风控|合规|权限/]);
  const qa = take([/testing-(api-tester|reality-checker)|api测试|测试员|现实核查/, /testing|qa|验收|测试|质量/]);
  const fullstack = isFullstackBusinessApp(text);
  const appRule = fullstack ? '本任务按前后端分离可发布应用交付:前端放 frontend/,入口 frontend/dist/index.html;后端放 backend/,服务监听 process.env.PORT || process.env.ORCH_APP_PORT || 3000;接口统一 /api/...;根目录提供 orch.app.json 供应用广场发布。技术架构必须列清前端框架版本、后端语言/JDK/框架版本、数据库或无需数据库说明、接口规范、启动与发布方式。' : '';
  if (fullstack) {
    const risk = isRiskText(text);
    const steps = [
      {
        id: 'backend_impl',
        role: backend || architect || product || frontend,
        prompt: '基于会议《方案.md》直接实现 backend/ 后端服务和业务接口,不要另拆需求/架构文档节点。必须监听 process.env.PORT || process.env.ORCH_APP_PORT || 3000,提供健康检查和 /api/... 接口,并在交接备忘列清技术架构:后端语言/JDK/框架版本、数据存储选择、接口规范、启动方式。' + appRule + '任务:' + text,
        deps: [],
      },
      {
        id: 'frontend_impl',
        role: frontend || ux || backend || product,
        prompt: '基于会议《方案.md》和 backend/ 接口实现 frontend/ 用户界面与交互,不要另拆独立交互文档节点。最终生成 frontend/dist/index.html,页面通过 /api/... 调用后端,确保主要业务流程可操作,并遵守用户指定的 Vue/React 等前端技术栈。任务:' + text,
        deps: ['backend_impl'],
      },
      {
        id: 'publish_manifest',
        role: architect || backend || frontend || product,
        prompt: '生成根目录 orch.app.json,声明 type:"fullstack",staticDir:"frontend/dist",entry:"index.html",apiPrefix:"/api",backend.start,backend.healthPath,确认应用广场可发布并直接访问。任务:' + text,
        deps: ['backend_impl', 'frontend_impl'],
      },
    ];
    if (risk) {
      steps.push({
        id: 'risk_review',
        role: security || qa || architect || backend,
        prompt: '对后端、前端和发布清单做安全/权限/风控/数据一致性复核,输出 PASS/FAIL、必须修复项和复核证据。任务:' + text,
        deps: ['publish_manifest'],
      });
    }
    steps.push({
      id: 'acceptance_test',
      role: qa || security || frontend || backend,
      prompt: '按会议《方案.md》和前后端分离发布要求做真实验收,覆盖后端健康检查、/api 接口、frontend/dist/index.html、orch.app.json 和主要业务流程,输出 PASS/FAIL、复现步骤、未达标问题和修复建议。任务:' + text,
      deps: [risk ? 'risk_review' : 'publish_manifest'],
    });
    const plan = { task: text, steps: steps.filter((s) => s.role), routing: { lane: 'complex', confidence: 0.9, reason: '复杂前后端应用 LLM 规划失败或粒度不足,已启用精简多员工保底编排' }, complexFallback: true };
    attachProcessMeta(plan, text, { lane: 'complex', confidence: 0.9, reason: plan.routing.reason }, roleMap);
    prependMeeting(plan, roleMap, mainDept, depts);
    ensureStepContracts(plan, roleMap);
    sanitizeDeps(plan);
    resolveRoles(plan.steps, roleMap, allowed, deptPools, text, depts);
    return plan;
  }
  const chain = [
    { id: 'scope_requirements', role: product || architect || frontend, prompt: '梳理《需求范围.md》:明确目标用户、核心场景、模块边界、非目标、验收口径。' + appRule + '任务:' + text, deps: [] },
    { id: 'system_architecture', role: architect || backend || frontend, prompt: '基于《需求范围.md》输出《技术架构.md》:模块划分、数据结构、接口/状态流、关键风险和实现顺序。' + (fullstack ? '必须明确技术架构清单:前端如 Vue 3.x、后端如 Java JDK21 + Spring Boot 3.x、数据库如 MySQL 8.0/或说明天气工具无需数据库、/api 接口、端口监听、frontend/、frontend/dist/index.html、backend/ 和 orch.app.json 发布配置;用户已指定技术优先遵守。' : '') + '任务:' + text, deps: ['scope_requirements'] },
    { id: 'ux_interaction', role: ux || frontend || product, prompt: '输出《交互设计.md》:页面布局、关键流程、状态反馈、响应式要求和可用性验收点。任务:' + text, deps: ['scope_requirements'] },
    { id: 'backend_domain', role: backend || architect || frontend, prompt: (fullstack ? '在 backend/ 实现后端服务和业务接口,必须监听 process.env.PORT || process.env.ORCH_APP_PORT || 3000,提供健康检查和 /api/... 接口,交付可被前端直接调用的业务能力。' : '实现或定义核心业务/数据/接口层,承接《技术架构.md》,交付可被前端直接使用的业务能力。') + '任务:' + text, deps: ['system_architecture'] },
    { id: 'frontend_experience', role: frontend || backend || ux, prompt: (fullstack ? '在 frontend/ 实现用户可见页面与交互,最终生成 frontend/dist/index.html,页面通过 /api/... 调用后端,确保主要流程可操作。' : '实现用户可见页面与交互,承接《交互设计.md》和后端业务能力,确保主要流程可操作。') + '任务:' + text, deps: ['ux_interaction', 'backend_domain'] },
    { id: 'risk_review', role: security || qa || architect, prompt: '检查安全、权限、风控、数据一致性和异常路径,输出《风险复核.md》与必须修复项。任务:' + text, deps: ['backend_domain', 'frontend_experience'] },
    { id: 'acceptance_test', role: qa || security || frontend, prompt: '按验收口径做真实验收,输出 PASS/FAIL、复现步骤、未达标问题和修复建议。任务:' + text, deps: ['frontend_experience', 'risk_review'] },
  ];
  if (fullstack) {
    chain.splice(5, 0, { id: 'publish_manifest', role: architect || backend || frontend || product, prompt: '生成根目录 orch.app.json,声明 type:"fullstack",staticDir:"frontend/dist",entry:"index.html",apiPrefix:"/api",backend.start,backend.healthPath,确保应用广场可发布并直接访问。任务:' + text, deps: ['backend_domain', 'frontend_experience'] });
    const risk = chain.find((s) => s.id === 'risk_review');
    if (risk) risk.deps = ['backend_domain', 'frontend_experience', 'publish_manifest'];
    const acceptance = chain.find((s) => s.id === 'acceptance_test');
    if (acceptance) acceptance.deps = ['publish_manifest', 'risk_review'];
  }
  const steps = chain.filter((s) => s.role);
  const plan = { task: text, steps, routing: { lane: 'complex', confidence: 0.9, reason: '复杂任务 LLM 规划失败或粒度不足,已启用本地多员工保底编排' }, complexFallback: true };
  attachProcessMeta(plan, text, { lane: 'complex', confidence: 0.9, reason: plan.routing.reason }, roleMap);
  prependMeeting(plan, roleMap, mainDept, depts);
  ensureStepContracts(plan, roleMap);
  sanitizeDeps(plan);
  resolveRoles(plan.steps, roleMap, allowed, deptPools, text, depts);
  return plan;
}

// agents=所选执行器;roles/depts=员工目录;dept=部门任务;deptPools=部门执行器池;orchestration=文字编排;refine=需求细化
async function makePlan(text, opts) {
  const { mode, agents, roles, depts, dept, deptPools, explicit, orchestration, refine, templatesDir, onChild } = opts;
  const routeChoice = opts.routeChoice || opts.planningChoice || '';
  // 包装 claude:①注入 onChild(规划期 LLM 子进程注册运行态,支持取消)②过「元调用」信号量(规划/细化独立于执行步,不被占满的执行槽卡住排队;仍限并发防 fork 风暴)
  const base = opts.claude;
  let llmCalls = 0;
  const claude = base ? { run: async (o) => { llmCalls++; const s = require('./engine').metaSem(); await s.acquire(); try { return await base.run(onChild ? Object.assign({}, o, { onChild }) : o); } finally { s.release(); } } } : base;
  const allowed = (agents && agents.length) ? agents : ['claude'];
  let brief = text;
  const orch = (orchestration || '').trim();
  const empRoles = (roles || []).filter((r) => r.dept !== '__system');    // __system 不进员工目录
  const deptRoles = dept ? empRoles.filter((r) => r.dept === dept) : empRoles;
  const hostRoles = (roles || []).filter((r) => r.id === 'chief-orchestrator');
  const roleMap = {}; deptRoles.concat(hostRoles).forEach((r) => { roleMap[r.id] = r; });
  const roleIds = Object.keys(roleMap);
  let intent = assessIntent(text);
  if (routeChoice === 'A') intent = { lane: 'simple', confidence: 1, reason: '用户选择快速实现' };
  if (routeChoice === 'B') intent = { lane: 'standard', confidence: 1, reason: '用户选择标准编排' };
  if (routeChoice === 'C') intent = { lane: 'complex', confidence: 1, reason: '用户选择深度会议' };
  // 需求细化只对短且笼统、且已确定不需要用户选择/复杂会议的需求做;复杂业务不能被细化器压成单文件。
  const needRefine = refine && claude && isVagueBrief(text) && intent.lane !== 'complex' && intent.lane !== 'needs_choice';
  if (needRefine) { try { brief = await refineBrief(text, claude); } catch (e) {} }
  const chief = (roles || []).find((r) => r.id === 'chief-orchestrator'); // 总调度经验行
  const chiefMemo = chief && chief.memo ? relevantMemo(chief.memo, brief, 6) : ''; // 与员工一致:调度复盘也按当前任务相关性优选,不无脑塞全部

  let empModeFell = false; // 员工模式该走却没成功 → 后续回退标记为"降级"(丢了团队协作)
  const mark = (p) => (empModeFell && p ? Object.assign(p, { degraded: true }) : p);
  const diag = (p) => attachPlanDiagnostics(p);
  const finish = (p, route, extra) => {
    if (p && typeof p === 'object') {
      sequentializeSteps(p); // 执行顺序=确认顺序:所有计划出口统一拓扑重排+链式化(用户编辑计划的 edit-plan 路径不走这里,保留自定义)
      attachProcessMeta(p, text, intent, roleMap);
      p.validation = validateCrewPlan(p, Object.values(roleMap), text);
      p.planning_stats = Object.assign({ route, llm_calls: llmCalls, refined: brief !== text, process_type: p.process && p.process.type }, extra || {});
    }
    return p;
  };
  if (roleIds.length && !orch && !dept && mode !== 'template' && !routeChoice && intent.lane === 'needs_choice') {
    return finish(choicePlan(text, intent), 'awaiting-route-choice');
  }
  // 1) 用户显式只选一个执行器 + 无编排 + 非部门任务 + 无员工目录 → 该执行器单步直做
  //    有员工目录时不走此捷径:改走员工模式,让画布显"部门·角色"并按功能点细化(单执行器会被 resolveRoles coerce 成该执行器)
  if (explicit && allowed.length === 1 && !orch && !dept && !roleIds.length) {
    return finish(diag(ensureStepContracts({ task: text, steps: [{ id: 'build', agent: allowed[0], prompt: brief, deps: [] }] }, roleMap)), 'explicit-single');
  }
  if (roleIds.length && !orch && !dept && mode !== 'template' && intent.lane === 'simple') {
    const mainDept = pickMainDeptLocal(text, depts, deptRoles);
    return finish(diag(quickPlan(text, deptRoles, roleMap, allowed, deptPools, depts)), 'fast-simple', { main_dept: mainDept || '' });
  }
  // 2) 员工模式(默认):总调度按部门员工目录与流程规范拆分;部门任务只用该部门员工
  //    自愈:非法 role → 就近纠正;仍非法 → 带错误反馈让 LLM 重拆一次(避免默默丢角色回退到裸执行器)
  if (roleIds.length && claude && mode !== 'template') {
    // 分析任务→定主负责部门(仅默认全局任务时;显式部门任务/文字编排不覆盖)。会议据此确认,该部门主导执行、可跨部门协助
    let mainDept = null;
    if (!dept && !orch) mainDept = pickMainDeptLocal(brief, depts, empRoles);
    try {
      let p = await fromLLMRoles(brief, claude, deptRoles, depts, orch, dept, chiefMemo, undefined, mainDept);
      // 接受条件:每步是合法 role,或 LLM 夹带的裸合法 agent(容忍夹带,resolveRoles 会把裸 agent coerce 到部门执行器池);非法 role 仍视为失败
      const rmOk = (s) => s.type === 'loop' ? (Array.isArray(s.body) && s.body.length && s.body.every(rmOk)) : (roleIds.includes(s.role) || (!s.role && allowed.includes(s.agent)));
      // 提速:首版计划已可接受(结构合法)就直接用,不再花一次昂贵 LLM 回喂重拆;仅当首版不可接受(非法员工/缺指派/loop缺body)才带问题回喂一次
      if (!p.steps.every(rmOk) || actionableLint(lintPlan(p, true)).length) {
        if (!validateRoles(p, roleIds)) coerceRoles(p.steps, roleIds);
        const bad = validateRoles(p, roleIds) ? [] : badRoles(p, roleIds);
        const lint = actionableLint(lintPlan(p, true));
        if (bad.length || lint.length) {
          const fb = [...bad.map((r) => '员工id「' + r + '」不在员工目录'), ...lint].join('；');
          try { const p2 = await fromLLMRoles(brief, claude, deptRoles, depts, orch, dept, chiefMemo, fb, mainDept); coerceRoles(p2.steps, roleIds); if (p2.steps.every(rmOk) && !actionableLint(lintPlan(p2, true)).length) p = p2; } catch (e) {}
        }
      }
      if (intent.lane === 'complex' && !complexPlanSufficient(p, text, roleMap)) {
        const fp = fallbackComplexRolePlan(text, deptRoles, roleMap, allowed, deptPools, depts, mainDept);
        return finish(diag(fp), 'complex-fallback', { main_dept: mainDept || '' });
      }
      prependMeeting(p, roleMap, mainDept, depts); // 复杂计划前置"方案会议":讨论步→方案综合→实现步依赖它;传主部门→会上确认主负责部门、参会偏向该部门
      ensureStepContracts(p, roleMap); // LLM 漏写 expected_outcome 时兜底补契约,让执行/质量门都有验收口径
      if (p.steps.every(rmOk) && !actionableLint(lintPlan(p, true)).length) { sanitizeDeps(p); resolveRoles(p.steps, roleMap, allowed, deptPools, text, depts); if (intent.lane === 'complex') p.routing = { lane: 'complex', confidence: intent.confidence, reason: intent.reason }; return finish(diag(p), intent.lane === 'complex' ? 'employee-complex-llm' : 'employee-llm', { main_dept: mainDept || '' }); } // 解析:role→executor、裸 agent→coerce 到池(防 broken 自动发现 agent 混入)
    } catch (e) { /* 落到执行器模式 */ }
    if (intent.lane === 'complex') {
      const fp = fallbackComplexRolePlan(text, deptRoles, roleMap, allowed, deptPools, depts, mainDept);
      return finish(diag(fp), 'complex-fallback', { main_dept: mainDept || '' });
    }
    empModeFell = true; // 员工模式进了但没成功返回 → 下面回退即降级
  }
  // 3) 有文字编排 → 按编排(执行器模式)
  if (orch && claude) {
    try {
      let p = await fromLLM(brief, claude, allowed, orch);
      const lint = lintPlan(p, false); // #9 执行器模式同样体检:坏计划带问题回喂重拆一次
      if (lint.length) { try { const p2 = await fromLLM(brief, claude, allowed, orch, lint.join('；')); if (validate(p2, allowed) && !lintPlan(p2, false).length) p = p2; } catch (e) {} }
      if (validate(p, allowed)) { prependMeeting(p, roleMap); ensureStepContracts(p, roleMap); return finish(mark(diag(sanitizeDeps(p))), 'orchestration-llm'); } // 执行器模式也前置方案会议(复杂计划)
    } catch (e) {}
  }
  // 4) 显式模板模式且含 claude+codex → 走模板
  if (mode === 'template' && allowed.includes('claude') && allowed.includes('codex')) {
    const tpl = fromTemplate(brief, templatesDir); if (tpl) return finish(mark(diag(ensureStepContracts(tpl, roleMap))), 'template');
  }
  // 5) 多执行器 → LLM 拆
  if (claude && allowed.length > 1) {
    try {
      let p = await fromLLM(brief, claude, allowed);
      const lint = lintPlan(p, false); // #9 执行器模式体检 + 回喂
      if (lint.length) { try { const p2 = await fromLLM(brief, claude, allowed, undefined, lint.join('；')); if (validate(p2, allowed) && !lintPlan(p2, false).length) p = p2; } catch (e) {} }
      if (validate(p, allowed)) { prependMeeting(p, roleMap); ensureStepContracts(p, roleMap); return finish(mark(diag(sanitizeDeps(p))), 'executor-llm'); } // 执行器模式也前置方案会议(复杂计划)
    } catch (e) {}
  }
  // 6) 兜底
  if (allowed.includes('claude') && allowed.includes('codex')) { const tpl = fromTemplate(brief, templatesDir); if (tpl) return finish(mark(diag(ensureStepContracts(tpl, roleMap))), 'template'); }
  if (intent.lane === 'complex' && roleIds.length) {
    const mainDept = !dept && !orch ? pickMainDeptLocal(brief, depts, empRoles) : null;
    const fp = fallbackComplexRolePlan(text, deptRoles, roleMap, allowed, deptPools, depts, mainDept);
    return finish(diag(fp), 'complex-fallback', { main_dept: mainDept || '' });
  }
  return finish(mark(diag(ensureStepContracts({ task: text, steps: [{ id: 'build', agent: allowed[0], prompt: brief, deps: [] }] }, roleMap))), 'fallback');
}

module.exports = { fromTemplate, fromLLM, fromLLMRoles, pickMainDept, makePlan, validate, validateRoles, resolveRoles, refineBrief, coerceRoles, badRoles, sanitizeDeps, sequentializeSteps, lintPlan, diagnosePlan, attachPlanDiagnostics, mergeEditedPlan, extractJson, fill, prependMeeting, ensureStepContracts, isRiskText, makeProcessMeta, validateCrewPlan };
