# 轻量 Agent 编排器 `orch` 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本地 Web 工具，发一个任务即自动拆解并分配给 Claude / Codex 等 agent 协作（并行分工 + 改测循环）。

**Architecture:** 单一执行引擎只认一种 `plan` 结构（步骤+依赖+派给谁）；模板和 LLM 都只是生成 plan 的两种方式。引擎拓扑调度，依赖就绪的步骤并发跑，每个 agent 进独立 git worktree，loop 步骤实现 Codex↔Claude 改测循环。Express+ws 后端把日志实时推给单页前端。

**Tech Stack:** Node 18+，express，ws，better-sqlite3，js-yaml。测试用 Node 内置 `node:test`（无额外依赖）。前端纯 HTML+原生 JS，无框架。

## Global Constraints

- Node 版本 ≥ 18（用内置 `node --test` 和 `fetch`）。
- 依赖只允许：`express`、`ws`、`better-sqlite3`、`js-yaml`。不引入前端框架、不引入测试框架。
- 平台 Windows：`child_process.spawn` 一律 `{ shell: true }`；路径用 `path.join`。
- Agent 统一接口：`adapter.run({ prompt, workdir, onLine }) => Promise<{ output: string, success: boolean }>`。
- plan 结构：`{ task, steps: [...] }`，普通步骤 `{ id, agent, prompt, deps: [] }`，循环步骤 `{ id, type:"loop", until:"pass", max, deps, body:[...] }`。`prompt` 内 `{prev}` 占位符注入上游输出。

---

### Task 1: 项目脚手架 + 验证 CLI 无头契约

**Files:**
- Create: `orch/package.json`
- Create: `orch/.gitignore`

**Interfaces:**
- Produces: 可运行的 npm 工程；确认 `claude -p` 与 `codex exec` 的退出码/输出形态（写进本任务的笔记注释）。

- [ ] **Step 1: 验证 claude 无头调用**

Run: `claude -p "只回复 OK 两个字"`
预期：进程退出码 0，stdout 含 `OK`。记录实际输出格式（是否带 markdown/JSON 包裹）。
若命令不存在或需登录 → 先 `claude` 完成登录，再重试。

- [ ] **Step 2: 验证 codex 无头调用**

Run: `codex exec "只回复 OK 两个字"`
预期：退出码 0，stdout 含 `OK`。记录输出格式。
若需登录 → 先完成 codex 登录。

> 这两步是整个系统唯一的真集成风险。两条命令都跑通再继续。若某 agent 的成败无法用退出码判断，在 Task 3 的对应适配器里改成解析输出。

- [ ] **Step 3: 初始化工程**

Run:
```bash
cd orch
npm init -y
npm pkg set type=commonjs
npm install express ws better-sqlite3 js-yaml
npm pkg set scripts.start="node server.js"
npm pkg set scripts.test="node --test"
```

- [ ] **Step 4: 写 .gitignore**

```
node_modules/
*.db
worktrees/
```

- [ ] **Step 5: Commit**

```bash
git add orch
git commit -m "chore: orch 脚手架 + 依赖"
```

---

### Task 2: SQLite 存储层

**Files:**
- Create: `orch/store.js`
- Test: `orch/test/store.test.js`

**Interfaces:**
- Produces: `open(file) => { createTask(text)->id, setPlan(id,plan), setTaskStatus(id,status), setStep(taskId,stepId,agent,status,output), addLog(taskId,stepId,line), getTask(id)->{...,steps[]}, listTasks()->[], db }`

- [ ] **Step 1: 写失败测试**

`orch/test/store.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../store');

test('建任务并取回', () => {
  const s = open(':memory:');
  const id = s.createTask('做登录');
  const t = s.getTask(id);
  assert.equal(t.text, '做登录');
  assert.equal(t.status, 'pending');
});

test('setStep 为同一步骤做 upsert', () => {
  const s = open(':memory:');
  const id = s.createTask('x');
  s.setStep(id, 'dev', 'claude', 'running', null);
  s.setStep(id, 'dev', 'claude', 'done', 'ok');
  const t = s.getTask(id);
  assert.equal(t.steps.length, 1);
  assert.equal(t.steps[0].status, 'done');
  assert.equal(t.steps[0].output, 'ok');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd orch && node --test test/store.test.js`
预期：FAIL，报 `Cannot find module '../store'`。

