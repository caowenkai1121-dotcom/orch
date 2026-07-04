# orch 开发指南(给 AI 编码助手)

轻量本地多 agent 编排器:Node + express + ws + better-sqlite3 单文件。驱动真实 CLI agent(`claude -p` / `codex exec`)无头协作。单人本地工具。用户交流用中文。

## 架构与关键文件
- `server.js` 入口:express + ws,HTTP 端点 + 实时活动广播。`ROOT=process.cwd()`。内存 `runs` Map(taskId→运行记录 rec)是取消/暂停/子进程注册的枢纽。
- `engine.js` 核心调度:`runPlan` 依赖驱动(某步 deps 一满足即启动)+ 全局信号量并发上限 + 命名锁(`held` Set)。`runLoop` 质量门(body 末步 isGate,输出 PASS/FAIL,FAIL 重做≤max)。`runStep` 组装 brief 调 adapter.run。
- `runner.js` 编排:`execute()` 串起出plan→执行→落库;`runTask/runApproved/resumeTask/retryFailed/rerunStep/continueTask/replanRemaining` 各续跑路径。
- `planner.js`:模板匹配 / LLM 拆分(`fromLLMRoles` 员工模式 / `fromLLM` 执行器模式);`sanitizeDeps`(断环+去重id)、`lintPlan`(结构体检)、`resolveRoles`(role→agent+提示词)、`mergeEditedPlan`。
- `adapters/`:`jsonl.js` 共享 stream 运行时骨架(spawn+行缓冲+超时);`claude.js`/`codex.js` 只给 args+parse;`streamparse.js` 解析 stream-json/--json;`cli.js`(generic 非流式)+`generic.js`;`echo.js` 测试假适配器。
- `store.js` SQLite;`api.js` 把真实 tasks/steps 派生成前端数据;`web/` 自定义 mini-dc 框架(`index.html` 模板 sc-if/sc-for + `app.js` VM)。
- `roles-seed.json` 20部门/87员工角色卡;`templates/` 预设工作流 yaml。

## 硬性约定 / 不变量(违反会出 bug,已被审查踩过)
- **取消/停止只按 PID 定向杀**该任务 spawn 的子进程树,**绝不按镜像名**(会误伤别的 claude/自身)。
- **runs 生命周期**:rec 必须在整个运行(含 replan 续跑)期间留在 runs,取消才够得到。`execute` 的 finally 删 runs——replan 交接用 `await replanRemaining(); return;`(不是直接 return),让 finally 推迟到续跑真正结束。内外层 execute 复用同一 rec,finally 的一次性告警发完要清 `rec.notes`。
- **质量门**:门禁员工输出 `FAIL`(即使进程退出码 0)= 不通过退回;首词 PASS 即放行。
- **plan 透传字段**:step 的 `lock`/`permission`/`expected_outcome` 靠 `{...s}`/Object.assign 透传,改 plan 变换处(rw/fill/resolveRoles)勿丢。
- **存库计划的叶子步必须已带 agent**(恢复路径不再跑 resolveRoles);role-only 会在 runStep 抛「未知 agent」。edit-plan 用 `lintPlan` 拦。
- **并发共享目录**:同任务各步共享一个产出目录并发跑。写任务级文件(CLAUDE.md/AGENTS.md #3)只写不存在或 orch 自己的(首行 MARK 判定),绝不覆盖项目/agent 真实文件。
- **适配器输出**:stream 解析用 `StringDecoder` 跨 chunk(防中文多字节被切断);tools/命令活动只进 onLine(实时流)不入语义 output(否则污染 handoff/gate/NEED_DECISION 检测)。
- 元 LLM 调用(规划/细化/复盘/压缩)用 `metaDir()` 中性 cwd,隔离 skip-permissions agent 误写污染源码。

## 改动后的验证铁律
1. `npm test`(node --test 全量,当前 177 用例)必须全绿。
2. 服务端改动:重启生效——按 PID 杀旧进程 + 起新进程 + 验单 listener + HTTP 200 + err.log 空。启动约 7s,别探太早。
3. 前端改动(web/):必浏览器回归(Playwright 加载 + 查 console 无 JS 错误)——服务端测试抓不到客户端渲染错(TDZ/未定义插值)。
4. 非平凡逻辑留一个可跑检查(集成/单测)。

## 风格
遵循既有风格(缩进/中文注释/紧凑单行)。外科式最小改动,不重构无关代码,不加不必要依赖。极简优先,拒绝过度设计。

> 深度历史见 README(V2–V4 各轮增量);V4 段是四外部项目(tolaria/agentscope/planweave/emdash)融合总览。
