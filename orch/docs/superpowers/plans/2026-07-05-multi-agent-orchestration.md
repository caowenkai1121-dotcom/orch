# 多智能体编排增强实施计划

> **给智能体执行者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务逐项实施。所有步骤使用 `- [ ]` 复选框跟踪。

**目标：** 把 TradingAgents 的有界辩论、风险复核、经理裁决和 CrewAI 的流程类型、本地计划校验、层级 manager 思路集成到现有 orch 编排系统。

**架构：** 保持现有 Node.js CommonJS 单体结构，不引入新依赖。`planner.js` 负责流程类型、复杂度判断、计划复核和会议节点生成；`runner.js` 负责编排决策日志、会议提示词和 `task_plan.md` 沉淀；`api.js` 和前端只消费已有计划元数据做展示。

**技术栈：** Node.js CommonJS、`node:test`、Express、SQLite、现有原生前端；不新增第三方库。

## 全局约束

- 只修改 `D:\swap\orch`。
- 不触碰 `D:\channl`。
- 不新增第三方依赖。
- 不新增数据库迁移。
- 不重写 `engine.js` 执行器。
- 不一次性重写大文件，只做就近小改。
- 每个生产代码改动先补失败测试，再实现。
- 简单任务不能因为新机制变慢。
- 复杂股票交易网站必须触发复杂高风险编排。
- 计划必须能解释为什么这样编排。

---

## 文件结构

- 修改 `D:/swap/orch/planner.js`
  - 新增流程元数据生成函数。
  - 新增本地计划复核函数。
  - 调整复杂任务保底计划和会议插入逻辑。
  - 导出复核函数供测试使用。

- 修改 `D:/swap/orch/runner.js`
  - 在规划完成后写入编排决策事件。
  - 在 `task_plan.md` 增加“编排决策”段落。
  - 升级会议提示词为固定议程。

- 修改 `D:/swap/orch/api.js`
  - 给画布节点增加 `processType`、`processLabel`、`orchestrationReason`、`meetingAgenda` 字段。

- 修改 `D:/swap/orch/web/app.js`
  - 在节点详情里展示流程、编排理由、会议议程。

- 修改 `D:/swap/orch/web/index.html`
  - 如已有节点详情样式可复用，只补极少量样式。

- 修改 `D:/swap/orch/test/planner.test.js`
  - 覆盖流程类型、复核器、复杂任务高风险编排。

- 修改 `D:/swap/orch/test/meeting.test.js`
  - 覆盖固定会议议程和会议总结约束。

- 修改 `D:/swap/orch/test/runner.test.js`
  - 覆盖编排决策事件和计划文件沉淀。

- 修改 `D:/swap/orch/test/api.test.js`
  - 覆盖画布流程字段。

---

### Task 1: 流程类型元数据

**Files:**
- Modify: `D:/swap/orch/planner.js`
- Test: `D:/swap/orch/test/planner.test.js`

**Interfaces:**
- Produces: `plan.process = { type, reason, manager_role, debate_rounds, risk_review }`
- Produces: `planning_stats.process_type`
- Produces: `makeProcessMeta(text, intent, plan, roleMap)`

- [ ] **Step 1: 写失败测试**

在 `test/planner.test.js` 追加：