- [ ] **Step 3: 写最小实现**

`orch/store.js`:
```js
const Database = require('better-sqlite3');

function open(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks(
      id INTEGER PRIMARY KEY, text TEXT, status TEXT, plan TEXT);
    CREATE TABLE IF NOT EXISTS steps(
      task_id INTEGER, step_id TEXT, agent TEXT, status TEXT, output TEXT,
      PRIMARY KEY(task_id, step_id));
    CREATE TABLE IF NOT EXISTS logs(
      id INTEGER PRIMARY KEY, task_id INTEGER, step_id TEXT, line TEXT);
  `);
  return {
    createTask(text) {
      return db.prepare('INSERT INTO tasks(text,status) VALUES(?,?)')
        .run(text, 'pending').lastInsertRowid;
    },
    setPlan(id, plan) {
      db.prepare('UPDATE tasks SET plan=? WHERE id=?').run(JSON.stringify(plan), id);
    },
    setTaskStatus(id, status) {
      db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, id);
    },
    setStep(taskId, stepId, agent, status, output) {
      db.prepare(`INSERT INTO steps(task_id,step_id,agent,status,output)
        VALUES(?,?,?,?,?)
        ON CONFLICT(task_id,step_id) DO UPDATE SET
          status=excluded.status, output=excluded.output`)
        .run(taskId, stepId, agent, status, output ?? null);
    },
    addLog(taskId, stepId, line) {
      db.prepare('INSERT INTO logs(task_id,step_id,line) VALUES(?,?,?)')
        .run(taskId, stepId, line);
    },
    getTask(id) {
      const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      if (!t) return null;
      t.steps = db.prepare('SELECT * FROM steps WHERE task_id=?').all(id);
      return t;
    },
    listTasks() {
      return db.prepare('SELECT id,text,status FROM tasks ORDER BY id DESC').all();
    },
    db,
  };
}

module.exports = { open };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd orch && node --test test/store.test.js`
预期：PASS，2 passing。

- [ ] **Step 5: Commit**

```bash
git add orch/store.js orch/test/store.test.js
git commit -m "feat: SQLite 存储层"
```

---

### Task 3: Agent 适配器（echo / claude / codex）

**Files:**
- Create: `orch/adapters/cli.js`
- Create: `orch/adapters/echo.js`
- Create: `orch/adapters/claude.js`
- Create: `orch/adapters/codex.js`
- Test: `orch/test/echo.test.js`

**Interfaces:**
- Produces: 每个适配器导出 `{ run({ prompt, workdir, onLine }) => Promise<{ output, success }> }`。`cli.js` 导出 `runCli(cmd, args, workdir, onLine) => Promise<{ output, success }>`。

- [ ] **Step 1: 写 echo 适配器失败测试**

`orch/test/echo.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const echo = require('../adapters/echo');

test('echo 回显 prompt 且默认成功', async () => {
  const lines = [];
  const r = await echo.run({ prompt: '你好', onLine: (l) => lines.push(l) });
  assert.equal(r.success, true);
  assert.match(r.output, /你好/);
  assert.deepEqual(lines, ['你好']);
});

test('prompt 含 FAIL 则失败', async () => {
  const r = await echo.run({ prompt: 'FAIL here', onLine: () => {} });
  assert.equal(r.success, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd orch && node --test test/echo.test.js`
预期：FAIL，模块找不到。

- [ ] **Step 3: 写 echo 适配器**

`orch/adapters/echo.js`:
```js
// 测试用假适配器，不烧 token。prompt 含 FAIL 视为失败，用于测 loop。
module.exports = {
  async run({ prompt, onLine }) {
    onLine(prompt);
    return { output: prompt, success: !prompt.includes('FAIL') };
  },
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd orch && node --test test/echo.test.js`
预期：PASS。

- [ ] **Step 5: 写 CLI 公共封装**

`orch/adapters/cli.js`:
```js
const { spawn } = require('child_process');

// 跑一条 CLI，stdout/stderr 逐行回调，退出码 0 视为成功。
function runCli(cmd, args, workdir, onLine) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: workdir || process.cwd(), shell: true });
    let output = '';
    const onData = (b) => {
      const s = b.toString();
      output += s;
      s.split('\n').filter(Boolean).forEach(onLine);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', (code) => resolve({ output, success: code === 0 }));
    p.on('error', (e) => { onLine(String(e)); resolve({ output: String(e), success: false }); });
  });
}

