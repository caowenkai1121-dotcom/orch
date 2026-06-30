# orch v4 — 调研驱动的优化迭代设计（取消/并发/成本/预算/审批/隔离）

- 日期：2026-06-30
- 状态：已确认范围"全做(含容器隔离,opt-in)",待写实现计划
- 依据：deep-research 报告(24 源/21 确认主张)。基线 orch v3。

## 1. 目标（按优先级，全做）

研究结论 → orch 的迭代项。核心原则:**保持轻量**(不强依赖 Docker、不引 Langfuse/Postgres),容器隔离做成 opt-in。

- **P0-1 任务取消/停止 + 事件溯源 + 运行历史**：补市场最痛短板("跑飞烧 token、无法中断")。
- **P0-2 并发上限**：信号量限同时运行的 agent 子进程,防压垮单机(竞品有 5–7 会话墙)。
- **P0-3 token/成本统计**：从 `claude -p --output-format stream-json` 摄取真实 usage/cost,codex 按定价估算;落库 + 面板显示。
- **P1-1 预算熔断**：项目/任务设 token 预算,超限自动停(依赖 P0-3)。BAMAS 证明成本设为一等约束可省至多 86%。
- **P1-2 可选审批门 + 可编辑计划**：仿 OpenHands ConfirmationPolicy。审批模式下计划生成后暂停待批,UI 可改步骤/依赖再批准运行(顺带覆盖"依赖可视化编辑")。默认仍全自动以保持现定位。
- **P2-1 git worktree 隔离**：任务在 git 仓内时,可选每任务独立 worktree/分支,完成后留待人工 merge。
- **P2-2 opt-in 容器隔离**：诚实范围——claude/codex CLI 依赖宿主登录态,塞进容器不现实;故容器隔离只对**自定义 agent**(用户建的 CLI,如自带镜像的工具)开放:任务设 `隔离=容器` 且 Docker 可用时,该 agent 命令在 `docker run -v <任务目录>:/work` 内执行;Docker 不可用则回退本地并告警。

## 2. 数据模型（SQLite 新增/改）

```sql
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, task_id INTEGER, ts TEXT, type TEXT, data TEXT);   -- append-only 事件流
CREATE TABLE IF NOT EXISTS usage(
  id INTEGER PRIMARY KEY, task_id INTEGER, step_id TEXT, agent TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cost REAL, ts TEXT);
```
- tasks 加列：`budget REAL`(token 预算,0/NULL=不限)、`approve INTEGER`(0/1 审批模式)、`isolate TEXT`('none'|'worktree'|'container')。
- agents 加列：`pricing TEXT`(JSON `{in,out}` 每百万 token 单价,用于 inferred 成本;claude/codex seed 给默认价)。

## 3. P0-1 取消/停止 + 事件 + 历史

- **运行态注册表**(server 内存)：`runs = Map(taskId → { cancelled:false, children:Set<ChildProcess> })`。
- **cli.js**：`runCli` 返回的 promise 之外,通过回调把 spawn 的 child 注册到当前 step 的 ctx,以便取消时杀。改 `runCli(cmd,args,workdir,onLine,onChild)`;`onChild(child)` 把 child 交给上层登记。
- **engine**：`ctx.onChild(child)` 登记到 runs[taskId].children;每个 step 开始前检查 `ctx.isCancelled()`,为真则跳过剩余步骤、整体置 failed/cancelled。
- **取消**：`POST /task/:id/cancel` → `runs[id].cancelled=true` + 杀所有 children(Windows: `taskkill /T /F /PID <pid>`,跨平台用 `child.kill()` 兜底)+ `store.setTaskStatus(id,'cancelled')` + 事件。
- **事件落库**：runner 的 onEvent 同时 `store.addEvent(taskId,type,data)`(plan/status/task/cancel)。log 不进 events(太碎,已在 logs 表)。
- **历史**：tasks 表已持久;任务详情可读 events 还原时间线。新增 `GET /api/events/:id`。任务列表已是历史。

## 4. P0-2 并发上限

- **engine 模块级信号量**:`createSemaphore(n)`,`runStep` 执行体用 `await sem.acquire(); try{...}finally{sem.release()}` 包裹。全进程共享(跨任务),默认 `ORCH_CONCURRENCY||3`。
- 波次调度不变,只是同时真正 spawn 的步骤被信号量限流排队。

## 5. P0-3 token/成本统计