```js
test('流程类型:复杂股票交易网站标记为高风险复核流程', async () => {
  const roles = [
    { id: 'product-manager', dept: 'product', name: '产品经理', description: 'PRD与范围', prompt: 'p', executor: 'claude' },
    { id: 'engineering-backend-architect', dept: 'engineering', name: '后端架构师', description: '交易接口和数据库', prompt: 'p', executor: 'claude' },
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '交易页面和行情看板', prompt: 'p', executor: 'claude' },
    { id: 'security-appsec-engineer', dept: 'security', name: '应用安全工程师', description: '权限、安全、风控', prompt: 'p', executor: 'codex' },
    { id: 'testing-api-tester', dept: 'testing', name: 'API测试员', description: '接口和验收测试', prompt: 'p', executor: 'codex' },
  ];
  const depts = [
    { id: 'product', name: '产品部' },
    { id: 'engineering', name: '工程部' },
    { id: 'security', name: '安全部' },
    { id: 'testing', name: '测试部' },
  ];
  const claude = { async run() { throw new Error('触发本地复杂保底'); } };
  const plan = await makePlan('开发一个复杂的股票交易网站', { agents: ['claude', 'codex'], roles, depts, refine: true, templatesDir: __dirname, claude });

  assert.equal(plan.process.type, 'risk_review');
  assert.equal(plan.process.risk_review, true);
  assert.equal(plan.process.debate_rounds, 1);
  assert.match(plan.process.reason, /股票|交易|金融|风险|复杂/);
  assert.equal(plan.planning_stats.process_type, 'risk_review');
});

test('流程类型:低置信歧义任务标记为 ask_user', async () => {
  const roles = [
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '页面实现', prompt: 'p', executor: 'claude' },
    { id: 'testing-reality-checker', dept: 'testing', name: '真实验收', description: '验收测试', prompt: 'p', executor: 'codex' },
  ];
  const claude = { async run() { throw new Error('歧义任务不应调用模型'); } };
  const plan = await makePlan('做一个网站', { agents: ['claude', 'codex'], roles, depts: [{ id: 'engineering', name: '工程部' }, { id: 'testing', name: '测试部' }], refine: true, templatesDir: __dirname, claude });

  assert.equal(plan.process.type, 'ask_user');
  assert.equal(plan.routing.lane, 'needs_choice');
});
```

- [ ] **Step 2: 运行失败测试**

Run: `node --test "test/planner.test.js" --test-name-pattern "流程类型"`

Expected: FAIL，错误应指向 `plan.process` 或 `planning_stats.process_type` 不存在。

- [ ] **Step 3: 最小实现**

在 `planner.js` 的 `choicePlan()` 附近加入：

```js
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
```

把 `choicePlan()` 返回值改为带 `process`：

```js
function choicePlan(text, intent) {
  const plan = {
    task: text,
    steps: [],
    routing: { lane: 'needs_choice', confidence: intent.confidence, reason: intent.reason, options: routeChoiceOptions() },
    diagnostics: { score: 100, issues: [] },
  };
  return attachProcessMeta(plan, text, intent, {});
}
```

在 `makePlan()` 的 `finish` 函数中追加流程统计：

```js
  const finish = (p, route, extra) => {
    attachProcessMeta(p, text, intent, roleMap);
    if (p && typeof p === 'object') p.planning_stats = Object.assign({ route, llm_calls: llmCalls, refined: brief !== text, process_type: p.process && p.process.type }, extra || {});
    return p;
  };
```

- [ ] **Step 4: 运行通过测试**

Run: `node --test "test/planner.test.js" --test-name-pattern "流程类型"`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add planner.js test/planner.test.js
git commit -m "feat: add orchestration process metadata"
```

---

### Task 2: 本地计划复核器

**Files:**
- Modify: `D:/swap/orch/planner.js`
- Test: `D:/swap/orch/test/planner.test.js`

**Interfaces:**
- Consumes: `plan.process`
- Produces: `validateCrewPlan(plan, roles, text) -> { ok, errors, warnings, repaired }`
- Produces: `plan.validation = validateCrewPlan(...)`

- [ ] **Step 1: 写失败测试**

把 `planner.test.js` 的 require 改成：

```js
const { fromTemplate, makePlan, validateCrewPlan } = require('../planner');
```

追加测试：

```js
test('计划复核:发现非法依赖和缺失员工', () => {
  const roles = [
    { id: 'backend', dept: 'engineering', name: '后端', description: 'API', prompt: 'p', executor: 'claude' },
  ];
  const plan = { task: '开发交易系统', steps: [
    { id: 'build', role: 'missing-role', prompt: '实现', deps: ['future'] },
    { id: 'future', role: 'backend', prompt: '后续', deps: ['future'] },
  ] };

  const result = validateCrewPlan(plan, roles, '开发交易系统');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => /员工|role/.test(x)));
  assert.ok(result.errors.some((x) => /依赖|deps/.test(x)));
});