module.exports = { runCli };
```

- [ ] **Step 6: 写 claude / codex 适配器**

`orch/adapters/claude.js`:
```js
const { runCli } = require('./cli');
module.exports = {
  run({ prompt, workdir, onLine }) {
    return runCli('claude', ['-p', JSON.stringify(prompt)], workdir, onLine);
  },
};
```

`orch/adapters/codex.js`:
```js
const { runCli } = require('./cli');
module.exports = {
  run({ prompt, workdir, onLine }) {
    return runCli('codex', ['exec', JSON.stringify(prompt)], workdir, onLine);
  },
};
```
> 用 `JSON.stringify(prompt)` 给参数加引号，避免 prompt 里空格/特殊字符被 shell 拆开。若 Task 1 记录的实际命令参数不同，按实际改这里。

- [ ] **Step 7: Commit**

```bash
git add orch/adapters orch/test/echo.test.js
git commit -m "feat: agent 适配器 echo/claude/codex"
```

---

### Task 4: 执行引擎（调度 + 循环）— 核心

**Files:**
- Create: `orch/engine.js`
- Test: `orch/test/engine.test.js`

**Interfaces:**
- Consumes: 任意符合 `{ run({prompt,workdir,onLine}) }` 的适配器。
- Produces: `runPlan(plan, ctx) => Promise<done>`，其中 `ctx = { adapters, workspace:{ make(stepId)->Promise<dir> }, onLog(stepId,line), onStatus(stepId,status) }`，`done` 为 `{ [stepId]: { output, success } }`。

- [ ] **Step 1: 写失败测试（并行 / 依赖替换 / 循环）**

`orch/test/engine.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const { runPlan } = require('../engine');

function mkCtx(adapters) {
  return {
    adapters,
    workspace: { async make() { return '.'; } },
    onLog: () => {},
    onStatus: () => {},
  };
}
const echo = { async run({ prompt, onLine }) {
  onLine(prompt);
  return { output: prompt, success: !prompt.includes('FAIL') };
} };

test('无依赖的步骤都会跑', async () => {
  const plan = { steps: [
    { id: 'a', agent: 'echo', prompt: 'A', deps: [] },
    { id: 'b', agent: 'echo', prompt: 'B', deps: [] },
  ] };
  const done = await runPlan(plan, mkCtx({ echo }));
  assert.equal(done.a.output, 'A');
  assert.equal(done.b.output, 'B');
});

test('{prev} 注入上游输出', async () => {
  const plan = { steps: [
    { id: 'a', agent: 'echo', prompt: 'hello', deps: [] },
    { id: 'b', agent: 'echo', prompt: 'got {prev}', deps: ['a'] },
  ] };
  const done = await runPlan(plan, mkCtx({ echo }));
  assert.equal(done.b.output, 'got hello');
});

