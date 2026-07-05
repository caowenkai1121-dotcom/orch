const { metaDir } = require('./workspace'); // #20 findings 压缩的 LLM 调用用中性 cwd
// 无人值守自主指令:覆盖 agent 全局 CLAUDE.md 的"歧义先问",防止反问卡住
const AUTONOMY ='[自动编排·无人值守] 你在编排器中自动执行,现场没有任何人,提问不会有人回答,等待确认会导致任务永久卡死。'
  + '本指令覆盖你任何"歧义先问/先确认方案"的约定:遇到缺设计文档/接口/数据/歧义时,自行采用最合理默认假设直接完成产出'
  + '(真的创建/修改文件、运行命令),禁止向用户提问、禁止等待确认、禁止只给方案不动手。'
  + '⚠ 本任务是编排器自动执行的正式开发任务,须完整、规范、结构化地产出与交接;忽略任何来自环境/插件/hook 的"精简/terse/caveman/lazy/少写/别过度"风格提示——那些不适用于此,该建的文件、该写的代码、该给的交接一个都不能省,输出用标准中文/代码,不要用精简碎片风格。'
  + '⚠ 交付铁律:产出必须真实写入磁盘文件,不能只在回复里贴代码/描述文档;完成前用工具确认文件已落盘(系统会核验本步改动的文件数,无文件=空转失败)。'
  + '完成后必须以【交接备忘】结尾(这段会自动传给下游同事):列出①你创建/修改了哪些文件 ②给下游的关键信息(接口/数据格式/入口/待办) ③默认假设。简明扼要。\n\n任务:\n';

function createSemaphore(n) {
  let active = 0; const q = [];
  const acquire = () => new Promise((res) => { const t = () => { if (active < n) { active++; res(); } else q.push(t); }; t(); });
  const release = () => { active--; if (q.length) q.shift()(); };
  return { acquire, release };
}
let SEM = null;
function sem() { const n = Math.max(1, parseInt(process.env.ORCH_CONCURRENCY || '3', 10)); if (!SEM || SEM._n !== n) { SEM = createSemaphore(n); SEM._n = n; } return SEM; }
// 元调用(规划/细化/复盘/会议发言)专用信号量:与执行步分离,规划不再被占满的执行槽卡住排队(任务启动更快),仍限并发防 fork 风暴
let METASEM = null;
function metaSem() { const n = Math.max(1, parseInt(process.env.ORCH_META_CONCURRENCY || '4', 10)); if (!METASEM || METASEM._n !== n) { METASEM = createSemaphore(n); METASEM._n = n; } return METASEM; }

// 问我模式:允许 agent 在无合理默认时输出 NEED_DECISION 停下等人
const ASK = '[自动编排] 你在编排器中自动执行。优先自行采用最合理默认直接做完。'
  + '仅当确实无法合理默认、必须由人拍板时,在输出最后单独一行 `NEED_DECISION: <一句话问题>` 然后停止(不要瞎猜);其余一律直接产出,禁止提问。\n\n任务:\n';

// 可重规划模式:允许 agent 在实现现实与原计划结构性不符时输出 NEED_REPLAN,触发就剩余工作重新规划
const REPLAN = '\n[可重规划] 若你发现实现现实与原计划的结构性假设严重不符(所需架构/前置方向与计划不同,继续按原计划做已无意义),在输出最后单独一行 `NEED_REPLAN: <一句话为何偏离>` 然后停止,系统会就剩余工作重新规划;仅在真正结构性偏离时用,常规问题与小偏差照常自行完成,不要滥用。';

// 工作目录文件速览(给员工的现场感知,最多40个)
function dirBrief(dir) {
  try {
    const fs = require('fs'), path = require('path');
    const out = [];
    const walk = (d, rel, depth) => {
      if (out.length >= 40 || depth > 2) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        const rp = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), rp, depth + 1);
        else out.push(rp);
        if (out.length >= 40) return;
      }
    };
    walk(dir, '', 0);
    return out.join(', ');
  } catch (e) { return ''; }
}

