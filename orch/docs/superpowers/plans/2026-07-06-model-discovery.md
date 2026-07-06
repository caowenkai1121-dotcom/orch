# Model Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自动发现 Claude、Codex 与 OpenAI 兼容 API Agent 的真实模型候选，减少用户手填模型 ID。

**Architecture:** 新增一个小型 `model_discovery.js` 模块，负责读取本机 CLI 配置与调用 API `/models`。服务端提供只读接口，前端 Agent 团队与新建任务模型选择复用该接口结果；执行层不改。

**Tech Stack:** Node.js、Express、better-sqlite3、原生 `fetch`、现有前端运行时。

## Global Constraints

- 不新增第三方依赖。
- 不读取或输出任何 API key/token/password 明文。
- 不在轮询 `/api/all` 中做网络模型扫描，避免拖慢页面。
- 执行侧继续使用现有 `engine.js` 模型安全清洗。

---

### Task 1: 模型发现模块与接口

**Files:**
- Create: `model_discovery.js`
- Modify: `server.js`
- Test: `test/model_discovery.test.js`

**Interfaces:**
- Produces: `async discoverModels(store, opts)` returns `{ agents: { [agentId]: { current, options, source, error } } }`
- Produces: `GET /api/agents/model-discovery`

- [ ] Write failing tests for Codex config, Claude config, and OpenAI-compatible `/models`.
- [ ] Implement config parsing and API model discovery.
- [ ] Add Express route without exposing secrets.
- [ ] Run `node --test test/model_discovery.test.js`.

### Task 2: 前端使用自动发现模型

**Files:**
- Modify: `web/app.js`
- Modify: `web/index.html`

**Interfaces:**
- Consumes: `live.modelDiscovery.agents[agentId].options`
- Produces: model dropdowns sourced from discovered values plus current saved value.

- [ ] Update `modelPickers()` to generate pickers from selected CLI agents instead of hardcoded Claude/Codex only.
- [ ] Fetch model discovery once after app load/login and allow manual refresh.
- [ ] Keep fallback: scan failed时仍显示已保存模型和“默认”。

### Task 3: Verification

**Files:**
- No production file changes expected.

- [ ] Run `node --test test/model_discovery.test.js`.
- [ ] Run `npm test`.
- [ ] Run `git diff --check`.
- [ ] Restart `http://localhost:3000`.
