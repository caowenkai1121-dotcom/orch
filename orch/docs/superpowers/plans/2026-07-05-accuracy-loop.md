# 智能体准确性闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `orch` 的规划、执行和知识检索形成更硬的准确性闭环,减少含糊计划、执行漂移和上下文不一致。

**Architecture:** 保持现有 `planner.js`、`engine.js`、`runner.js` 边界不变。规划期增强结构体检,执行期统一交付契约,任务目录 Markdown 知识检索从会议扩展到普通执行步骤。

**Tech Stack:** CommonJS, Node.js `node:test`, Express runtime, better-sqlite3;不新增第三方依赖。

## Global Constraints

- 只修改 `D:\swap\orch`,不触碰 `D:\channl`。
- 不新增依赖,不改项目入口、环境变量或数据库 schema。
- 所有生产代码改动必须先有失败测试。
- 修改后必须运行 `npm test`、`git diff --check`,并重启 `http://localhost:3000` 验证 HTTP 200 与 `err.log` 为空。

---

### Task 1: 计划体检增强

**Files:**
- Modify: `D:\swap\orch\planner.js`
- Test: `D:\swap\orch\test\planner2.test.js`

**Interfaces:**
- Consumes: `lintPlan(plan, hasRole)`
- Produces: `lintPlan` 额外报告缺少可执行 prompt 的叶子步骤;`makePlan` 在员工模式也会对首版合法 role 计划做结构体检,必要时带问题回喂重拆一次。

- [ ] **Step 1: Write failing test**

```js
test('计划体检:叶子步骤缺 prompt 会被回喂重拆', async () => {
  let call = 0;
  const claude = { async run() {
    call++;
    return call === 1
      ? { output: '{"steps":[{"id":"a","role":"r1","deps":[]}]}', success: true }
      : { output: '{"steps":[{"id":"a","role":"r1","prompt":"写入 a.md 并说明验收","deps":[]}]}', success: true };
  } };
  const roles = [{ id: 'r1', dept: 'dev', name: 'Dev', description: '', prompt: '角色', executor: 'claude' }];
  const plan = await makePlan('做个东西', { mode: 'llm', agents: ['claude'], roles, depts: [], refine: false, templatesDir: TPL, claude });
  assert.equal(call, 2);
  assert.match(plan.steps[0].prompt, /写入 a\.md/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "test/planner2.test.js" --test-name-pattern "计划体检:叶子步骤缺 prompt 会被回喂重拆"`

Expected: FAIL,因为现有员工模式首版 role 合法时不会因缺 prompt 回喂。

- [ ] **Step 3: Minimal implementation**

在 `lintPlan` 中检查非 loop 叶子步骤的 `prompt` 是否为空;在员工模式首版计划通过 role 合法性后也读取 `lintPlan(p, true)`,若有问题则构造反馈重拆一次。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "test/planner2.test.js" --test-name-pattern "计划体检:叶子步骤缺 prompt 会被回喂重拆"`

Expected: PASS。

### Task 2: 统一执行契约

**Files:**
- Modify: `D:\swap\orch\engine.js`
- Test: `D:\swap\orch\test\engine2.test.js`

**Interfaces:**
- Consumes: `ASK`, `AUTONOMY`, `runPlan`
- Produces: 问我模式也包含真实落盘、验证和交接备忘要求;允许确实无法默认时输出 `NEED_DECISION`。

- [ ] **Step 1: Write failing test**

```js
test('问我模式仍注入交付铁律与交接备忘', async () => {
  let seen = '';
  const a = { async run({ prompt }) { seen = prompt; return { output: 'ok', success: true }; } };
  await runPlan({ steps: [{ id: 's', agent: 'a', prompt: 'p', deps: [] }] }, ctx({ a }, { askMode: true, preamble: require('../engine').ASK }));
  assert.match(seen, /交付铁律/);
  assert.match(seen, /真实写入磁盘文件/);
  assert.match(seen, /交接备忘/);
  assert.match(seen, /NEED_DECISION/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "test/engine2.test.js" --test-name-pattern "问我模式仍注入交付铁律与交接备忘"`

Expected: FAIL,因为现有 `ASK` 没有完整交付铁律。

- [ ] **Step 3: Minimal implementation**

提取共享执行纪律文本,让 `AUTONOMY` 与 `ASK` 同时复用;`ASK` 仅增加“必要时可问”的例外。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "test/engine2.test.js" --test-name-pattern "问我模式仍注入交付铁律与交接备忘"`

Expected: PASS。

### Task 3: Tolaria 式 Markdown 检索增强

**Files:**
- Modify: `D:\swap\orch\runner.js`
- Test: `D:\swap\orch\test\meeting.test.js`, `D:\swap\orch\test\runner.test.js`

**Interfaces:**
- Consumes: `searchTaskKnowledge(dir, query, limit)`
- Produces: 检索不会因单个未命中文件提前终止同目录扫描;普通执行步骤的任务简报也注入任务目录 Markdown 知识片段,并标明只当上下文资料。

- [ ] **Step 1: Write failing search test**

```js
test('会议室:知识检索跳过未命中文件继续扫描后续Markdown', async () => {
  // 在同一目录写 a.md 无关、b.md 含 UNIQUE_KNOWLEDGE,结束会议时 prompt 应包含 b.md。
});
```

- [ ] **Step 2: Write failing execution test**

```js
test('执行步骤:注入任务目录Markdown知识检索片段', async () => {
  // 任务目录写 项目知识.md,执行普通 step 时 adapter prompt 应包含【知识检索】与命中片段。
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test "test/meeting.test.js" --test-name-pattern "会议室:知识检索跳过未命中文件继续扫描后续Markdown"`  
Run: `node --test "test/runner.test.js" --test-name-pattern "执行步骤:注入任务目录Markdown知识检索片段"`

Expected: both FAIL。

- [ ] **Step 4: Minimal implementation**

把 `searchTaskKnowledge` 中未命中分支从 `return` 改为继续扫描;导出该函数以便执行层复用。新增 `ctx.knowledge(stepId)` 钩子,`engine.runStep` 在任务简报中注入知识片段。`runner.execute` 提供基于任务目标、步骤 id、步骤角色的检索实现。

- [ ] **Step 5: Run tests to verify they pass**

Run: 上述两个测试命令。

Expected: both PASS。

### Task 4: Final Verification

**Files:**
- No additional production changes.

- [ ] Run: `npm test`
- [ ] Run: `git diff --check`
- [ ] Restart `D:\swap\orch` service on port 3000 by PID.
- [ ] Verify: single listener, HTTP 200, `D:\swap\orch\err.log` length 0.
- [ ] Write a short progress note to `D:\note\00_收件箱` after reading `D:\note\AGENTS.md` rules.
