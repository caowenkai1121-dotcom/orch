# orch v3 — Agent 编辑删除 / 项目+搜索 / 当前用户过滤 / 布局修复 / 产出物归档 设计

- 日期：2026-06-30
- 状态：已确认设计，待写实现计划
- 基线：orch v2（可配置 agent + 人员 + LLM 拆解）已完成

## 1. 目标（5 项）

1. **#1 Agent 编辑/删除**：Agent 团队里能改、能删（全部可删，含 claude/codex）。
2. **#2 项目新增 + 任务按项目 + 全局搜索**：能新建项目；任务归属项目；顶栏搜索做成全局搜索结果页。
3. **#3 当前用户过滤 Agent**：无登录；左下角可切换当前身份；选中人后 Agent 团队只显示其被分配的 agent（操作者/无分配看全部）。
4. **#4 总控台布局 bug**：「实时编排活动」被挤成竖排单字 → 修。
5. **#5 产出物归档**：任务产出落 `运行目录/data/<用户>/<项目>/<任务slug>`，按 用户/项目/任务 区分。

YAGNI：仍不做登录鉴权（身份只是过滤视图，不校验权限）、不做远程部署。

## 2. #1 Agent 编辑/删除

- **store**：
  - `updateAgent(id, def)`：UPDATE 同字段（name/command/args/model/caps/color/avatar/dept）。
  - `deleteAgent(id)`：DELETE agents 行 + `DELETE FROM person_agents WHERE agent_id=id`（级联）。
- **server**：`PUT /api/agents/:id`（更新 + `adapters=buildAdapters()`）、`DELETE /api/agents/:id`（删除 + 重建 + 广播 `{type:'agents'}`）。
- **前端**：Agent 详情页头部「暂停 / 指派任务」两个按钮改为「编辑 / 删除」。
  - 编辑：打开 Agent 弹窗，输入框预填该 agent 当前值（`value="{{ naName }}"` 等绑定 `state.editAgent`）；提交走 PUT。
  - 删除：`window.confirm` 后 DELETE，成功回 Agent 团队并刷新。
- Agent 弹窗复用：`state.editAgent` 为 null=新建(POST)，非 null=编辑(PUT)；标题随之 `新建 Agent` / `编辑 Agent`。

## 3. #2 项目 + 搜索

- **projects 表**：`CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT, client TEXT, created_at TEXT)`。
  - store：`addProject({name,client})`（id 由 name slug + 序号）、`listProjects()`。
- **api.buildAll 的 projects**：合并「表里的项目」与「任务 project 字段派生的项目」，按 name 去重；空项目（无任务）progress 0、status 规划。
- **server**：`POST /api/projects {name,client}`。
- **前端**：
  - 项目页右上「+ 新建项目」→ 弹窗（名称 / 客户）。
  - 新建任务弹窗「项目」从单 input 改为 `<select>`（列出已有项目）+ 一个"新项目"文本框（填了就用新的）。
  - **全局搜索**：顶栏搜索区做成真 `<input id="search">`，输入并回车 → `go('search',{q})`；新增 `isSearch` 视图，渲染 4 组结果（任务/Agent/项目/人员），客户端按 q 子串匹配 `this.TASKS/AGENTS/PROJECTS/PEOPLE`，每条可点进对应详情。

## 4. #3 当前用户过滤

- **前端**：左下角用户块改为按钮 → 点击切换 `state.modal='who'`，弹出人员列表选择；选中设 `state.currentPersonId`，左下角显示当前人。
- **过滤规则**：`renderVals` 里，若当前人存在且其 `assignedIds.length>0` → `v.agents` 与 Agent 团队/总览只显示 id ∈ assignedIds 的 agent；否则（操作者 id `op` 或无分配）显示全部。
  - 实现：在 `super.renderVals()` 后，对 `v.agents`、`v.activeAgents` 过滤；roster 用 `v.agents`。部门/cv 不强制过滤（保持可用），仅 Agent 团队 roster + 运行中 Agent 列表按身份过滤即可（最贴用户诉求）。
