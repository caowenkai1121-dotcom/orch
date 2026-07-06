# 员工能力、会议讨论、知识检索增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 参考 agency-agents-zh 与 Tolaria，加强员工角色卡利用、方案会议质量，以及文件化知识上下文检索注入。

**Architecture:** 保持现有 CommonJS 单体结构，不新增依赖、不改数据库结构。`planner.js` 继续负责规划期员工能力摘要；`runner.js` 负责会议发言、会议总结和任务工作目录内 Markdown 知识检索。

**Tech Stack:** Node.js CommonJS、Express、better-sqlite3、node:test、原生 fs/path。

## Global Constraints

- 全程中文沟通。
- 外科式最小改动，不重写文件，不引入第三方依赖。
- 生产代码先写失败测试，再实现。
- 服务端改动完成后跑 `npm test`，重启 `http://localhost:3000` 并验证 `err.log` 为空。

---

### Task 1: 员工能力摘要增强

**Files:**
- Modify: `planner.js`
- Test: `test/planner.test.js`

**Interfaces:**
- Consumes: `roleCapability(role)` 从 `role.prompt` 提取角色卡段落。
- Produces: 总调度员工目录包含关键规则、工作流程、交付物、判定、交接摘要。

- [ ] **Step 1: Write the failing test**

在 `test/planner.test.js` 增加测试，构造包含 `【关键规则】`、`【工作流程】`、`【交接】` 的角色卡，捕获 `makePlan()` 调度 prompt，断言目录中包含 `规则:`、`流程:`、`交接:`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "test/planner.test.js" --test-name-pattern "员工模式:总调度目录包含关键规则流程与交接摘要"`

Expected: FAIL，因为当前 `roleCapability()` 未输出关键规则和交接摘要。

- [ ] **Step 3: Write minimal implementation**

修改 `roleCapability()`，复用 `roleSection()` 提取 `关键规则`、`工作流程`、`交付物标准`、`判定`、`交接`，截断后拼进目录摘要。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "test/planner.test.js" --test-name-pattern "员工模式:总调度目录包含关键规则流程与交接摘要"`

Expected: PASS。

### Task 2: 会议讨论结构化

**Files:**
- Modify: `runner.js`
- Test: `test/meeting.test.js`

**Interfaces:**
- Consumes: `meetingSpeak(deps, taskId, roleId, kickoff)` 现有会议发言入口。
- Produces: 发言 prompt 要求按观点、风险、建议、待确认项发言；结束会议 prompt 要求输出决议、行动项、验收口径、风险、待解决问题。

- [ ] **Step 1: Write the failing test**

在 `test/meeting.test.js` 增加测试，fake adapter 记录 prompt，断言会议发言 prompt 包含 `观点/风险/建议/待确认项`，结束会议 prompt 包含 `决议`、`行动项`、`待解决问题`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "test/meeting.test.js" --test-name-pattern "会议室:发言与总结按结构化议程收敛"`

Expected: FAIL。

- [ ] **Step 3: Write minimal implementation**

修改 `meetingSpeak()` 与 `endMeeting()` 的 prompt 文案，不改变状态机和数据库。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "test/meeting.test.js" --test-name-pattern "会议室:发言与总结按结构化议程收敛"`

Expected: PASS。

### Task 3: Tolaria 式文件化知识检索

**Files:**
- Modify: `runner.js`
- Test: `test/meeting.test.js`

**Interfaces:**
- Produces: `searchTaskKnowledge(dir, query, limit)`，只读任务目录内 Markdown 文档，按查询词命中排序，返回片段。
- Consumes: `meetingSpeak()` 与 `endMeeting()` 把检索到的片段注入会议上下文。

- [ ] **Step 1: Write the failing test**

在会议测试的任务目录写入 `项目约定.md`，内容包含与任务相关的关键词；触发会议发言与结束会议，断言 adapter prompt 包含 `【知识检索】` 和文档片段。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "test/meeting.test.js" --test-name-pattern "会议室:注入任务目录Markdown知识检索片段"`

Expected: FAIL。

- [ ] **Step 3: Write minimal implementation**

在 `runner.js` 新增小型 Markdown 检索函数，只扫描当前任务目录下 `.md` 文件，排除 `会议记录.md`、`方案.md`、`task_plan.md`，限制文件数、片段长度和总长度；会议发言与总结注入检索结果。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "test/meeting.test.js" --test-name-pattern "会议室:注入任务目录Markdown知识检索片段"`

Expected: PASS。

### Task 4: 全量验证

**Files:**
- Verify only.

- [ ] Run `node --test "test/planner.test.js"`.
- [ ] Run `node --test "test/meeting.test.js"`.
- [ ] Run `npm test`.
- [ ] Restart PID listening on port 3000.
- [ ] Verify `Invoke-WebRequest http://localhost:3000` returns 200 and `err.log` remains 0 bytes.