test('计划复核:复杂交易任务缺少风险或测试角色时不通过', () => {
  const roles = [
    { id: 'product-manager', dept: 'product', name: '产品经理', description: '产品', prompt: 'p', executor: 'claude' },
    { id: 'engineering-backend-architect', dept: 'engineering', name: '后端架构师', description: '交易接口', prompt: 'p', executor: 'claude' },
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '页面', prompt: 'p', executor: 'claude' },
  ];
  const plan = { task: '开发股票交易网站', process: { type: 'risk_review' }, steps: [
    { id: 'scope', role: 'product-manager', prompt: '需求', deps: [] },
    { id: 'backend', role: 'engineering-backend-architect', prompt: '后端', deps: ['scope'] },
    { id: 'frontend', role: 'engineering-frontend-developer', prompt: '前端', deps: ['backend'] },
    { id: 'acceptance', role: 'engineering-frontend-developer', prompt: '验收', deps: ['frontend'] },
  ] };

  const result = validateCrewPlan(plan, roles, '开发股票交易网站');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => /安全|风险|测试/.test(x)));
});
```

- [ ] **Step 2: 运行失败测试**

Run: `node --test "test/planner.test.js" --test-name-pattern "计划复核"`

Expected: FAIL，错误应为 `validateCrewPlan is not a function`。

- [ ] **Step 3: 最小实现**

在 `planner.js` 的 `complexPlanSufficient()` 前加入：

```js
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
  if (isRiskText(text) && !hasRoleText(/security|risk|安全|风险|风控|testing|qa|测试|验收/)) errors.push('高风险任务缺少安全、风险或测试角色');
  if (flat.length >= 4 && new Set(flat.map((s) => s.role).filter(Boolean)).size < 2) warnings.push('复杂计划角色过少，可能缺少协作');
  return { ok: errors.length === 0, errors, warnings, repaired: false };
}
```

在 `makePlan()` 所有 `return finish(...)` 前不需要逐个插入，直接在 `finish` 中附加：

```js
    if (p && typeof p === 'object') p.validation = validateCrewPlan(p, deptRoles, text);
```

完整 `finish` 目标形态：

```js
  const finish = (p, route, extra) => {
    attachProcessMeta(p, text, intent, roleMap);
    if (p && typeof p === 'object') p.validation = validateCrewPlan(p, deptRoles, text);
    if (p && typeof p === 'object') p.planning_stats = Object.assign({ route, llm_calls: llmCalls, refined: brief !== text, process_type: p.process && p.process.type }, extra || {});
    return p;
  };
```

在 `module.exports` 末尾加入 `validateCrewPlan`。

- [ ] **Step 4: 运行通过测试**

Run: `node --test "test/planner.test.js" --test-name-pattern "计划复核"`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add planner.js test/planner.test.js
git commit -m "feat: validate orchestration plans locally"
```

---

### Task 3: 高风险复杂任务的会议与保底编排

**Files:**
- Modify: `D:/swap/orch/planner.js`
- Test: `D:/swap/orch/test/planner.test.js`

**Interfaces:**
- Consumes: `plan.process`
- Produces: `plan.meeting.agenda`
- Produces: 复杂任务会议参会人数 4 到 5 人

- [ ] **Step 1: 写失败测试**

追加测试：

