# orch v2 — 可配置多 Agent + 多人 + LLM 深度编排 设计文档

- 日期：2026-06-30
- 状态：已确认设计，待写实现计划
- 基线：orch v1（Maestro 前端 + 真实数据）已完成

## 1. 目标（修 4 个问题）

1. **#1 任务能下发并真跑**：画布上的「下发 / 批准并运行 / 重新编排」按钮当前是死的（无 onClick），只有右上「新建任务」能下发。补真下发入口；并支持 **LLM 深度拆解**，让"开发电商官网"这类大任务真正分解成多步多 agent 执行。
2. **#2 实时日志改为「每 agent 控制台」**：一个 agent 会跨任务并发干多件事，现按 step 看日志不对。Agent 详情页直播该 agent 所有并发活动，每行标注来源 `[T{id}·{step}]`。
3. **#3 可新建 agent**：agent 不再写死，改为数据驱动的 CLI 适配器配置。
4. **#4 可新建人员并分配 agent**：人员 CRUD + 人员↔agent 多对多分配（纯组织元数据，不门控执行）。

明确不做（YAGNI）：登录鉴权、权限门控、远程部署、agent 沙箱隔离。本地单人工具。

## 2. 数据模型（SQLite 新增表）

```sql
CREATE TABLE IF NOT EXISTS agents(
  id TEXT PRIMARY KEY, name TEXT, command TEXT, args TEXT,
  model TEXT, caps TEXT, color TEXT, avatar TEXT, dept TEXT);
CREATE TABLE IF NOT EXISTS people(
  id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT, color TEXT, av TEXT);
CREATE TABLE IF NOT EXISTS person_agents(
  person_id TEXT, agent_id TEXT, PRIMARY KEY(person_id, agent_id));
```

- `args`/`caps` 存 JSON 字符串（数组）。
- 首次启动 **seed**：
  - agents：`claude`（command `claude`，args `["-p","--dangerously-skip-permissions"]`，dept `dev`，color `#7C6FD9`，avatar `C`）、`codex`（command `codex`，args `["exec","--dangerously-bypass-approvals-and-sandbox","--skip-git-repo-check"]`，dept `qa`，color `#4F8BE8`，avatar `X`）。
  - people：一条操作者（id `op`，name 取环境用户名，role `操作者`）。
- tasks 表沿用 v1（含 project / 时间戳）。

## 3. #3 可配置 agent

- **通用 CLI 适配器** `adapters/generic.js`：`make(def) => { run({prompt,workdir,onLine}) }`，内部用现有 `cli.js` 的 `runCli(def.command, [...def.args, prompt], workdir, onLine)`。退出码 0 = 成功。
- **适配器注册表**：server 启动时从 `store.listAgents()` 构建 `adapters = { [agent.id]: generic.make(agent) }`；新增 agent 后刷新注册表（重建 map）。
- **API**：
  - `GET /api/agents`（已有，改为读 DB）
  - `POST /api/agents` body `{id?,name,command,args,model,caps,dept,color,avatar}` → 写库 + 刷新注册表 + 广播。
- **前端**：Agent 名册页右上「新建 Agent」→ 弹窗表单（名字 / 命令 / 参数(空格分隔) / 模型 / 能力(逗号分隔) / 颜色）→ POST → 刷新。
- **安全**：自定义命令的自主模式参数由用户自填；沿用 README 的"绕权限/无沙箱"提示。adapter 不额外加 flag。

## 4. #4 人员 + 分配

- **API**：
  - `GET /api/people`（改为读 DB，含已分配 agent id 列表 + 派生指标）
  - `POST /api/people` body `{name,email,role}` → 写库。
  - `POST /api/people/:id/agents` body `{agentIds:[...]}` → 覆盖式写 `person_agents`。
- **前端**：人员页右上「新建人员」→ 弹窗（姓名 / 邮箱 / 角色）；每行「分配 Agent」→ 弹窗勾选 agent 列表 → 保存。
- 纯元数据：不影响任务执行，不做权限校验。

