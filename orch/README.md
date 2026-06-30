# orch — 轻量 Agent 编排器

发一个任务，自动拆解并分配给 Claude / Codex 协作（并行分工 + 改测循环）。本地单人工具。

## 装 + 跑

```bash
cd orch
npm install
npm start              # 起 http://localhost:3000
```

浏览器开 `http://localhost:3000`，进入 **Maestro 编排工作台**：点右上「新建任务」下发，
任务列表/详情看 Claude→Codex 接力与实时日志，总控台看真实指标与实时编排活动流，
编排画布看真实执行计划。**全部为 orch 真实数据**：agent=真实适配器(Claude/Codex),
部门=按 agent 角色派生(开发/QA),项目=按任务 project 字段聚合,人员=当前操作者。

> 真跑需要本机已登录 `claude` 和 `codex` CLI（`claude -p`、`codex exec` 无头模式）。
> codex 较慢（约 100s/步），属正常。

> ⚠️ **安全**：为让 agent 无人值守自主改文件/跑命令，适配器用了
> `claude --dangerously-skip-permissions` 和 `codex --dangerously-bypass-approvals-and-sandbox`，
> 即**绕过所有权限检查、无沙箱**。这是"自主编排器"的固有代价:派下去的任务能对工作目录做任何事。
> 只在你信任的工作目录/任务上用。

## 怎么运作

- 一份 **plan**（步骤 + 依赖 + 派给谁）是核心。模板和 LLM 都只是生成 plan 的方式。
- 引擎拓扑调度：无依赖的步骤并发跑，有依赖的串行，`loop` 步骤做 Codex↔Claude 改测循环（上游测试已过则自动跳过）。
- 同一任务各步骤共享一个工作目录，顺序产物（dev→test→fix）天然可见。
  （真验证发现 per-step worktree 会让下游看不到上游产物，故改共享；真正的并行隔离留作未来 opt-in。）

## 改 / 扩展

| 想干啥 | 改哪 |
|--------|------|
| 加预设工作流 | 往 `templates/` 加个 `.yaml`（照抄 `dev-test-fix.yaml`，`match` 为关键词，空串=兜底） |
| 加新 agent（gemini/aider…） | 往 `adapters/` 加个文件，导出 `run({prompt,workdir,onLine})=>{output,success}`，再在 `server.js` 的 `adapters` 注册 |
| 调循环上限 | 模板里 `max` |

## 测试

```bash
npm test              # node --test 全量,6 文件 12 用例
```

`adapters/echo.js` 是测试用假适配器（不烧 token），引擎/集成测试都用它。

## 结构

```
server.js     入口:express + ws,起服务,真实活动流广播
api.js        把真实 tasks/steps/logs 派生成 Maestro 前端数据(agents/部门/项目/人员)
runner.js     串起 出plan→执行→落库,事件实时广播
planner.js    模板匹配 / 调 LLM 出 plan
engine.js     调度 + 循环(核心)
workspace.js  工作区(共享目录)
store.js      SQLite 单文件
adapters/     claude / codex / echo + cli.js(公共 spawn 封装)
templates/    预设工作流 yaml
web/          Maestro 前端:index.html(模板) + runtime.js(迷你dc运行时) + app.js(逻辑+真接线)
```