```js
test('高风险复杂任务会议:参会员工覆盖产品架构前端安全测试并带固定议程', async () => {
  const roles = [
    { id: 'product-manager', dept: 'product', name: '产品经理', description: '产品范围', prompt: 'p', executor: 'claude' },
    { id: 'design-ux-architect', dept: 'design', name: 'UX架构师', description: '交互', prompt: 'p', executor: 'claude' },
    { id: 'engineering-backend-architect', dept: 'engineering', name: '后端架构师', description: '交易接口', prompt: 'p', executor: 'claude' },
    { id: 'engineering-frontend-developer', dept: 'engineering', name: '前端开发', description: '交易界面', prompt: 'p', executor: 'claude' },
    { id: 'security-appsec-engineer', dept: 'security', name: '应用安全工程师', description: '安全与风控', prompt: 'p', executor: 'codex' },
    { id: 'testing-api-tester', dept: 'testing', name: 'API测试员', description: '测试验收', prompt: 'p', executor: 'codex' },
  ];
  const depts = [
    { id: 'product', name: '产品部' },
    { id: 'design', name: '设计部' },
    { id: 'engineering', name: '工程部' },
    { id: 'security', name: '安全部' },
    { id: 'testing', name: '测试部' },
  ];
  const claude = { async run() { throw new Error('触发本地复杂保底'); } };
  const plan = await makePlan('开发一个复杂的股票交易网站', { agents: ['claude', 'codex'], roles, depts, refine: true, templatesDir: __dirname, claude });

  assert.ok(plan.meeting.attendees.length >= 4);
  assert.ok(plan.meeting.attendees.length <= 5);
  assert.ok(plan.meeting.attendees.includes('product-manager'));
  assert.ok(plan.meeting.attendees.includes('engineering-backend-architect'));
  assert.ok(plan.meeting.attendees.includes('security-appsec-engineer') || plan.meeting.attendees.includes('testing-api-tester'));
  assert.deepEqual(plan.meeting.agenda, ['目标澄清', '方案推进', '反方质询', '风险复核', '经理裁决']);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `node --test "test/planner.test.js" --test-name-pattern "高风险复杂任务会议"`

Expected: FAIL，原因应为参会人数仍限制为 3 或 `agenda` 不存在。

- [ ] **Step 3: 最小实现**

在 `prependMeeting()` 中把参会选择上限从 3 改为根据流程决定：

```js
  const maxAttendees = plan.process && plan.process.risk_review ? 5 : 4;
```

把两处 `attendees.length < 3` 改为：

```js
attendees.length < maxAttendees
```

给 `plan.meeting` 增加议程：

```js
  plan.meeting = {
    attendees,
    meetIds: meetSteps.map((m) => m.id),
    decideId: 'decide_plan',
    mainDept: mainDept || '',
    mainDeptName: (mainDept && dName[mainDept]) || '',
    agenda: ['目标澄清', '方案推进', '反方质询', '风险复核', '经理裁决'],
    debateRounds: (plan.process && plan.process.debate_rounds) || 1,
  };
```

在 `fallbackComplexRolePlan()` 创建 `plan` 后、调用 `prependMeeting()` 前加入：

```js
  attachProcessMeta(plan, text, { lane: 'complex', confidence: 0.9, reason: plan.routing.reason }, roleMap);
```

- [ ] **Step 4: 运行通过测试**

Run: `node --test "test/planner.test.js" --test-name-pattern "高风险复杂任务会议|复杂股票交易网站"`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add planner.js test/planner.test.js
git commit -m "feat: strengthen complex meeting orchestration"
```

---

### Task 4: 编排决策日志与计划文件沉淀

**Files:**
- Modify: `D:/swap/orch/runner.js`
- Test: `D:/swap/orch/test/runner.test.js`

**Interfaces:**
- Consumes: `plan.process`
- Consumes: `plan.validation`
- Produces: event type `orchestration_decision`
- Produces: `task_plan.md` 中的 `## 编排决策`

- [ ] **Step 1: 写失败测试**

在 `test/runner.test.js` 追加：

```js
test('编排决策:规划完成后写事件并沉淀到task_plan', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-orchestration-decision-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('开发股票交易网站');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'engineering', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'backend', dept: 'engineering', name: '后端架构师', prompt: 'p', executor: 'claude' });
  const plan = {
    task: '开发股票交易网站',
    process: { type: 'risk_review', reason: '交易任务需要风险复核', manager_role: 'backend', debate_rounds: 1, risk_review: true },
    validation: { ok: true, errors: [], warnings: ['复杂计划角色较少'], repaired: false },
    steps: [{ id: 'build', role: 'backend', agent: 'claude', prompt: '实现', deps: [], expected_outcome: '完成实现' }],
  };
  const echo = { async run() { return { output: 'done', success: true }; } };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };

  await runTask(id, deps);

  const event = store.getEvents(id).find((e) => e.type === 'orchestration_decision');
  assert.ok(event, '应写入编排决策事件');
  const data = JSON.parse(event.data);
  assert.equal(data.process_type, 'risk_review');
  assert.match(data.reason, /风险复核/);
  const text = fs.readFileSync(path.join(dir, 'task_plan.md'), 'utf8');
  assert.match(text, /## 编排决策/);
  assert.match(text, /risk_review/);
  assert.match(text, /交易任务需要风险复核/);

  fs.rmSync(dir, { recursive: true, force: true });
});
```