test('loop 重试到 pass', async () => {
  let n = 0;
  const counter = { async run({ prompt, onLine }) {
    onLine(prompt);
    return { output: prompt, success: n++ > 0 }; // 第一次失败,之后成功
  } };
  const plan = { steps: [
    { id: 'loop', type: 'loop', until: 'pass', max: 3, deps: [], body: [
      { id: 't', agent: 'c', prompt: 'test' },
    ] },
  ] };
  const done = await runPlan(plan, mkCtx({ c: counter }));
  assert.equal(done.loop.success, true);
  assert.equal(n, 2); // 跑了两轮
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd orch && node --test test/engine.test.js`
预期：FAIL，模块找不到。

- [ ] **Step 3: 写引擎**

`orch/engine.js`:
```js
async function runStep(step, ctx, prevOutput) {
  const adapter = ctx.adapters[step.agent];
  if (!adapter) throw new Error(`未知 agent: ${step.agent}`);
  const prompt = step.prompt.replace('{prev}', prevOutput || '');
  const workdir = await ctx.workspace.make(step.id);
  ctx.onStatus(step.id, 'running');
  const res = await adapter.run({
    prompt, workdir,
    onLine: (line) => ctx.onLog(step.id, line),
  });
  ctx.onStatus(step.id, res.success ? 'done' : 'failed');
  return res;
}

async function runLoop(step, ctx, prevOutput) {
  let last = { output: prevOutput || '', success: false };
  for (let i = 0; i < step.max; i++) {
    for (const body of step.body) {
      last = await runStep(body, ctx, last.output);
      if (!last.success) break; // 本轮某步失败,跳出去重来
    }
    if (step.until === 'pass' && last.success) break;
  }
  ctx.onStatus(step.id, last.success ? 'done' : 'failed');
  return last;
}

// 拓扑按波次调度:每波把"依赖已完成且未启动"的步骤并发跑完再进下一波。
// ponytail: 波次内有 barrier,快步骤要等慢步骤;轻量足够,真要流式再改。
async function runPlan(plan, ctx) {
  const done = {};
  const started = new Set();
  const ready = (s) => s.deps.every((d) => done[d]);
  while (Object.keys(done).length < plan.steps.length) {
    const wave = plan.steps.filter((s) => !started.has(s.id) && ready(s));
    if (wave.length === 0) break; // 依赖无法满足,防死循环
    await Promise.all(wave.map(async (s) => {
      started.add(s.id);
      const prev = s.deps.length ? done[s.deps[0]]?.output : '';
      done[s.id] = s.type === 'loop'
        ? await runLoop(s, ctx, prev)
        : await runStep(s, ctx, prev);
    }));
  }
  return done;
}

module.exports = { runPlan };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd orch && node --test test/engine.test.js`
预期：PASS，3 passing。

- [ ] **Step 5: Commit**

```bash
git add orch/engine.js orch/test/engine.test.js
git commit -m "feat: 执行引擎 调度+循环"
```

---

### Task 5: 工作区隔离（git worktree）

**Files:**
- Create: `orch/workspace.js`
- Test: `orch/test/workspace.test.js`

**Interfaces:**
- Produces: `makeWorkspace(rootRepo) => { make(stepId)->Promise<dir>, merge(stepId)->void }`。非 git 仓时 `make` 回退为 `rootRepo` 本身（共享目录）。

- [ ] **Step 1: 写失败测试**

`orch/test/workspace.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { makeWorkspace } = require('../workspace');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
  execSync('git init -q', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'x');
  execSync('git add . && git -c user.name=t -c user.email=t@t commit -q -m seed', { cwd: dir });
  return dir;
}

test('make 为步骤建独立 worktree 目录', () => {
  const repo = tmpRepo();
  const ws = makeWorkspace(repo);
  const dir = ws.make('dev');
  assert.ok(fs.existsSync(dir));
  assert.ok(fs.existsSync(path.join(dir, 'seed.txt')));
  assert.notEqual(path.resolve(dir), path.resolve(repo));
});

test('非 git 目录回退为共享目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
  const ws = makeWorkspace(dir);
  assert.equal(path.resolve(ws.make('dev')), path.resolve(dir));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd orch && node --test test/workspace.test.js`
预期：FAIL，模块找不到。

- [ ] **Step 3: 写实现**

`orch/workspace.js`:
```js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

function makeWorkspace(rootRepo) {
  const git = isGitRepo(rootRepo);
  return {
    make(stepId) {
      if (!git) return rootRepo; // 回退:共享目录
      const dir = path.join(rootRepo, 'worktrees', stepId);
      const branch = `orch/${stepId}`;
      if (!fs.existsSync(dir)) {
        execSync(`git worktree add -B ${branch} "${dir}"`, { cwd: rootRepo });
      }
      return dir;
    },
    // ponytail: 顺序 merge,无冲突解决;冲突时抛错由上层提示人工处理。
    merge(stepId) {
      if (!git) return;
      execSync(`git merge --no-edit orch/${stepId}`, { cwd: rootRepo });
    },
  };
}

module.exports = { makeWorkspace };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd orch && node --test test/workspace.test.js`
预期：PASS。

- [ ] **Step 5: Commit**

```bash
git add orch/workspace.js orch/test/workspace.test.js
git commit -m "feat: git worktree 工作区隔离"
```

---

### Task 6: 计划生成器（模板 + LLM）

**Files:**
- Create: `orch/planner.js`
- Create: `orch/templates/dev-test-fix.yaml`
- Test: `orch/test/planner.test.js`

**Interfaces:**
- Consumes: claude 适配器（用于 LLM 拆解）。
- Produces: `makePlan(text, { templatesDir, claude }) => Promise<plan>`；`fromTemplate(text, templatesDir) => plan|null`。

- [ ] **Step 1: 写模板文件**

`orch/templates/dev-test-fix.yaml`:
```yaml
match: ""        # 空串=兜底模板,任何任务都匹配(放最后)
steps:
  - id: dev
    agent: claude
    prompt: "实现以下需求,只改必要文件: {task}"
    deps: []
  - id: test
    agent: codex
    prompt: "为刚实现的功能写测试并运行,报告失败项"
    deps: [dev]
  - id: fixloop
    type: loop
    until: pass
    max: 3
    deps: [test]
    body:
      - id: fix
        agent: claude
        prompt: "根据测试失败修复: {prev}"
      - id: retest
        agent: codex
        prompt: "重新运行测试"
```

- [ ] **Step 2: 写失败测试**

`orch/test/planner.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { fromTemplate, makePlan } = require('../planner');

const TPL = path.join(__dirname, '..', 'templates');

test('模板匹配并把 {task} 填进 plan', () => {
  const plan = fromTemplate('做个登录', TPL);
  assert.ok(plan);
  assert.equal(plan.task, '做个登录');
  assert.match(plan.steps[0].prompt, /做个登录/);
  assert.equal(plan.steps[2].type, 'loop');
});

test('无模板时调 LLM 出 plan', async () => {
  const fakeClaude = { async run() {
    return { output: '```json\n{"steps":[{"id":"x","agent":"claude","prompt":"p","deps":[]}]}\n```', success: true };
  } };
  // 用空模板目录强制走 LLM
  const plan = await makePlan('任意', { templatesDir: __dirname, claude: fakeClaude });
  assert.equal(plan.steps[0].id, 'x');
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd orch && node --test test/planner.test.js`
预期：FAIL，模块找不到。

- [ ] **Step 4: 写实现**

`orch/planner.js`:
```js
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// 把 plan 里所有 prompt 的 {task} 替换成任务文本
function fill(steps, task) {
  return steps.map((s) => {
    const out = { ...s };
    if (out.prompt) out.prompt = out.prompt.replace('{task}', task);
    if (out.body) out.body = fill(out.body, task);
    return out;
  });
}

function fromTemplate(text, templatesDir) {
  if (!fs.existsSync(templatesDir)) return null;
  const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.yaml'));
  for (const f of files) {
    const tpl = yaml.load(fs.readFileSync(path.join(templatesDir, f), 'utf8'));
    const m = tpl.match || '';
    if (text.includes(m)) { // 空 match 兜底匹配所有
      return { task: text, steps: fill(tpl.steps, text) };
    }
  }
  return null;
}

function extractJson(s) {
  const m = s.match(/\{[\s\S]*\}/); // 抓第一个 {...} 块
  return JSON.parse(m ? m[0] : s);
}

async function fromLLM(text, claude) {
  const prompt = `把下面的开发任务拆成 JSON,字段 steps,每步 {id,agent,prompt,deps}。`
    + `agent 取值 claude 或 codex。只输出 JSON。任务: ${text}`;
  const { output } = await claude.run({ prompt, workdir: process.cwd(), onLine: () => {} });
  const plan = extractJson(output);
  plan.task = text;
  return plan;
}

async function makePlan(text, { templatesDir, claude }) {
  return fromTemplate(text, templatesDir) || await fromLLM(text, claude);
}

module.exports = { fromTemplate, fromLLM, makePlan };
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd orch && node --test test/planner.test.js`
预期：PASS。
> 注意:测试2 传 `templatesDir: __dirname`(test 目录,无 yaml)以强制走 LLM 分支。

- [ ] **Step 6: Commit**

```bash
git add orch/planner.js orch/templates orch/test/planner.test.js
git commit -m "feat: 计划生成 模板+LLM"
```

---

### Task 7: 后端服务 + 单页前端

**Files:**
- Create: `orch/runner.js`
- Create: `orch/server.js`
- Create: `orch/web/index.html`
- Test: `orch/test/runner.test.js`

**Interfaces:**
- Consumes: `store`、`planner.makePlan`、`engine.runPlan`、`workspace.makeWorkspace`、adapters。
- Produces: `runTask(taskId, deps) => Promise<void>`（把 plan 生成→执行→落库串起来，每条日志回调）。`server.js` 起 HTTP+WS：`POST /task {text}`、`GET /tasks`、`GET /task/:id`、WS 广播 `{taskId, stepId, type, data}`。

- [ ] **Step 1: 写 runner 失败测试**

`orch/test/runner.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../store');
const { runTask } = require('../runner');

test('runTask 用模板跑通并落库(全 echo 适配器)', async () => {
  const store = open(':memory:');
  const id = store.createTask('随便');
  const echo = { async run({ prompt, onLine }) { onLine(prompt); return { output: prompt, success: true }; } };
  await runTask(id, {
    store,
    adapters: { claude: echo, codex: echo },
    workspace: { make: () => '.', merge: () => {} },
    onEvent: () => {},
    makePlan: async () => ({ task: 'x', steps: [
      { id: 'dev', agent: 'claude', prompt: 'p', deps: [] },
    ] }),
  });
  const t = store.getTask(id);
  assert.equal(t.status, 'done');
  assert.equal(t.steps[0].status, 'done');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd orch && node --test test/runner.test.js`
预期：FAIL，模块找不到。

- [ ] **Step 3: 写 runner**

`orch/runner.js`:
```js
const { runPlan } = require('./engine');

// 串起:出 plan → 落库 → 执行(日志/状态实时回调 onEvent + 落库) → 收尾
async function runTask(taskId, deps) {
  const { store, adapters, workspace, onEvent, makePlan } = deps;
  store.setTaskStatus(taskId, 'planning');
  const task = store.getTask(taskId);
  const plan = await makePlan(task.text);
  store.setPlan(taskId, plan);
  store.setTaskStatus(taskId, 'running');
  emit(onEvent, taskId, null, 'plan', plan);

  const agentOf = {};
  const collect = (steps) => steps.forEach((s) => {
    if (s.body) collect(s.body); else agentOf[s.id] = s.agent;
  });
  collect(plan.steps);

  const ctx = {
    adapters,
    workspace,
    onLog: (stepId, line) => {
      store.addLog(taskId, stepId, line);
      emit(onEvent, taskId, stepId, 'log', line);
    },
    onStatus: (stepId, status) => {
      store.setStep(taskId, stepId, agentOf[stepId] || '', status, null);
      emit(onEvent, taskId, stepId, 'status', status);
    },
  };

  try {
    await runPlan(plan, ctx);
    store.setTaskStatus(taskId, 'done');
    emit(onEvent, taskId, null, 'task', 'done');
  } catch (e) {
    store.setTaskStatus(taskId, 'failed');
    emit(onEvent, taskId, null, 'task', 'failed: ' + e.message);
  }
}

function emit(onEvent, taskId, stepId, type, data) {
  if (onEvent) onEvent({ taskId, stepId, type, data });
}

module.exports = { runTask };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd orch && node --test test/runner.test.js`
预期：PASS。

- [ ] **Step 5: 写 server**

`orch/server.js`:
```js
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { open } = require('./store');
const { makePlan } = require('./planner');
const { makeWorkspace } = require('./workspace');
const { runTask } = require('./runner');

const ROOT = process.cwd();
const store = open(path.join(__dirname, 'orch.db'));
const adapters = {
  claude: require('./adapters/claude'),
  codex: require('./adapters/codex'),
};
const workspace = makeWorkspace(ROOT);
const templatesDir = path.join(__dirname, 'templates');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

app.get('/tasks', (req, res) => res.json(store.listTasks()));
app.get('/task/:id', (req, res) => res.json(store.getTask(Number(req.params.id))));
app.post('/task', (req, res) => {
  const id = store.createTask(req.body.text);
  res.json({ id });
  runTask(id, {
    store, adapters, workspace,
    makePlan: (text) => makePlan(text, { templatesDir, claude: adapters.claude }),
    onEvent: broadcast,
  });
});

const server = app.listen(3000, () => console.log('orch http://localhost:3000'));
const wss = new WebSocketServer({ server });
function broadcast(ev) {
  const msg = JSON.stringify(ev);
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
}
```

- [ ] **Step 6: 写单页前端**

`orch/web/index.html`:
```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8"><title>orch</title>
<style>
  body{font:14px/1.5 system-ui;margin:0;display:flex;height:100vh}
  #side{width:240px;border-right:1px solid #ddd;padding:12px;overflow:auto}
  #main{flex:1;display:flex;flex-direction:column;padding:12px;overflow:auto}
  .step{margin:6px 0;padding:6px;border:1px solid #eee;border-radius:6px}
  .running{border-color:#fa0}.done{border-color:#0a0}.failed{border-color:#f00}
  pre{background:#111;color:#0f0;padding:8px;border-radius:6px;white-space:pre-wrap;max-height:40vh;overflow:auto}
  input,button{font:inherit;padding:6px}
</style>
</head>
<body>
<div id="side">
  <h3>orch</h3>
  <input id="t" placeholder="发个任务…" style="width:100%">
  <button onclick="send()">发</button>
  <ul id="tasks"></ul>
</div>
<div id="main">
  <div id="steps"></div>
  <pre id="log"></pre>
</div>
<script>
const steps = {};
async function send(){
  const text = document.getElementById('t').value.trim();
  if(!text) return;
  await fetch('/task',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});
  document.getElementById('t').value='';
  document.getElementById('steps').innerHTML='';
  document.getElementById('log').textContent='';
}
function renderPlan(plan){
  const c=document.getElementById('steps'); c.innerHTML='';
  const walk=(arr)=>arr.forEach(s=>{
    if(s.body){walk(s.body);return;}
    const d=document.createElement('div'); d.className='step'; d.id='s-'+s.id;
    d.textContent=`[${s.agent}] ${s.id}`; c.appendChild(d); steps[s.id]=d;
  });
  walk(plan.steps);
}
const ws=new WebSocket('ws://'+location.host);
ws.onmessage=(e)=>{
  const ev=JSON.parse(e.data);
  if(ev.type==='plan') renderPlan(ev.data);
  if(ev.type==='status'&&steps[ev.stepId]) steps[ev.stepId].className='step '+ev.data;
  if(ev.type==='log'){
    const l=document.getElementById('log');
    l.textContent+=`[${ev.stepId}] ${ev.data}\n`; l.scrollTop=l.scrollHeight;
  }
};
</script>
</body>
</html>
```

- [ ] **Step 7: 手动冒烟（echo 假跑，不烧 token）**

临时把 `server.js` 里 `adapters` 改成 `{ claude: require('./adapters/echo'), codex: require('./adapters/echo') }`，然后：
Run: `cd orch && npm start`
浏览器开 `http://localhost:3000`，发任务"做登录"，预期：看到 dev/test/fixloop 步骤依次变绿，日志区滚动出 echo 行。验证完把 adapters 改回真 claude/codex。

- [ ] **Step 8: Commit**

```bash
git add orch/runner.js orch/server.js orch/web orch/test/runner.test.js
git commit -m "feat: 后端服务 + 单页前端"
```

---

### Task 8: 端到端真跑 + README

**Files:**
- Create: `orch/README.md`

**Interfaces:**
- Produces: 一次真实的 claude+codex 协作跑通记录；最小使用说明。

- [ ] **Step 1: 全测试回归**

Run: `cd orch && npm test`
预期：store/echo/engine/workspace/planner/runner 全 PASS。

- [ ] **Step 2: 真跑一次小任务**

在一个 git 仓里 `npm start`，发一个真实小任务（如"写个把摄氏转华氏的函数并测试"）。
预期：claude 写代码（dev）→ codex 测（test）→ 若失败进 fixloop → 最终 task=done。
观察日志确认 claude/codex 真的被调用、worktree 真的建了。

- [ ] **Step 3: 写 README**

`orch/README.md`：装依赖、`npm start`、发任务、模板在 `templates/`、加新 agent = 往 `adapters/` 加一个文件。一页足够。

- [ ] **Step 4: Commit**

```bash
git add orch/README.md
git commit -m "docs: orch 使用说明"
```

---

## 自检结果

- **Spec 覆盖**：plan 结构(Task4)、模板+LLM混合(Task6)、并行(Task4)、改测循环 loop(Task4/6)、git worktree隔离(Task5)、SQLite(Task2)、Web面板(Task7)、claude+codex适配器(Task3)、错误处理(runner try/catch + 步骤 failed 状态)、echo测试适配器(Task3)、CLI契约风险验证(Task1)。全覆盖。
- **占位符**：无 TBD；每个代码步骤含完整代码。
- **类型一致**：适配器接口 `run({prompt,workdir,onLine})->{output,success}` 全程一致；`runPlan(plan,ctx)`、`makePlan(text,opts)`、`makeWorkspace(root)->{make,merge}`、store 方法名前后一致。