## 5. #2 每 agent 实时控制台

- **WS log 事件加 `agent` 字段**：`runner` 的 `onLog` 已知 stepId→agent（plan 里有），broadcast log 事件带上 `agent`。
- **Agent 详情页**：暗色日志框直播 `state.agentConsole[agentId]` —— 累积该 agent 收到的所有 log 行，格式 `[T{taskId}·{stepId}] line`，保留最近 N 行，自动滚底。
- 进入 agent 详情时先 `GET /api/agentlog/:id`（历史，已有，返回带 task/step 标注的行），WS 实时追加。
- 全局事件流：保留总控台「实时编排活动」（v1 已是真实事件流）。

## 6. #1 下发 + LLM 深度拆解

### 下发入口
- **新建任务弹窗**（模板里新增一个 overlay）：目标 `textarea` + 项目 `input` + 模式单选（`模板` / `智能拆解`）+ 「下发」按钮。
- 接线全部死按钮 → 打开此弹窗或直接下发：
  - 右上「新建任务」、画布底「下发」、智能编排「批准并运行 / 重新编排」、部门「下发部门任务」。
  - 智能编排「描述目标」框改为可编辑 textarea，「批准并运行」用其内容下发。
- `POST /task` body 增加 `{text, project, mode}`，`mode` ∈ `template|llm`。

### LLM 深度拆解
- `planner.makePlan(text, {mode, agents, templatesDir, claude})`：
  - `mode==='llm'`：调 claude 产出 JSON plan。prompt 给出**可用 agent id 列表**与 plan schema（`{steps:[{id,agent,prompt,deps}], 可含 type:loop}`），要求 agent 只能取列表内 id。
  - 解析 + 校验：steps 非空、agent 均在可用列表、deps 引用存在；任一不过 → 回退模板。
  - `mode==='template'` 或回退：走现有 `dev-test-fix.yaml`。
- 引擎无需改：已支持任意 DAG + loop + 并发就绪步骤。多步多 agent → agent 跨步骤/跨任务并发。

## 7. 并发模型

- 多任务并发：每个 `POST /task` 独立 `runTask`，互不阻塞。
- 单任务内：引擎按波次并发跑就绪步骤。
- 同一 agent 可同时出现在多个并发步骤/任务 → 每 agent 控制台聚合直播即为此设计。
- 不做 per-agent 串行队列（YAGNI）；CLI 子进程各自独立。

## 8. 错误处理

- LLM plan 解析失败 / 校验不过 → 回退模板，前端无感。
- 未知 agent id（plan 引用了已删 agent）→ 该步骤标 failed，下游停。
- 新建 agent 命令不存在 → 运行时 cli `error` 事件 → 步骤 failed + 日志记错误。
- 表单必填校验（名字 / 命令）在前端做。

## 9. 测试

- 保留现有 12 个测试。
- 新增：
  - `store` agents/people/分配 的增查（含 seed）。
  - `generic` 适配器：用 `node -e` 作为 command 跑一条，验证退出码与 stdout 收集。
  - `planner` LLM 模式：假 claude 返回合法/非法 JSON，验证解析与回退。

## 10. 涉及文件

```
orch/
  store.js        + agents/people/person_agents 表、seed、增查方法
  adapters/
    generic.js    新增:数据驱动通用 CLI 适配器
  api.js          agents/people 改为读 DB;people 带分配
  planner.js      + LLM 模式(可用 agent 注入 + 校验 + 回退)
  runner.js       log 事件带 agent 字段
  server.js       + POST /api/agents、/api/people、/api/people/:id/agents;适配器注册表从 DB 构建+刷新;POST /task 收 mode
  web/
    index.html    + 新建任务/新建Agent/新建人员/分配 弹窗;接线死按钮;智能编排目标可编辑
    app.js        弹窗状态与提交、每 agent 控制台直播、各 fetch
  test/           + store/generic/planner 新测试
```