- **claude 适配器**改用 `claude -p --output-format stream-json --verbose`:stdout 每行一个 JSON 事件。adapter 解析:
  - `assistant`/`content` 类事件 → 提取文本 `onLine`(保留实时控制台)。
  - 末尾 `result` 事件含 `usage`(input/output tokens)与 `total_cost_usd` → 通过 `onUsage({input,output,cost})` 上报。
  - 成败仍按退出码;解析失败回退纯文本。
- **codex / 自定义**:无结构化 usage → inferred:按 `agent.pricing` × 估算 token(用输出字符数/4 粗估),`onUsage` 上报(标 estimated)。
- **engine/runner**:`ctx.onUsage(stepId, agent, u)` → `store.addUsage(...)` + 广播。
- **api/前端**:总控台加"今日 token/成本"指标;任务详情显示该任务累计 token/¥;agent 详情显示其累计。
- ponytail: claude 精确、codex 估算;够用,后续可细化。

## 6. P1-1 预算熔断

- 新建任务可填 `budget`(token 上限)。每次 `addUsage` 后,若该任务累计 token > budget>0 → 自动 `cancel`(复用 P0-1)+ 事件"预算超限熔断"。
- 项目级预算(可选,后续):暂只做任务级。

## 7. P1-2 审批门 + 可编辑计划

- 新建任务勾"逐步审批"(approve=1)。runner:出 plan 后若 approve → `setTaskStatus 'awaiting'` + 存 plan + 广播,**不执行**,等 `POST /task/:id/approve {plan?}`(可带改过的 plan)→ 用(改后)plan 执行。
- 前端:编排画布"智能编排"的执行计划在 awaiting 态可编辑(改每步 agent 下拉/prompt/删步)+"批准并运行"(接线现有死按钮)/"取消"。
- 覆盖"依赖可视化编辑":审批态下可增删步骤与依赖(简单表单式,非画布拖拽)。

## 8. P2-1 git worktree 隔离

- workspace 加 `worktreeDir(repo, taskId)`:`git worktree add -B orch/task-<id> <dir>`(dir 在 data 下或 worktrees/),返回该 dir。
- 任务 `isolate==='worktree'` 且 ROOT 是 git 仓时用之;否则回退现 data 目录。完成后不自动 merge(留人工),仅告知分支名。

## 9. P2-2 容器隔离(opt-in,仅自定义 agent)

- 任务 `isolate==='container'`:对**非 claude/codex** 的自定义 agent,其命令改为 `docker run --rm -v <taskdir>:/work -w /work <agent.image||agent.command 所需镜像> <command args... prompt>`。
- agents 加列 `image TEXT`(容器镜像名);无 image 或 Docker 不可用(`docker --version` 失败)→ 回退本地 + 日志告警。
- claude/codex 始终本地(依赖宿主登录)。诚实记录此限制于 README。

## 10. 错误处理

- 取消:杀进程后该 step 标 cancelled;事件记录;前端任务转"已取消"。
- stream-json 解析异常:回退按纯文本 onLine + 成本记 0(不阻断)。
- 预算超限:熔断=取消,不抛错。
- 审批超时:无超时,一直等(用户可取消)。
- Docker 不可用:回退本地,不报错。
- 信号量:release 放 finally,防泄漏。

## 11. 测试

保留现有 32。新增:
- store:addEvent/getEvents、addUsage/任务累计、tasks 新列默认值、addAgent 带 pricing/image。
- engine:信号量限并发(并发数不超 N)、取消标志使后续 step 不跑、onUsage 透传。
- cli/adapters:stream-json 解析(喂样例 JSON 行 → 提取文本 + usage);inferred 成本估算。
- runner:审批态出 plan 后不执行直到 approve;预算超限触发取消。

## 12. 涉及文件

```
orch/
  store.js       events/usage 表 + 方法;tasks 加 budget/approve/isolate;agents 加 pricing/image
  engine.js      信号量;取消检查;onUsage/onChild 透传
  adapters/
    cli.js       runCli 暴露 child(onChild)
    claude.js    stream-json 解析(文本+usage) —— 不再走 generic,改专用解析
    streamparse.js 新增:claude stream-json 行解析工具
    generic.js   inferred 成本(按 pricing 估)+ 容器执行分支
  planner.js     (不变)
  runner.js      事件落库;onUsage;审批暂停;预算熔断;取消感知
  workspace.js   worktreeDir + 容器命令构造辅助
  server.js      /task/:id/cancel、/approve;/api/events;并发配置;运行态注册表;usage 广播
  api.js         成本/历史聚合到 buildAll(今日成本等);任务/agent 累计
  web/           取消/停止按钮;成本指标;审批可编辑计划;新建任务加 预算/审批/隔离 选项
  test/          上述新测试
  README.md      新功能 + 容器隔离限制说明
```
