# 轻量 Agent 编排器 `orch` — 设计文档

- 日期：2026-06-30
- 状态：已确认设计，待写实现计划

## 1. 目标

一个**轻量**的本地单人工具：用户发一个任务，编排器把任务拆解、分配给不同的 AI 编码 agent（Claude、Codex），支持：

1. **并行分工**：多个 agent 同时干不同的活（A 开发 / B 测试）。
2. **跨 agent 协作循环**：Codex 做功能验证测试 → 把问题反馈给 Claude → Claude 修复 → 回传 Codex 复测 → 循环，直到通过或达上限。
3. **混合编排**：常用场景走预设模板，复杂任务调 LLM 动态拆解。

明确不做（YAGNI）：登录鉴权、多用户、看板拖拽、前端框架、远程部署。本地单人。

## 2. 核心洞察

LLM 拆解和模板的产物是**同一种东西**：一份 `plan`（步骤列表 + 每步派给谁 + 依赖关系）。

因此全系统只有**一个执行引擎**。模板和 LLM 只是两种"生成 plan"的方式。这是保持轻量的关键设计决策。

## 3. 技术选型（已确认）

| 维度 | 选择 |
|------|------|
| 后端 | Node（express + ws + child_process.spawn） |
| 前端 | 单页 HTML + 原生 JS + WebSocket，无框架 |
| 支持 agent | Claude + Codex（适配器模式，可插件式扩展） |
| 并行隔离 | git worktree（每步一个，完成后 merge）；非 git 仓回退到子目录 |
| 存储 | SQLite 单文件 |

## 4. 架构

6 个小模块，各管一件事：

```
web/         单页 HTML + 原生JS + WebSocket（看任务/plan/日志）
  │ REST + WS
server       express + ws
  │   - POST /task   建任务
  │   - WS /stream   实时推日志 + 状态
  ├── planner   模板 / LLM → 出 plan
  ├── engine    调度（并行/串行）+ loop 循环
  ├── adapters  claude / codex（可插件）
  ├── store     SQLite 单 .db
  └── workspace git worktree 隔离 → 完事 merge
```

每个模块一个清晰职责，通过明确接口通信，可独立理解和测试。

## 5. plan 数据结构（系统的心脏）

```json
{
  "task": "加登录功能",
  "steps": [
    {"id": "dev",  "agent": "claude", "prompt": "实现登录API", "deps": []},
    {"id": "test", "agent": "codex",  "prompt": "写测试并跑",  "deps": ["dev"]},
    {"id": "fixloop", "type": "loop", "until": "pass", "max": 3, "deps": ["test"],
     "body": [
       {"id": "fix",    "agent": "claude", "prompt": "按失败修复: {prev}"},
       {"id": "retest", "agent": "codex",  "prompt": "重跑测试"}
     ]}
  ]
}
```

- **模板** = 手写的这份结构，放 `templates/*.yaml`。
- **LLM** = 调 `claude -p` 让它吐这份 JSON。
- 引擎只认这个结构：
  - `deps` 为空的步骤**并发**执行（A 开发 / B 测试）。
  - 有依赖的步骤串行。
  - `type: "loop"` 实现 Codex↔Claude 改测循环。
  - `{prev}` 占位符：注入上一步的输出，作为下一步 prompt 的上下文。

## 6. 关键流程

1. Web 提交任务。
2. planner 出 plan（先查模板匹配，没有就调 LLM 生成）。
3. engine 拓扑调度：依赖就绪的步骤并发起，各进自己的 worktree。
4. adapter 起 `claude` / `codex` 子进程，stdout 实时推送 Web。
5. loop 步骤反复执行直到 `until` 条件满足或到 `max`。
6. 完成后各 worktree merge 回主分支，任务标记完成。

## 7. Agent 适配器（可插件）

每个适配器就一个小文件，统一接口：

- 输入：`{ prompt, workdir }`
- 输出：`{ output, success }`

初始两个：

- `claude`：无头调用 `claude -p "<prompt>"`
- `codex`：无头调用 `codex exec "<prompt>"`

扩展 gemini / aider：复制一个适配器文件即可，无需动引擎。

## 8. 循环判定

`until: "pass"` = 上一步子进程退出码为 0。

> ponytail: 用退出码判成败，够用；若不准再升级成解析输出。

## 9. 错误处理

- 步骤失败（非零退出 / 超时）→ 标红推送 Web，停掉其下游步骤。
- 每步有超时限制。
- 用户可一键 stop 全部正在跑的 agent。

## 10. 测试策略

- 内置一个 `echo` 假适配器（不烧 token），用于测引擎。
- 单测调度器的三个核心行为：拓扑顺序、并行、loop。

## 11. 唯一真风险（实现第一步先验证）

`claude -p` 和 `codex exec` 的确切无头调用方式（参数、输出格式、鉴权）。

动工第一件事：各跑一条最小命令确认其调用契约，再往下写。这是整个系统的集成风险点。

## 12. 目录结构（预期）

```
orch/
  package.json
  server.js          入口：起 express + ws，开浏览器
  planner.js         模板匹配 / 调 LLM 出 plan
  engine.js          调度 + loop
  workspace.js       git worktree 管理
  store.js           SQLite 封装
  adapters/
    claude.js
    codex.js
    echo.js          测试用假适配器
  templates/
    dev-test-fix.yaml
  web/
    index.html       单页面板
  test/
    engine.test.js
```
