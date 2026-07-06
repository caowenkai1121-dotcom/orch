# Intent Routing Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让规划器像 Codex 一样：高置信任务直接判断，低置信任务先让用户选择规划模式，复杂任务不再静默降级成单步。

**Architecture:** 在 `planner.js` 增加本地意图路由结果，输出 `routing` 与 `planning_stats`；在规划失败时对复杂任务生成多员工保底计划并开会；在 `runner.js` 识别待确认计划并暂停任务；在 API 和前端画布显示判定依据与确认选项。

**Tech Stack:** Node.js CommonJS、Express、SQLite、现有前端模板系统；不新增依赖。

## Global Constraints

- 只修改 `D:\swap\orch`。
- 不新增第三方依赖。
- 先写红灯测试，再实现。
- 不重写大文件，只做就近小改。
- 复杂任务不能 fallback 成裸单步。
- 歧义任务必须给用户选择，不擅自执行。

---

### Task 1: 规划器意图路由

**Files:**
- Modify: `D:/swap/orch/planner.js`
- Test: `D:/swap/orch/test/planner.test.js`

**Interfaces:**
- Produces: `assessIntent(text)` 返回 `{ lane, confidence, reason, options? }`
- Produces: `makePlan()` 返回 `plan.routing` 与 `plan.planning_stats.route`

- [ ] **Step 1: Write failing tests**
  - `股票交易网站` 应进入复杂员工编排或复杂保底编排，不能 `fallback`，不能单步。
  - `做一个网站` 应返回 `awaiting_route_choice`，带 A/B/C 选项。

- [ ] **Step 2: Run red tests**
  - `node --test test/planner.test.js`

- [ ] **Step 3: Implement minimal planner changes**
  - 增加 `assessIntent`。
  - 高置信简单任务走快速规划。
  - 高置信复杂任务不细化成单文件，不允许 fallback 单步。
  - 低置信任务返回待用户选择计划。

- [ ] **Step 4: Run green tests**
  - `node --test test/planner.test.js`

### Task 2: 复杂任务保底多员工会议

**Files:**
- Modify: `D:/swap/orch/planner.js`
- Test: `D:/swap/orch/test/planner.test.js`

**Interfaces:**
- Produces: `fallbackComplexRolePlan(text, roles, ...)`

- [ ] **Step 1: Write failing tests**
  - 模拟员工 LLM 失败时，复杂任务仍生成多角色计划并包含 `meeting`。

- [ ] **Step 2: Implement minimal fallback plan**
  - 按可用员工选择产品/架构/设计/前端/后端/安全或测试角色。
  - 复用 `prependMeeting`、`resolveRoles`、`ensureStepContracts`。

- [ ] **Step 3: Run tests**
  - `node --test test/planner.test.js`

### Task 3: 待确认任务暂停与前端选项

**Files:**
- Modify: `D:/swap/orch/runner.js`
- Modify: `D:/swap/orch/server.js`
- Modify: `D:/swap/orch/api.js`
- Modify: `D:/swap/orch/web/app.js`
- Modify: `D:/swap/orch/web/index.html`
- Test: `D:/swap/orch/test/runner.test.js`
- Test: `D:/swap/orch/test/api.test.js`

**Interfaces:**
- Consumes: `plan.routing.lane === 'needs_choice'`
- Produces: task status `awaiting_input`
- Produces: `POST /task/:id/route-choice`

- [ ] **Step 1: Write failing tests**
  - 低置信计划让任务进入 `awaiting_input`，不执行步骤。
  - API 暴露选择项。

- [ ] **Step 2: Implement pause and choice endpoint**
  - runner 遇到待选择计划时写事件和 task message，然后暂停。
  - endpoint 根据 A/B/C 重新调用 `makePlan` 并继续。

- [ ] **Step 3: Add small frontend controls**
  - 画布/任务区显示 A/B/C 选择按钮。

- [ ] **Step 4: Run tests**
  - `node --test test/runner.test.js test/api.test.js`

### Task 4: 验证

- [ ] `npm test`
- [ ] `git diff --check`
- [ ] 重启 `http://localhost:3000`
- [ ] Playwright 检查画布显示员工、判定依据和确认选项。
