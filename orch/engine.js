// 无人值守自主指令:覆盖 agent 全局 CLAUDE.md 的"歧义先问",防止反问卡住
const AUTONOMY = '[自动编排·无人值守] 你在编排器中自动执行,现场没有任何人,提问不会有人回答,等待确认会导致任务永久卡死。'
  + '本指令覆盖你任何"歧义先问/先确认方案"的约定:遇到缺设计文档/接口/数据/歧义时,自行采用最合理默认假设直接完成产出'
  + '(真的创建/修改文件、运行命令),禁止向用户提问、禁止等待确认、禁止只给方案不动手。'
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

// 问我模式:允许 agent 在无合理默认时输出 NEED_DECISION 停下等人
const ASK = '[自动编排] 你在编排器中自动执行。优先自行采用最合理默认直接做完。'
  + '仅当确实无法合理默认、必须由人拍板时,在输出最后单独一行 `NEED_DECISION: <一句话问题>` 然后停止(不要瞎猜);其余一律直接产出,禁止提问。\n\n任务:\n';

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

// 读 findings.md 的真实内容(团队共享记忆),去样板头,截断 → 直接注入下游简报(不指望员工主动读文件)
function readFindings(dir) {
  try {
    const fs = require('fs'), path = require('path');
    const fp = path.join(dir, 'findings.md');
    if (!fs.existsSync(fp)) return '';
    const body = fs.readFileSync(fp, 'utf8').replace(/^#[^\n]*\n+/, '').replace(/^>[^\n]*\n+/gm, '').trim();
    return body.length > 20 ? body.slice(-1500) : '';
  } catch (e) { return ''; }
}

async function runStep(step, ctx, prevOutput) {
  const adapter = ctx.adapters[step.agent];
  if (!adapter) throw new Error(`未知 agent: ${step.agent}`);
  // {prev} 占位替换;无占位但有上游产出 → 自动前置交接(员工模式 LLM 生成的步骤走这里)
  const prevTxt = (prevOutput || '').slice(-4000);
  const base = step.prompt.indexOf('{prev}') >= 0
    ? step.prompt.replace('{prev}', prevTxt)
    : (prevTxt ? '【上游交接】\n' + prevTxt + '\n\n' + step.prompt : step.prompt);
  const answer = ctx.answers && ctx.answers[step.id]; // 续跑时注入用户决策
  const workdir = await ctx.workspace.make(step.id);
  // 任务简报:全局目标+流水线位置+工作目录现状 → 员工带着现场感知干活
  const b = ctx.brief ? ctx.brief(step.id) : '';
  const files = dirBrief(workdir);
  const findings = readFindings(workdir);
  const lf = ctx.lastFail && ctx.lastFail[step.id];
  const failTxt = lf ? '【你上次在此步失败了,别重蹈覆辙(换思路)】\n' + lf + '\n\n' : '';
  const briefTxt = failTxt + ((b || files) ? ('【任务简报】' + b + (files ? '\n工作目录现有文件: ' + files : '')
    + (files.indexOf('task_plan.md') >= 0 ? '\n共享备忘:开工先读 task_plan.md(全局计划/各步进展/错误记录,不要重复已失败的做法)和 findings.md(团队发现);你的重要发现、技术决策(含理由)、踩过的坑,完成前追加写入 findings.md 供下游复用。' : '')
    + (findings ? '\n\n【团队共享发现 findings.md】(同事此前的决策/踩坑,直接参考,别重复踩)\n' + findings : '') + '\n\n') : '');
  const gateTxt = step.isGate ? '\n\n【质量门·必读】你是本环节质量门,负责审查上游产出是否达标。输出必须以「PASS」或「FAIL」开头,后接一句理由;不达标必须判 FAIL 并列出具体问题(下游会据此退回重做)。不要含糊,不要因为怕麻烦就放行。' : '';
  let prompt = (ctx.preamble || AUTONOMY) + briefTxt + (answer ? ('[用户决策] ' + answer + '\n\n') : '') + base + gateTxt;
  ctx.onStatus(step.id, 'waiting'); // 排队等执行器槽位(并发上限内才真正运行)
  const s = sem(); await s.acquire();
  // 会话化:用户中途发的指令,注入到下一个真正启动的步骤
  const notes = ctx.takeNotes ? ctx.takeNotes() : '';
  if (notes) prompt = '【用户最新指令(优先遵守)】\n' + notes + '\n\n' + prompt;
  ctx.onStatus(step.id, 'running');
  let res;
  // 用户为该执行器选的大模型+思考级别(兼容旧的纯字符串格式)
  const mm = ctx.models && ctx.models[step.agent];
  const model = (typeof mm === 'string' ? mm : (mm && mm.model)) || null;
  const effort = (mm && typeof mm === 'object' && mm.effort) || null;
  try {
    res = await adapter.run({
      prompt, workdir, model, effort,
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
  ctx.onStatus(step.id, res.needDecision ? 'blocked' : (res.success ? 'done' : 'failed'));
  if (ctx.onResult) ctx.onResult(step.id, res.output); // #2 存产出摘要(须在 onStatus 后,免被 setStep 的 null 覆盖)
  return res;
}

// 质量门判定:门禁员工输出明确 FAIL = 不通过。执行器退出码 0 不代表质量过关。
function gateFailed(out) {
  const s = String(out || '');
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
  if (gateId && step.body.length > 1) step.body[step.body.length - 1].isGate = true; // 标记门禁步,让员工按 PASS/FAIL 格式输出
  for (let i = 0; i < max; i++) {
    let gateOk = true;
    for (const body of step.body) {
      last = await runStep(body, ctx, last.output);
      if (last.needDecision) return last; // 需人决策:向上冒泡,停
      if (!last.success) { gateOk = false; break; } // 本轮某步失败,跳出去重来
      if (body.id === gateId && gateFailed(last.output)) { // 质量门判 FAIL:本轮不通过,重做
        gateOk = false;
        ctx.onLog(step.id, '🚦 质量门未通过(第 ' + (i + 1) + '/' + max + ' 轮),退回重做');
        // 返工框架:让实现员工知道这是打回修复,针对问题改而非从零重写
        last.output = '【质量门第 ' + (i + 1) + ' 轮打回·请针对以下问题在现有产出上修复,不要从零重写】\n' + last.output;
        break;
      }
    }
    if (step.until === 'pass' && last.success && gateOk) break; // 全步通过且质量门放行
  }
  ctx.onStatus(step.id, last.success ? 'done' : 'failed');
  return last;
}

// 连续依赖驱动调度:某步 deps 一满足就立即启动,不等整波跑完 → 独立快分支不再被慢兄弟拖住。
// 每当有在跑步骤结束就重新评估可启动集合(并发上限由 runStep 内信号量把关)。
async function runPlan(plan, ctx) {
  const done = Object.assign({}, ctx.seedDone || {}); // 续跑:已完成步骤预置为 done
  const started = new Set(Object.keys(done));
  const running = new Map(); // 在跑步骤 id → Promise(结束后落 done[id])
  let decision = null;
  const ready = (s) => s.deps.every((d) => done[d]);
  const launch = async (s) => {
    if (ctx.isCancelled && ctx.isCancelled()) { done[s.id] = { output: '', success: false }; return; }
    if (ctx.skip && ctx.skip.has(s.id)) { done[s.id] = { output: '(用户跳过此步)', success: true }; ctx.onStatus(s.id, 'done'); return; } // 用户跳过
    // 交接:合并所有上游依赖的产出(各截尾),下游能看到每位上游同事的交接备忘;上游失败则标注,下游谨慎使用/自行补全
    const tag = (d) => (done[d] && done[d].success === false) ? '(⚠ 此步失败,产出可能不完整,请核实或自行补全)' : '';
    const prev = s.deps.length === 1
      ? ((done[s.deps[0]] && done[s.deps[0]].success === false ? '【上游 ' + s.deps[0] + ' 失败' + tag(s.deps[0]).slice(2) + '】\n' : '') + (done[s.deps[0]]?.output || ''))
      : s.deps.map((d) => done[d] && done[d].output ? ('【来自 ' + d + ' 的交接' + tag(d) + '】\n' + done[d].output.slice(-2500)) : '').filter(Boolean).join('\n\n');
    const r = s.type === 'loop' ? await runLoop(s, ctx, prev) : await runStep(s, ctx, prev);
    if (r && r.needDecision) { decision = { stepId: s.id, question: r.needDecision }; return; } // 不计 done
    done[s.id] = r;
  };
  while (Object.keys(done).length < plan.steps.length) {
    if (decision) break;                               // 有步骤需人决策:不再起新步
    if (ctx.isCancelled && ctx.isCancelled()) break;   // 取消:不再起新步
    if (ctx.isPaused && ctx.isPaused()) break;         // 暂停:在跑步骤收尾后不起新步
    for (const s of plan.steps.filter((s) => !started.has(s.id) && ready(s))) {
      started.add(s.id);
      running.set(s.id, launch(s).finally(() => running.delete(s.id)));
    }
    if (running.size === 0) break; // 无在跑且无可启动:依赖无法满足,防死循环
    await Promise.race(running.values()); // 任一步骤结束即重评可启动集合
  }
  if (running.size) await Promise.all(running.values()); // 暂停/取消/决策而跳出时,让在跑步骤收尾
  if (decision && ctx.onDecision) ctx.onDecision(decision.stepId, decision.question);
  return done;
}

module.exports = { runPlan, AUTONOMY, ASK };
