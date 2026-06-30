# orch — 轻量 Agent 编排器

发一个任务，自动拆解并分配给 Claude / Codex 协作（并行分工 + 改测循环）。本地单人工具。

## 装 + 跑

```bash
cd orch
npm install
npm start              # 起 http://localhost:3000
```

浏览器开 `http://localhost:3000`，输入任务（如"写个把摄氏转华氏的函数并测试"）→ 发。
左侧看步骤状态变色，右侧看实时日志。

> 真跑需要本机已登录 `claude` 和 `codex` CLI（`claude -p`、`codex exec` 无头模式）。
> codex 较慢（约 20s/步），属正常。

## 怎么运作

- 一份 **plan**（步骤 + 依赖 + 派给谁）是核心。模板和 LLM 都只是生成 plan 的方式。
- 引擎拓扑调度：无依赖的步骤并发跑，有依赖的串行，`loop` 步骤做 Codex↔Claude 改测循环。
- 每步在独立 git worktree 里干活（非 git 仓回退共享目录）。

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
server.js     入口:express + ws,起服务
runner.js     串起 出plan→执行→落库,事件实时广播
planner.js    模板匹配 / 调 LLM 出 plan
engine.js     调度 + 循环(核心)
workspace.js  git worktree 隔离
store.js      SQLite 单文件
adapters/     claude / codex / echo + cli.js(公共 spawn 封装)
templates/    预设工作流 yaml
web/          单页前端
```