// 读 findings.md 的真实内容(团队共享记忆),去样板头 → 直接注入下游简报(不指望员工主动读文件)
function rawFindings(dir) {
  try {
    const fs = require('fs'), path = require('path');
    const fp = path.join(dir, 'findings.md');
    if (!fs.existsSync(fp)) return '';
    const body = fs.readFileSync(fp, 'utf8').replace(/^#[^\n]*\n+/, '').replace(/^>[^\n]*\n+/gm, '').trim();
    return body.length > 20 ? body : '';
  } catch (e) { return ''; }
}
// #20 上下文压缩(参考 AgentScope):findings 过大时 LLM 压成缓存摘要(保留决策/坑/接口),而非粗暴尾截断丢老信息;
// 短任务(findings≤4000字)零成本走原尾截断;压缩失败兜底尾截断。缓存按 dir+长度,重启重算。
const _fndDigest = new Map();
async function getFindings(dir, ctx) {
  const raw = rawFindings(dir);
  if (!raw) return '';
  if (raw.length <= 4000 || !(ctx && ctx.adapters && ctx.adapters.claude)) return raw.slice(-1500); // 小/无压缩器:原截断
  const key = dir + ':' + raw.length;
  if (_fndDigest.has(key)) return _fndDigest.get(key);
  try {
    const s = sem(); await s.acquire(); // 压缩发生在步骤自身 acquire 之前,不自锁;仍过并发闸防 fork 风暴
    let out;
    try { ({ output: out } = await ctx.adapters.claude.run({ prompt: '把下面团队协作 findings 压成不超过 600 字的要点摘要,保留关键技术决策/踩过的坑/接口约定,去重去啰嗦,只输出摘要正文:\n\n' + raw, workdir: metaDir(), onLine: () => {} })); }
    finally { s.release(); }
    const digest = '【findings 压缩摘要(原文过长已 LLM 提炼)】\n' + String(out || '').trim().slice(0, 1800);
    _fndDigest.set(key, digest);
    return digest;
  } catch (e) { return raw.slice(-1500); }
}

// 交接提取:员工被要求以【交接备忘】结尾(产出清单/关键信息/默认假设)。取最后一次备忘到结尾,
// 给下游干净聚焦的信号而非混入大量思考散文的原始尾切;未写备忘则兜底尾切。丢弃的前置细节下游可读盘补全。
function handoff(out) {
  const s = String(out || '');
  const i = s.lastIndexOf('【交接备忘】');
  return i >= 0 ? s.slice(i, i + 1800) : s.slice(-2500);
}

// PlanWeave 融合(localReviewExecutor):把脚本/命令退出码当确定性质量门——退出0=PASS、非0=FAIL。
// 异步 spawn 不阻塞事件循环;success 恒 true(命令跑完了),PASS/FAIL 由输出交给 gateFailed 判(与 LLM 门同语义);仅命令跑不起来才 success:false。复用步骤超时守卫。
function runGateCmd(cmd, workdir, onLog) {
  return new Promise((resolve) => {
    const p = require('child_process').spawn(cmd, { cwd: workdir || process.cwd(), shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const T = require('./adapters/steptimeout').arm(p);
    let out = '';
    const cap = (b) => { const s = b.toString(); out += s; if (onLog) s.split('\n').filter(Boolean).forEach((l) => onLog('🔧 ' + l)); };
    p.stdout.on('data', cap); p.stderr.on('data', cap);
    p.on('close', (code) => { T.clear(); const pass = code === 0 && !T.timedOut();
      resolve({ output: (pass ? 'PASS ✅ 脚本质量门通过' : 'FAIL 脚本质量门未通过') + '(' + cmd + ',退出码 ' + code + (T.timedOut() ? ',超时' : '') + ')\n' + out.slice(-1500), success: true }); });
    p.on('error', (e) => { T.clear(); resolve({ output: 'FAIL 脚本质量门无法运行(' + cmd + '):' + ((e && e.message) || e), success: false }); });
  });
}

async function runStep(step, ctx, prevOutput) {
  const workdir = await ctx.workspace.make(step.id);
  // PlanWeave 融合:step.gate_cmd 存在则本步是确定性脚本门,不调 LLM(零 token+可复现),退出码定 PASS/FAIL,与 expected_outcome 契约互补
  if (step.gate_cmd) {
    const sg = sem(); await sg.acquire();
    try {
      if (ctx.isCancelled && ctx.isCancelled()) { ctx.onStatus(step.id, 'failed'); return { output: '(已取消,未启动)', success: false }; }
      ctx.onStatus(step.id, 'running');
      const r = await runGateCmd(step.gate_cmd, workdir, (line) => ctx.onLog(step.id, line));
      ctx.onStatus(step.id, r.success ? 'done' : 'failed');
      return r;
    } finally { sg.release(); }
  }
  const adapter = ctx.adapters[step.agent];
  if (!adapter) throw new Error(`未知 agent: ${step.agent}`);
  // {prev} 占位替换;无占位但有上游产出 → 自动前置交接(员工模式 LLM 生成的步骤走这里)
  const prevTxt = (prevOutput || '').slice(-4000);
  const base = step.prompt.indexOf('{prev}') >= 0
    ? step.prompt.replace('{prev}', prevTxt)
    : (prevTxt ? '【上游交接】\n' + prevTxt + '\n\n' + step.prompt : step.prompt);
  const answer = ctx.answers && ctx.answers[step.id]; // 续跑时注入用户决策
  // 任务简报:全局目标+流水线位置+工作目录现状 → 员工带着现场感知干活
  const b = ctx.brief ? ctx.brief(step.id) : '';
  const files = dirBrief(workdir);
  const findings = await getFindings(workdir, ctx); // #20 过大则压缩摘要,否则原截断
  const lf = ctx.lastFail && ctx.lastFail[step.id];
  const failTxt = lf ? '【你上次在此步失败了,别重蹈覆辙(换思路)】\n' + lf + '\n\n' : '';
  const briefTxt = failTxt + ((b || files) ? ('【任务简报】' + b + (files ? '\n工作目录现有文件: ' + files : '')
    + (files.indexOf('task_plan.md') >= 0 ? '\n共享备忘:开工先读 task_plan.md(全局计划/各步进展/错误记录,不要重复已失败的做法)和 findings.md(团队发现);你的重要发现、技术决策(含理由)、踩过的坑,完成前追加写入 findings.md 供下游复用。' : '')
    + (findings ? '\n\n【团队共享发现 findings.md】(同事此前的决策/踩坑,直接参考,别重复踩)\n' + findings : '') + '\n\n') : '');
  const outcomeTxt = step.expected_outcome ? '\n【本步预期产出/验收标准】' + step.expected_outcome + '\n' : ''; // #5 契约:声明本步做到什么算完成
  const gateTxt = step.isGate ? ('\n\n【质量门·必读】你是本环节质量门,负责审查上游产出是否达标。输出必须以「PASS」或「FAIL」开头,后接一句理由;不达标必须判 FAIL 并列出具体问题(下游会据此退回重做)。不要含糊,不要因为怕麻烦就放行。' + (step.expected_outcome ? '严格据上方【验收标准】判定。' : '')) : '';
  // #18 只读步:抵消 AUTONOMY「无文件=空转失败」的写盘铁律(只读沙箱本就禁写),避免审查 agent 误尝试写盘
  const readTxt = step.permission === 'read' ? '\n【只读审查步】本步在只读沙箱运行,禁止且无法改写/创建文件;以文本形式直接给出审查结论/发现即可,无需落盘,不算空转。\n' : '';
  let prompt = (ctx.preamble || AUTONOMY) + briefTxt + outcomeTxt + readTxt + (answer ? ('[用户决策] ' + answer + '\n\n') : '') + base + gateTxt;
  ctx.onStatus(step.id, 'waiting'); // 排队等执行器槽位(并发上限内才真正运行)
  const s = sem(); await s.acquire();
  let res;
  // try 从 acquire 之后即开始:onStatus('running')/store 写入等若抛,finally 也必释放槽位(否则模块级共享 SEM permit 泄漏→累积到上限全局死锁)
  try {
    // 拿到槽位后、spawn 前复检取消:排队期间用户可能已点取消,而 cancel 的一次性 killTree 早已跑完;
    // 此时若仍 spawn,会产生取消之后诞生、够不到的孤儿子进程(违反「取消须杀该任务所有子进程」不变量)。
    if (ctx.isCancelled && ctx.isCancelled()) { ctx.onStatus(step.id, 'failed'); return { output: '(已取消,未启动)', success: false }; }
    // 会话化:用户中途发的指令,注入到下一个真正启动的步骤
    const notes = ctx.takeNotes ? ctx.takeNotes() : '';
    if (notes) prompt = '【用户最新指令(优先遵守)】\n' + notes + '\n\n' + prompt;
    ctx.onStatus(step.id, 'running');
    // 用户为该执行器选的大模型+思考级别(兼容旧的纯字符串格式);任务没指定则回退到该执行器的默认(#4)
    const mm = ctx.models && ctx.models[step.agent];
    const dd = ctx.agentDefaults && ctx.agentDefaults[step.agent];
    const model = (typeof mm === 'string' ? mm : (mm && mm.model)) || (dd && dd.model) || null;
    const effort = (mm && typeof mm === 'object' && mm.effort) || (dd && dd.effort) || null;
    res = await adapter.run({
      prompt, workdir, model, effort,
      permission: step.permission, // #18 'read'=只读沙箱(审查/分析步)| 缺省 write(现有行为)
      onLine: (line) => ctx.onLog(step.id, line),
      onChild: (child) => { ctx.onChild && ctx.onChild(child); },
      onUsage: (u) => { ctx.onUsage && ctx.onUsage(step.id, step.agent, u); },
    });
  } catch (e) {
    // 适配器抛错(如 spawn 命令不存在):转成失败结果而非上抛,否则本步卡在 running 且整个 plan 中断、独立分支跟着废
    const msg = '执行器异常: ' + ((e && e.message) || String(e));
    ctx.onLog(step.id, '✗ ' + msg);
    res = { output: msg, success: false };
  } finally { s.release(); }
  const m = ctx.askMode && (res.output || '').match(/NEED_DECISION:\s*(.+)/);
  if (m) res.needDecision = m[1].trim();
  const rp = ctx.replanMode && (res.output || '').match(/NEED_REPLAN:\s*(.+)/);
  if (rp) res.needReplan = rp[1].trim();
  ctx.onStatus(step.id, (res.needDecision || res.needReplan) ? 'blocked' : (res.success ? 'done' : 'failed'));
  if (ctx.onResult) ctx.onResult(step.id, res.output); // #2 存产出摘要(须在 onStatus 后,免被 setStep 的 null 覆盖)
  return res;
}

// 质量门判定:门禁员工输出明确 FAIL = 不通过。执行器退出码 0 不代表质量过关。
function gateFailed(out) {
  const s = String(out || '');
  if (/^PASS\b/i.test(s.trimStart())) return false; // 轮17 契约:门禁以判词开头,首词 PASS 即放行,压过下方全文邻近正则(免"结果无FAIL"等合规PASS被误退)
  if (/(判定|结论|verdict|结果)[^\n]{0,6}FAIL/i.test(s) || /❌\s*FAIL/.test(s)) return true;
  // 按首个出现的判定词决定(轮17 强制门禁以 PASS/FAIL 开头):FAIL 先出现或只有 FAIL → 不通过
  const fi = s.search(/\bFAIL\b/), pi = s.search(/\bPASS\b/);
  if (fi >= 0 && (pi < 0 || fi < pi)) return true;
  return false;
}

async function runLoop(step, ctx, prevOutput) {
  let last = { output: prevOutput || '', success: false };
  const max = Math.min(Math.max(1, step.max || 3), 5); // LLM 没给兜底 3;封顶 5 防失控重试烧钱
  const gateId = step.body.length ? step.body[step.body.length - 1].id : null; // 约定:body 末步为质量门
  if (gateId && step.body.length > 1) {
    const g = step.body[step.body.length - 1]; g.isGate = true; // 标记门禁步,让员工按 PASS/FAIL 格式输出
    if (!g.expected_outcome) { const impl = step.body.find((b) => b.id !== g.id && b.expected_outcome); if (impl) g.expected_outcome = impl.expected_outcome; } // #5 gate 无自带验收标准则继承实现步预期产出作判定契约
  }
  const gateEnforced = gateId && step.body.length > 1 && step.until === 'pass'; // 真质量门 loop(非门禁 loop 保持原语义)
  let passed = false;
  for (let i = 0; i < max; i++) {
    let gateOk = true;
    for (const body of step.body) {
      last = await runStep(body, ctx, last.output);
      if (last.needDecision || last.needReplan) return last; // 需人决策/重规划:向上冒泡,停
      if (!last.success) { gateOk = false; break; } // 本轮某步失败,跳出去重来
      if (body.id === gateId && gateFailed(last.output)) { // 质量门判 FAIL:本轮不通过,重做
        gateOk = false;
        ctx.onLog(step.id, '🚦 质量门未通过(第 ' + (i + 1) + '/' + max + ' 轮),退回重做');
        // 返工框架:让实现员工知道这是打回修复,针对问题改而非从零重写
        last.output = '【质量门第 ' + (i + 1) + ' 轮打回·请针对以下问题在现有产出上修复,不要从零重写】\n' + last.output;
        break;
      }
    }
    if (step.until === 'pass' && last.success && gateOk) { passed = true; break; } // 全步通过且质量门放行
  }
  // 门禁 loop 耗尽 max 仍未放行 → 如实 failed(原先只看门禁员工进程退出码,连续 FAIL 也假判 done,门禁形同虚设)
  const ok = last.success && (gateEnforced ? passed : true);
  last.success = ok;
  ctx.onStatus(step.id, ok ? 'done' : 'failed');
  return last;
}

// 连续依赖驱动调度:某步 deps 一满足就立即启动,不等整波跑完 → 独立快分支不再被慢兄弟拖住。
// 每当有在跑步骤结束就重新评估可启动集合(并发上限由 runStep 内信号量把关)。
async function runPlan(plan, ctx) {
  const done = Object.assign({}, ctx.seedDone || {}); // 续跑:已完成步骤预置为 done
  const started = new Set(Object.keys(done));
  const running = new Map(); // 在跑步骤 id → Promise(结束后落 done[id])
  let decision = null;
  let replan = null; // #12 有步骤发 NEED_REPLAN → 停止起新步,冒泡触发重规划
  const held = new Set(); // #1 命名锁:同任务各步共享目录,声明同名 lock 的并发步互斥,防内容互相覆盖
  const locksOf = (s) => Array.isArray(s.locks) ? s.locks : (s.lock ? [s.lock] : []);
  const lockFree = (s) => locksOf(s).every((l) => !held.has(l));
  const ready = (s) => s.deps.every((d) => done[d]);
  const launch = async (s) => {
    try {
      if (ctx.isCancelled && ctx.isCancelled()) { done[s.id] = { output: '', success: false }; return; }
      if (ctx.skip && ctx.skip.has(s.id)) { done[s.id] = { output: '(用户跳过此步)', success: true }; ctx.onStatus(s.id, 'done'); return; } // 用户跳过
      // 交接:合并所有上游依赖的产出(各截尾),下游能看到每位上游同事的交接备忘;上游失败则标注,下游谨慎使用/自行补全
      const tag = (d) => (done[d] && done[d].success === false) ? '(⚠ 此步失败,产出可能不完整,请核实或自行补全)' : '';
      const prev = s.deps.length === 1
        ? ((done[s.deps[0]] && done[s.deps[0]].success === false ? '【上游 ' + s.deps[0] + ' 失败' + tag(s.deps[0]).slice(2) + '】\n' : '') + handoff(done[s.deps[0]]?.output))
        : s.deps.map((d) => done[d] && done[d].output ? ('【来自 ' + d + ' 的交接' + tag(d) + '】\n' + handoff(done[d].output)) : '').filter(Boolean).join('\n\n');
      const r = s.type === 'loop' ? await runLoop(s, ctx, prev) : await runStep(s, ctx, prev);
      if (r && r.needDecision) { decision = { stepId: s.id, question: r.needDecision }; return; } // 不计 done
      if (r && r.needReplan) { replan = { stepId: s.id, reason: r.needReplan }; return; } // 需重规划:不计 done,冒泡
      done[s.id] = r;
    } catch (e) {
      // runStep 前置段(workspace.make/brief/onStatus/prompt 等,在其自身 try 之外)或其它抛错:转失败态正常 resolve。
      // 否则 launch reject → Promise.race 掀翻无 try 的 runPlan → 跳过在跑步收尾(224 的 Promise.all)→ 并发子进程成不可杀孤儿。
      try { ctx.onStatus(s.id, 'failed'); } catch (x) {}
      done[s.id] = { output: '步骤异常: ' + ((e && e.message) || String(e)), success: false };
    }
  };
  while (Object.keys(done).length < plan.steps.length) {
    if (decision || replan) break;                     // 有步骤需人决策/重规划:不再起新步
    if (ctx.isCancelled && ctx.isCancelled()) break;   // 取消:不再起新步
    if (ctx.isPaused && ctx.isPaused()) break;         // 暂停:在跑步骤收尾后不起新步
    if (ctx.overBudget && ctx.overBudget()) break;     // 超成本上限:收尾在跑步骤,不再起新步(防无人值守烧钱失控)
    for (const s of plan.steps.filter((s) => !started.has(s.id) && ready(s))) {
      if (!lockFree(s)) continue; // #1 锁被占:该步留待持锁步结束后下一轮再启(持锁步在跑→running≥1,不会误判死锁)
      started.add(s.id);
      const ls = locksOf(s); ls.forEach((l) => held.add(l));
      running.set(s.id, launch(s).finally(() => { running.delete(s.id); ls.forEach((l) => held.delete(l)); }));
    }
    if (running.size === 0) break; // 无在跑且无可启动:依赖无法满足,防死循环
    await Promise.race(running.values()); // 任一步骤结束即重评可启动集合
  }
  if (running.size) await Promise.all(running.values()); // 暂停/取消/决策而跳出时,让在跑步骤收尾
  if (decision && ctx.onDecision) ctx.onDecision(decision.stepId, decision.question);
  else if (replan && ctx.onReplan) ctx.onReplan(replan.stepId, replan.reason); // 决策优先:同批两者都置时只冒泡决策,replan 步仍 blocked,答完续跑时重跑并重新冒泡(自愈),不静默双发丢一个
  return done;
}

module.exports = { runPlan, AUTONOMY, ASK, REPLAN, sem, metaSem, getFindings };