若文件头部尚未引入 `fs`、`path`、`os` 或 `open`、`runTask`，复用现有 `runner.test.js` 已有导入，不重复声明。

- [ ] **Step 2: 运行失败测试**

Run: `node --test "test/runner.test.js" --test-name-pattern "编排决策"`

Expected: FAIL，原因应为事件或 `task_plan.md` 段落不存在。

- [ ] **Step 3: 最小实现**

在 `runner.js` 的 `writePlanFile()` 前加入：

```js
function orchestrationDecision(plan) {
  const process = (plan && plan.process) || {};
  const validation = (plan && plan.validation) || {};
  const meeting = (plan && plan.meeting) || {};
  return {
    process_type: process.type || '',
    reason: process.reason || '',
    manager_role: process.manager_role || '',
    attendees: meeting.attendees || [],
    agenda: meeting.agenda || [],
    validation_errors: validation.errors || [],
    validation_warnings: validation.warnings || [],
  };
}
```

在 `runTask()` 的 `store.setPlan(taskId, plan);` 后加入：

```js
  if (store.addEvent && plan && plan.process) store.addEvent(taskId, 'orchestration_decision', orchestrationDecision(plan));
```

在 `writePlanFile()` 中 `## 目标` 后、诊断段前插入：

```js
    if (plan.process) {
      const decision = orchestrationDecision(plan);
      lines.push('', '## 编排决策');
      lines.push('- 流程类型: ' + (decision.process_type || '-'));
      lines.push('- 编排理由: ' + (decision.reason || '-'));
      if (decision.manager_role) lines.push('- 经理/裁决角色: ' + decision.manager_role);
      if (decision.attendees.length) lines.push('- 参会员工: ' + decision.attendees.join('、'));
      if (decision.agenda.length) lines.push('- 会议议程: ' + decision.agenda.join('、'));
      decision.validation_errors.slice(0, 6).forEach((x) => lines.push('- 复核错误: ' + x));
      decision.validation_warnings.slice(0, 6).forEach((x) => lines.push('- 复核提醒: ' + x));
    }
```

- [ ] **Step 4: 运行通过测试**

