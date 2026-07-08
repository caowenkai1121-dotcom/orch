# orch 开发指南(给 AI 编码助手)

轻量本地多 agent 编排器:Node + express + ws + better-sqlite3 单文件。驱动真实 CLI agent(`claude -p` / `codex exec`)无头协作。单人本地工具。用户交流用中文。

## 架构与关键文件
- `server.js` 入口:express + ws,HTTP 端点 + 实时活动广播 + 定时任务轮询。`ROOT=process.env.ORCH_ROOT||__dirname`(不用 cwd,服务器 systemd 才稳)。`PORT`/`ORCH_PUBLIC_URL`/`ORCH_ADMIN_PASSWORD` 环境化。`/healthz` 无鉴权探活(验 DB)。内存 `runs` Map(taskId→运行记录 rec)是取消/暂停/子进程注册的枢纽。SIGTERM/SIGINT 优雅退出杀子进程。WS 30s 心跳清僵尸连接。
- `engine.js` 核心调度:`runPlan` 依赖驱动(某步 deps 一满足即启动)+ 全局信号量并发上限 + 命名锁(`held` Set)。`runLoop` 质量门(body 末步 isGate,输出 PASS/FAIL,FAIL 重做≤max;冒泡 needDecision/needReplan 时同步 loop 步 blocked)。`runStep` 组装 brief 调 adapter.run;瞬时故障(网络/5xx)原地重试一次;model/effort 白名单清洗防命令行注入。
- `runner.js` 编排:`execute()` 串起出plan→执行→落库;`runTask/runApproved/resumeTask/retryFailed/rerunStep/continueTask/replanRemaining` 各续跑路径。`finalAcceptance` 任务级终验闭环(只读验收产出→FAIL 自动派 1 轮修复→复验;预算按执行周期计)。会议室(`openMeeting/meetingSpeak/judgeMeeting/endMeeting`,发言全串行、主持人共识判定)。交接全文落盘 `交接/<步骤id>.md`(摘要+指针)。`stripMeeting` 续跑剥离会议编排。
- `planner.js`:模板匹配 / LLM 拆分(`fromLLMRoles` 员工模式 / `fromLLM` 执行器模式);`sequentializeSteps`(拓扑重排+链式化,执行顺序=确认顺序)、`sanitizeDeps`(断环+去重id)、`lintPlan`(结构体检)、`extractJsonWithRepair`(JSON 坏回喂修复)、`resolveRoles`(role→agent+提示词+经验)、`prependMeeting`(复杂前置会议+智能选参会人)、`fallbackComplexRolePlan`(全栈保底编排)、`mergeEditedPlan`。**选人原则:能力对口不为用而用**(见 fromLLMRoles prompt)。
- `app_runtime.js` 应用广场发布/部署:`detect`(静态/全栈/进程类型识别,含根级 server/api 后端)、`buildNeeded`/`runBuild`(需构建项目自动 npm install+build)、`ensureStarted`/`proxyRequest`(拉起后端+代理 /api)、`rewritePublishedText`(资源路径重写)。`context_gateway.js` 任务目录 Markdown 知识检索(scope 支持)。`model_discovery.js` 从 CLI 环境发现可用模型。
- `adapters/`:`jsonl.js` 共享 stream 运行时骨架(spawn+行缓冲+超时;prompt 走 **stdin** 避 Windows ~8K 命令行上限);`claude.js`/`codex.js` 只给 args+parse;`openai.js` API 型大模型(地址/Key/模型三项接入);`streamparse.js` 解析 stream-json/--json;`cli.js`+`generic.js`;`echo.js` 测试假适配器;`steptimeout.js` 按 PID 杀树(ps+pkill 回退)。
- `store.js` SQLite(**WAL 崩溃保护** + 每日自动备份 orch.db.bak);`api.js` 把真实 tasks/steps 派生成前端数据(buildAll 批量查询消除 N+1);`web/` 自定义 mini-dc 框架(`index.html` 模板 sc-if/sc-for + `app.js` VM,WS 重连补齐状态)。
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
- **prompt 走 stdin 不走命令行参数**(claude `-p` 无位置参数读 stdin;codex `exec -`):简报+findings+交接常态 5-9K,当命令行参数会撞 Windows ~8K 上限致 spawn 神秘失败。
- **SQLite `INSERT OR REPLACE` 擦隐式列**:更新已存在行且要保留部分列(memo/绩效/enabled/api_key)一律用 `ON CONFLICT DO UPDATE`,否则种子升级/导入清零累积数据。
- **删任务级联**:含 task_id 的表全清(taskArtifactTables + apps),且删前 `stopTaskApps`(停发布 app 进程,防孤儿+rmSync EPERM)。SQLite rowid 会复用,残留会附身新任务。
- **续跑剥离会议**:continueTask/replanRemaining 的 makePlan 结果过 `stripMeeting`(会议步在续跑路径会被当实现步误执行)。
- **前端 fetch 竞态**:单变量+xxxFor 标记的 fetch(files/msgs/diffs 等)在 then 里守卫 `if(id!==this.state.taskId)return`(切任务后旧响应不覆盖当前);按 id 键化的(relay/plan)天然免疫。
- **buildAll 是热路径**(每 20s+每 WS 事件):任何按任务/执行器循环的 store 查询都要批量化(plansByTask/usageByTask/agentAvgSecondsAll/autoRetryCounts),否则随规模 N+1 劣化卡事件循环。

## 改动后的验证铁律
1. `npm test`(node --test 全量,当前 344+ 用例)必须全绿。
2. 服务端改动:重启生效——按 PID 杀旧进程 + 起新进程 + 验单 listener + HTTP 200 + err.log 空。启动约 7s,别探太早。
3. 前端改动(web/):必浏览器回归(Playwright 加载 + 查 console 无 JS 错误)——服务端测试抓不到客户端渲染错(TDZ/未定义插值)。
4. 非平凡逻辑留一个可跑检查(集成/单测)。

## 风格
遵循既有风格(缩进/中文注释/紧凑单行)。外科式最小改动,不重构无关代码,不加不必要依赖。极简优先,拒绝过度设计。

> 深度历史见 README(V2–V4 各轮增量);V4 段是四外部项目(tolaria/agentscope/planweave/emdash)融合总览。