- 不影响执行（纯视图过滤）。

## 5. #4 总控台布局修复

- 根因：总控台双栏 grid `1.55fr 1fr`（活动 | 运行中 Agent）的子项缺 `min-width:0`；右栏运行中 Agent 的 `action` 长文本虽有 `nowrap+ellipsis`，但父级无 `min-width:0`，撑大列宽，活动列被压成 `min-content`（CJK 逐字竖排）。
- 修：给两个 grid 子卡片加 `min-width:0`；运行中 Agent 卡片内放 action 的容器加 `min-width:0`（确保 ellipsis 生效）。
- 同样排查并修编排画布/其它双栏 grid 的同类隐患（就近加 `min-width:0`）。

## 6. #5 产出物归档 data/<用户>/<项目>/<任务>

- **tasks 表**加 `owner TEXT`；`createTask(text, project, owner)`。
- **server `POST /task`** 收 `user`（前端传当前身份名，缺省操作者）。
- **workspace 改为每任务独立目录**：
  - 新增 `slug(s)`：转文件名安全（保留中英数字与 `-_`，其余→`-`，截断 ~40）。
  - server 在 `POST /task` 时算 `dir = path.join(ROOT, 'data', slug(owner), slug(project), slug(text) + '-' + id)`，`fs.mkdirSync(dir,{recursive:true})`，传 `workspace = { make: () => dir }` 给 `runTask`。
  - 同一任务各步骤共享该 dir（顺序产物可见）；不同任务天然隔离。
  - codex `--skip-git-repo-check` 已能在非 git 目录跑；claude 直接写该目录。
- `makeWorkspace(ROOT)` 旧的共享实现保留给无 owner/project 的回退（或直接由 server 每任务构建，workspace.js 仅留 `slug` 与一个 `taskDir(root,owner,project,text,id)` 工具 + 共享回退）。
- `.gitignore` 已忽略 `data/`（v1 加过 `worktrees/`，需补 `data/`）。

## 7. 错误处理

- 删除正在被运行任务使用的 agent：仅删定义，进行中的子进程不受影响（已 spawn）；新任务不再可选它。
- PUT/DELETE 未知 id：store 操作无副作用，返回 ok（幂等）。
- 新建项目重名：按 name 去重显示（表可有重名 id 不同，显示合并）。简单处理，不报错。
- data 目录创建失败（权限）：runTask 捕获，任务标 failed + 日志记错误。
- 搜索空 q：搜索视图显示提示，不崩。

## 8. 测试

- 保留现有 25 个测试。
- 新增：
  - store：`updateAgent` 改字段可查、`deleteAgent` 同时清分配、`addProject`+`listProjects`、`createTask` 带 owner 落库。
  - workspace：`slug` 安全转换、`taskDir` 拼出 `data/owner/project/...` 且 mkdir。
  - api：`buildAll` 合并表项目 + 任务派生项目（去重）。

## 9. 涉及文件

```
orch/
  store.js        + updateAgent/deleteAgent/addProject/listProjects;createTask 加 owner;projects 表;tasks 加 owner
  workspace.js    + slug()/taskDir();保留共享回退
  api.js          projects 合并表+派生;agents 视图不变
  server.js       + PUT/DELETE /api/agents/:id、POST /api/projects;POST /task 收 user 并按 data/<user>/<project>/<task> 建 workspace
  web/
    index.html    Agent详情 编辑/删除;项目页 新建项目;新建任务 项目下拉;搜索 input+搜索视图;左下角身份切换;总控台 grid min-width:0
    app.js        编辑/删除/项目/搜索/身份切换 handlers;agents 按身份过滤;搜索结果计算
  test/           + store/workspace/api 新测试
  .gitignore      + data/
```
