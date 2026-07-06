# Meeting Auto Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会议首轮讨论结束后自动判定是否达成一致；一致则自动结束会议并执行，分歧则转用户裁决。

**Architecture:** 复用现有会议和 `awaiting_input` 机制，在 `runner.js` 增加轻量主持人判定函数。`openMeeting()` 的首轮员工发言完成后触发判定，`resumeTask()` 在用户裁决后把答案写入会议记录并结束会议。

**Tech Stack:** Node.js commonjs，现有 `node --test`，不新增依赖。

## Global Constraints

- 只修改 `runner.js` 和 `test/meeting.test.js`。
- 不新增第三方依赖。
- 不重写会议、执行器、前端大结构。
- 自动会议只做一轮有界判定；不引入无限多轮讨论。

---

### Task 1: 自动共识收束

**Files:**
- Modify: `test/meeting.test.js`
- Modify: `runner.js`

**Interfaces:**
- Consumes: `openMeeting(taskId, deps)`, `endMeeting(taskId, deps)`, `store.setTaskDecision(id, stepId, question)`
- Produces: `judgeMeeting(taskId, deps, reason)` 内部函数，输出 `{ status, reason, question }`

- [x] **Step 1: Write the failing tests**

Add tests that verify:

```js
// 1. 首轮发言后，主持人 JSON 返回 consensus，会议自动 closed，任务继续到 done。
// 2. 首轮发言后，主持人 JSON 返回 needs_user_decision，任务进入 awaiting_input。
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- test/meeting.test.js`

Expected: FAIL because auto-close behavior does not exist.

- [x] **Step 3: Write minimal implementation**

Add a small JSON parser and `judgeMeeting()` in `runner.js`; call it after initial attendees finish speaking.

- [x] **Step 4: Run meeting tests**

Run: `npm test -- test/meeting.test.js`

Expected: PASS.

- [x] **Step 5: Run full tests**

Run: `npm test`

Expected: PASS.