Run: `node --test "test/runner.test.js" --test-name-pattern "编排决策"`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add runner.js test/runner.test.js
git commit -m "feat: record orchestration decisions"
```

---

### Task 5: 会议提示词升级为有界裁决

**Files:**
- Modify: `D:/swap/orch/runner.js`
- Test: `D:/swap/orch/test/meeting.test.js`

**Interfaces:**
- Consumes: `plan.meeting.agenda`
- Produces: 会议发言 prompt 包含 `目标澄清`、`方案推进`、`反方质询`、`风险复核`
- Produces: 会议总结 prompt 包含 `经理裁决`

- [ ] **Step 1: 写失败测试**

在 `test/meeting.test.js` 追加：

```js
test('会议室:复杂任务按有界辩论和经理裁决议程组织', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-agenda-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('开发股票交易网站');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  store.addRole({ id: 'qa', dept: 'eng', name: '验收员', prompt: '负责验收和风险质询', executor: 'claude' });
  const prompts = [];
  const echo = { async run({ prompt }) { prompts.push(prompt); return { output: '结构化发言', success: true }; } };
  const plan = {
    task: '开发股票交易网站',
    process: { type: 'risk_review', reason: '交易风险高', manager_role: 'arch', debate_rounds: 1, risk_review: true },
    steps: [
      { id: 'meet_arch', role: 'arch', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'meet_qa', role: 'qa', agent: 'claude', prompt: '风险质询', deps: [] },
      { id: 'decide_plan', role: 'arch', agent: 'claude', prompt: '综合方案', deps: ['meet_arch', 'meet_qa'] },
      { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { attendees: ['arch', 'qa'], meetIds: ['meet_arch', 'meet_qa'], decideId: 'decide_plan', agenda: ['目标澄清', '方案推进', '反方质询', '风险复核', '经理裁决'] },
  };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };

  await runTask(id, deps);
  await wait(60);
  await endMeeting(id, deps);

  assert.ok(prompts.some((p) => /目标澄清/.test(p) && /方案推进/.test(p) && /反方质询/.test(p) && /风险复核/.test(p)));
  assert.ok(prompts.some((p) => /经理裁决/.test(p) && /验收口径/.test(p) && /风险清单/.test(p)));
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行失败测试**

Run: `node --test "test/meeting.test.js" --test-name-pattern "有界辩论"`

Expected: FAIL，原因应为会议 prompt 缺少固定议程词。

- [ ] **Step 3: 最小实现**

在 `meetingSpeak()` 中读取计划和议程：

```js
  let plan = {}; try { plan = JSON.parse(task.plan) || {}; } catch (e) {}
  const agenda = (plan.meeting && plan.meeting.agenda && plan.meeting.agenda.length) ? plan.meeting.agenda.join('、') : '目标澄清、方案推进、反方质询、风险复核、经理裁决';
```

在发言 prompt 的会议目标后追加：

```js
    + '\n固定议程:' + agenda + '。本轮只做一轮有界讨论，不展开无限聊天。'
```

在 `endMeeting()` 中复用 `agenda`：

```js
  const agenda = (plan.meeting && plan.meeting.agenda && plan.meeting.agenda.length) ? plan.meeting.agenda.join('、') : '目标澄清、方案推进、反方质询、风险复核、经理裁决';
```

在总结 prompt 中加入：

```js
    + '\n固定议程:' + agenda + '。请以经理裁决收束，不要继续发散讨论。'
```

把总结结构要求补为：

```js
    + '\n\n请按固定 Markdown 结构输出:## 决议、## 行动项、## 验收口径、## 风险清单、## 待解决问题。行动项写清负责人(员工/部门)和交付物;待解决问题没有就写“无”。只输出《方案》正文，不要寒暄。'
```

- [ ] **Step 4: 运行通过测试**

Run: `node --test "test/meeting.test.js" --test-name-pattern "会议室"`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add runner.js test/meeting.test.js
git commit -m "feat: bound meeting discussion agenda"
```

---

### Task 6: 画布暴露流程和编排理由

**Files:**
- Modify: `D:/swap/orch/api.js`
- Modify: `D:/swap/orch/web/app.js`
- Modify: `D:/swap/orch/web/index.html`
- Test: `D:/swap/orch/test/api.test.js`

**Interfaces:**
- Consumes: `plan.process`
- Consumes: `plan.meeting.agenda`
- Produces: `api.plan()` 节点字段 `processType`、`processLabel`、`orchestrationReason`、`meetingAgenda`

- [ ] **Step 1: 写失败测试**

在 `test/api.test.js` 追加：

```js
test('plan 为画布节点返回流程类型和编排理由', () => {
  const store = open(':memory:');
  store.seed();
  const id = Number(store.createTask('开发股票交易网站', 'Trading'));
  store.setPlan(id, {
    process: { type: 'risk_review', reason: '交易任务需要风险复核', manager_role: 'engineering-backend-architect', debate_rounds: 1, risk_review: true },
    meeting: { agenda: ['目标澄清', '方案推进', '反方质询', '风险复核', '经理裁决'] },
    steps: [
      { id: 'risk_review', agent: 'codex', role: 'security-appsec-engineer', prompt: '风险复核', deps: [], expected_outcome: '风险复核完成' },
    ],
  });

  const row = api.plan(store, id)[0];
  assert.equal(row.processType, 'risk_review');
  assert.match(row.processLabel, /风险复核/);
  assert.match(row.orchestrationReason, /交易任务/);
  assert.match(row.meetingAgenda, /反方质询/);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `node --test "test/api.test.js" --test-name-pattern "流程类型和编排理由"`

Expected: FAIL，原因应为字段不存在。

- [ ] **Step 3: 最小实现**

在 `api.js` 的 `plan(store, id)` 中解析计划后增加：

```js
  const process = p.process || {};
  const processLabels = { fast: '快速执行', sequential: '顺序编排', hierarchical: '经理调度', debate: '有界辩论', risk_review: '风险复核', ask_user: '等待选择' };
  const meetingAgenda = p.meeting && Array.isArray(p.meeting.agenda) ? p.meeting.agenda.join('、') : '';
```

在 `out.push({ ... })` 增加字段：

```js
processType: process.type || '',
processLabel: processLabels[process.type] || '',
orchestrationReason: process.reason || '',
meetingAgenda,
```

在 `web/app.js` 中找到节点详情或日志弹层渲染处，追加显示逻辑：

```js
const processLine = node.processLabel ? `<div class="node-detail-line">流程：${escapeHtml(node.processLabel)}${node.orchestrationReason ? ' · ' + escapeHtml(node.orchestrationReason) : ''}</div>` : '';
const agendaLine = node.meetingAgenda ? `<div class="node-detail-line">会议议程：${escapeHtml(node.meetingAgenda)}</div>` : '';
```

把这两行插入节点详情内容中，不改节点布局主体。

如果 `web/index.html` 没有可复用样式，增加：

```css
.node-detail-line {
  font-size: 12px;
  color: #5f6673;
  line-height: 1.5;
  margin-top: 6px;
}
```

- [ ] **Step 4: 运行通过测试**

Run: `node --test "test/api.test.js" --test-name-pattern "流程类型和编排理由"`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add api.js web/app.js web/index.html test/api.test.js
git commit -m "feat: show orchestration process on canvas"
```

---

### Task 7: 全量验证和回归检查

**Files:**
- Verify only.

**Interfaces:**
- Consumes: 前 6 个任务全部提交后的代码。
- Produces: 测试结果、运行状态、人工验证结论。

- [ ] **Step 1: 运行规划测试**

Run: `node --test "test/planner.test.js"`

Expected: 所有 `planner.test.js` 测试通过。

- [ ] **Step 2: 运行会议测试**

Run: `node --test "test/meeting.test.js"`

Expected: 所有 `meeting.test.js` 测试通过。

- [ ] **Step 3: 运行 API 与 runner 测试**

Run: `node --test "test/api.test.js" "test/runner.test.js"`

Expected: 所有 API 和 runner 测试通过。

- [ ] **Step 4: 运行全量测试**

Run: `npm test`

Expected: 全量测试通过。

- [ ] **Step 5: 检查 diff 空白错误**

Run: `git diff --check`

Expected: 无输出。

- [ ] **Step 6: 重启本地服务**

先查端口：

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
```

如果存在旧进程，结束对应 PID：

```powershell
Stop-Process -Id <PID> -Force
```

启动：

```powershell
Start-Process -WindowStyle Hidden -FilePath node -ArgumentList 'server.js' -WorkingDirectory 'D:\swap\orch'
```

检查：

```powershell
Invoke-WebRequest http://localhost:3000 -UseBasicParsing | Select-Object StatusCode
```

Expected: `StatusCode` 为 `200`。

- [ ] **Step 7: 人工创建验证任务**

在页面创建任务：

```text
开发一个复杂的股票交易网站
```

Expected:

- 计划流程显示为风险复核或有界辩论。
- 编排画布显示具体员工而不是只有执行器。
- 会议触发，并显示固定议程。
- 节点详情能看到实时日志。
- 结束节点能显示耗时。
- `task_plan.md` 包含“编排决策”。

- [ ] **Step 8: 提交验证记录**

```powershell
git status --short
```

Expected: 只剩用户已有未提交修改或无新修改。

如需要把验证说明写入提交：

```powershell
git add docs/superpowers/plans/2026-07-05-multi-agent-orchestration.md
git commit -m "docs: add multi-agent orchestration implementation plan"
```
