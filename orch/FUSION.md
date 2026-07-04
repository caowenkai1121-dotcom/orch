# 四外部项目融合溯源(traceable fusion map)

对 [tolaria](https://github.com/refactoringhq/tolaria) / [agentscope](https://github.com/agentscope-ai/agentscope) / [PlanWeave](https://github.com/GaosCode/PlanWeave) / [emdash](https://github.com/generalaction/emdash) 深度调研(实读各仓库 README/docs/architecture)后,把可移植精华融合进 orch。本表逐方法给出判定与落点,作为「完美融合」的可追溯证据。

判定:**已融合**(orch 已有对应能力)/ **新融合**(本轮据调研新增,附轮次)/ **跳过**(附理由)。

---

## PlanWeave(文件驱动循环工程 · orch 最近同类)

| 外部方法 | 判定 | orch 落点 / 理由 |
|---|---|---|
| 纯调度器 coordinator + 技能即角色 | 已融合 | `engine.runPlan` 纯调度;角色=员工卡(身份/规则/流程/交付/交接) |
| 文件即节点、文档即块的可编辑任务图 | 已融合(等价) | SQLite plan 权威 + `task_plan.md` 磁盘镜像 + 运行期活编辑 + 计划版本化 |
| per-block effectiveExecutor 执行器路由 | 已融合 | step.agent 字段;resolveRoles 把 role→agent+提示词 |
| claim/readiness 就绪度调度(锁+parallel-safe) | 已融合 | 依赖满足即启动 + 全局信号量 + 命名锁 `lock`/`locks` + why-not 阻塞原因 |
| 有界评审反馈循环(maxFeedbackCycles) | 已融合 | 质量门 loop `until:pass`、max≤5、FAIL 重做、耗尽如实 failed、可重试续跑 |
| 持久三件套(metadata/stdout/stderr)+ 可恢复 | 已融合(等价) | events 表 + 接力记录 + task_plan.md 错误表 + 重启标失败可续跑 |
| doctor 状态一致性探针(与计划修复分离) | 已融合 | 🩺 自检:僵尸任务/孤儿 worktree/孤儿产出目录,证据支撑一键清理 |
| **本地确定性评审执行器(脚本当门)** | **新融合(轮192)** | step.gate_cmd:命令退出码 0=PASS/非0=FAIL,不调 LLM,零 token+可复现,与 expected_outcome 互补(`engine.runGateCmd`) |
| 多 canvas 项目图 + crossTaskEdges | 跳过 | orch 单任务 DAG;跨任务显式阻塞图违背当前模型、低频 |
| HTTP MCP server 供外部规划器 | 跳过 | 已有 webhook 结构化触发作外部入口;MCP 规划入口重复加复杂度 |
| tmux 执行器 + capture-pane 监控 | 跳过 | 主平台 Windows 无 tmux;stream 解析 + PID 管理已够 |

## emdash(桌面多 agent 并行 IDE)

| 外部方法 | 判定 | orch 落点 / 理由 |
|---|---|---|
| .emdash.json 供给(preserve+scripts) | 已融合 | `.orch.json {setup, preserve}` 冷 worktree 供给 |
| **preserve 支持 glob + 默认 env 清单** | **新融合(轮193)** | `expandPreserve` basename 级 glob(.env.*.local)+ 硬规则不拷配置 + 未配默认 env(`workspace.js`) |
| worktree 硬隔离 | 已融合 | isolate=worktree → 独立 git worktree+分支 |
| 分支名前缀+随机后缀防撞 | 已融合(更优) | `orch/task-<id>` 唯一 id 确定性防撞,优于随机后缀 |
| 任务生命周期 terminate/archive(reap) | 已融合 | 停止(PID 杀树)+ 删任务(reapWorktree)+ doctor 清孤儿 + 删除目录墓碑防复活 |
| Provider 插件注册表(33 家统一接口) | 已融合(等价) | adapters(claude/codex/generic)+ 启动自动发现已装 CLI + 落库自定义 agent |
| UI 内 diff 评审 + 暂存选择 | 已融合(主体) | 每步自动 commit + PR 风格差异视图(+绿/-红)+ 针对改动派活 |
| 双执行路径 legacy PTY / 结构化 ACP | 跳过 | 当前 provider 是 stream-json;提前铺 ACP 属过度前瞻 |
| PTY 环境变量白名单 + tmux 包裹 | 跳过 | 本地单用户 agent 本就 skip-permissions 可直读;tmux Windows 不适用 |
| Issue 源接入(Linear/Jira) | 跳过 | 违背本地定位;webhook 已可带 text 作初始供给 |
| Workspace-server(SSH+版本协商守护进程) | 跳过 | SSH 远程违背本地单机,重型过度设计 |

## AgentScope(阿里生产级多 agent 框架)

| 外部方法 | 判定 | orch 落点 / 理由 |
|---|---|---|
| expected_outcome 验收判据 | 已融合 | step.expected_outcome 契约,质量门据此判 PASS/FAIL |
| Meta Planner(分层规划 + 自动模式切换) | 已融合(主体) | 员工/执行器双模式规划 + 动态重规划 NEED_REPLAN;单执行器无编排→单步直做 |
| MsgHub 广播/observe 共享上下文 | 已融合 | findings.md 共享外部记忆 + 引擎自动注入上游交接备忘 |
| Pipeline 原语(sequential/fanout) | 已融合(且超越) | 依赖驱动 DAG + 信号量并发强于固定形态 |
| ReAct + 实时 steering(可中断保上下文) | 部分/跳过深化 | pause/cancel(PID 杀树)+ noteToTask 指令注入;真 mid-step 保上下文需 ACP 会话,无头 CLI 不支持 |
| Toolkit 分阶段工具组动态启停 | 部分 | 只读档=粗粒度工具子集;CLI 仅给 `--disallowedTools` 粗档,细化收益小 |
| 权限系统 + bypass 工具级确认 | 已融合 | 只读权限档 + NEED_DECISION 人在环 + 默认自主 |
| StateModule state_dict 序列化 | 已融合(等价) | SQLite 状态持久化 + 会话落库重启不掉线 + 计划版本化 |
| 统一事件总线 + 流式事件 | 已融合 | tool_use/命令/文件/思考事件 surface 成实时行 + ws 广播 |
| 评测 Benchmark/Metric + Ray 分布式 | 跳过 | Python 专属 + 分布式,违背本地单机;用经验复盘+绩效记忆做轻量「越用越聪明」 |
| Studio 可观测(不稳定项+并排轨迹) | 跳过 | 有回放+绩效榜+失败诊断;并排轨迹根因对单用户属重型 |
| 长期记忆双范式(agent 自控 record/retrieve) | 部分 | findings.md 已是 agent 自主沉淀;跨任务经验目前规则触发复盘 |

## Tolaria(Markdown 知识库 · 非编排器,有 CLI agent 接入层)

| 外部方法 | 判定 | orch 落点 / 理由 |
|---|---|---|
| AGENTS 文件让 agent 自发现结构 | 已融合 | 原生 CLAUDE.md/AGENTS.md 任务级上下文落文件,CLI 启动自动加载 |
| 统一 CLI agent 适配器层 | 已融合(等价) | `adapters/jsonl.js` 共享 stream 骨架 + `generic.js` 从定义造适配器 |
| 配置存文件而非源码(agent 友好) | 已融合 | `.orch.json` 供给 + 原生上下文文件 |
| 上下文快照 + 头尾压缩 + 按需回取(bodyTruncated) | 部分 | findings 过大走 LLM 压缩摘要(#20);「截断+agent 主动回取」更省但价值递减,未做 |
| Safe/Power-User 双权限模式 | 部分 | 已有只读档;更细的分级权限矩阵收益边际 |
| 文件系统即真相源 + 分歧重建 | 跳过(方向不同) | orch 用 SQLite 真相源(刻意选择),派生 task_plan.md 镜像 |
| git-aware 增量扫描 / 事务式文件操作 | 跳过 | 前端/知识库专属;与 orch 编排语义无关 |
| Type Document 元建模 | 跳过 | 角色目录已够;笔记式类型自举属知识库范式 |
| MCP 双通道桥(工具面/UI面分离) | 跳过 | 本地单用户,agent 反向调用编排器收益低、加复杂度 |

---

**一句话**:四项目可移植精华已充分融合,多数**功能等价或更优**;跳过项均因 Python 专属 / 违背本地单机单用户定位 / 过度设计。融合遵循 orch 极简与外科式原则,不为对齐而堆砌。详见 `README.md` V4 段与各轮 commit。
