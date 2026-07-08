const Database = require('better-sqlite3');
const crypto = require('crypto');
// ponytail: sha256 固定盐,localhost 单机够用;真联网就换 scrypt+每人盐
const hashPw = (pw) => crypto.createHash('sha256').update('orch:' + (pw || '')).digest('hex');

function open(file) {
  const db = new Database(file);
  // WAL 崩溃安全:默认 rollback-journal 模式在写入中途断电/进程被杀可能损坏整库;WAL 崩溃时最多丢未提交事务,
  // 库不坏,且读写不再互相阻塞(WS 广播期间的读不卡执行的写)。synchronous=NORMAL 是 WAL 下的标准平衡点。
  try { db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL'); } catch (e) {} // :memory: 不支持 WAL,忽略
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks(
      id INTEGER PRIMARY KEY, text TEXT, status TEXT, plan TEXT,
      project TEXT, owner TEXT, budget REAL, approve INTEGER, isolate TEXT,
      ask INTEGER, dir TEXT, blocked_step TEXT, question TEXT, parent INTEGER,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS apps(
      id INTEGER PRIMARY KEY, name TEXT, task_id INTEGER, dir TEXT, entry TEXT,
      type TEXT, static_dir TEXT, start_cmd TEXT, api_prefix TEXT, health_path TEXT,
      port INTEGER, status TEXT, last_error TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS projects(
      id TEXT PRIMARY KEY, name TEXT, client TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS steps(
      task_id INTEGER, step_id TEXT, agent TEXT, status TEXT, output TEXT,
      PRIMARY KEY(task_id, step_id));
    CREATE TABLE IF NOT EXISTS logs(
      id INTEGER PRIMARY KEY, task_id INTEGER, step_id TEXT, line TEXT);
    CREATE TABLE IF NOT EXISTS agents(
      id TEXT PRIMARY KEY, name TEXT, command TEXT, args TEXT,
      model TEXT, caps TEXT, color TEXT, avatar TEXT, dept TEXT,
      pricing TEXT, image TEXT);
    CREATE TABLE IF NOT EXISTS people(
      id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT, color TEXT, av TEXT, password TEXT, admin INTEGER);
    CREATE TABLE IF NOT EXISTS person_agents(
      person_id TEXT, agent_id TEXT, PRIMARY KEY(person_id, agent_id));
    CREATE TABLE IF NOT EXISTS departments(
      id TEXT PRIMARY KEY, name TEXT, glyph TEXT, color TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS roles(
      id TEXT PRIMARY KEY, dept TEXT, name TEXT, emoji TEXT,
      description TEXT, prompt TEXT, executor TEXT);
    CREATE TABLE IF NOT EXISTS dept_agents(
      dept TEXT, agent_id TEXT, PRIMARY KEY(dept, agent_id));
    CREATE TABLE IF NOT EXISTS project_grants(
      project TEXT, user_id TEXT, PRIMARY KEY(project, user_id));
    CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY, task_id INTEGER, ts TEXT, type TEXT, data TEXT);
    CREATE TABLE IF NOT EXISTS task_messages(
      id INTEGER PRIMARY KEY, task_id INTEGER, who TEXT, text TEXT, ts TEXT);
    CREATE TABLE IF NOT EXISTS meetings(
      task_id INTEGER PRIMARY KEY, attendees TEXT, status TEXT, result TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS meeting_msgs(
      id INTEGER PRIMARY KEY, task_id INTEGER, role TEXT, name TEXT, avatar TEXT, text TEXT, ts TEXT);
    CREATE TABLE IF NOT EXISTS playbooks(
      id INTEGER PRIMARY KEY, name TEXT, description TEXT, plan TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS schedules(
      id INTEGER PRIMARY KEY, text TEXT, project TEXT, owner TEXT, spec TEXT,
      dept TEXT, agents TEXT, models TEXT, playbook INTEGER,
      enabled INTEGER, last_run TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS usage(
      id INTEGER PRIMARY KEY, task_id INTEGER, step_id TEXT, agent TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cost REAL, ts TEXT);
    CREATE TABLE IF NOT EXISTS sessions(
      token TEXT PRIMARY KEY, user_id TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS project_knowledge(
      project TEXT PRIMARY KEY, knowledge TEXT);
    CREATE TABLE IF NOT EXISTS plan_versions(
      id INTEGER PRIMARY KEY, task_id INTEGER, version INTEGER, plan TEXT, reason TEXT, created_at TEXT);
    -- 高频按 task_id 过滤/聚合的表加索引:events(getEvents/agentAvgSeconds/pendingRetry/harvest)、usage(taskUsage/usageByTask)、steps、logs
    CREATE INDEX IF NOT EXISTS idx_events_task_type ON events(task_id, type);
    CREATE INDEX IF NOT EXISTS idx_usage_task ON usage(task_id);
    CREATE INDEX IF NOT EXISTS idx_steps_task ON steps(task_id);
    CREATE INDEX IF NOT EXISTS idx_logs_task ON logs(task_id, step_id);
    CREATE INDEX IF NOT EXISTS idx_meeting_msgs_task ON meeting_msgs(task_id);
    -- usage 是增长最快的表(每次 LLM 调用一行);usageToday/usageTodayByAgent 按 ts 范围查,每次 /api/all 都跑,补 ts 索引避免全表扫随历史线性变慢
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
  `);
  // 迁移:给旧库补列
  const ensureCol = (t, c, type) => { const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name); if (!cols.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`); };
  ensureCol('people', 'password', 'TEXT');
  ensureCol('people', 'admin', 'INTEGER');
  ensureCol('projects', 'owner', 'TEXT');
  ensureCol('projects', 'approve', 'INTEGER'); // #4 项目级审批开关(admin 控;开启则本项目任务须审批)
  ensureCol('projects', 'budget', 'REAL'); // #7 项目总成本上限(admin 控;0=不限)
  ensureCol('people', 'budget', 'REAL'); // #7 用户总成本上限(admin 控;0=不限)
  ensureCol('agents', 'kind', 'TEXT');
  ensureCol('agents', 'enabled', 'INTEGER'); // 启用/停用:null/1=启用,0=停用(停用的不进规划器可选列表)
  ensureCol('agents', 'default_model', 'TEXT'); // #4 该执行器的默认大模型(用户没为任务指定时用)
  ensureCol('agents', 'default_effort', 'TEXT'); // #4 该执行器的默认思考级别
  ensureCol('agents', 'base_url', 'TEXT'); // API 型大模型 Agent:OpenAI 兼容地址(填 /v1 或裸域名均可)
  ensureCol('agents', 'api_key', 'TEXT'); // API 型大模型 Agent:密钥(本地单机明文存;绝不进 /api/all 与配置导出)
  ensureCol('departments', 'flow', 'TEXT');
  ensureCol('tasks', 'models', 'TEXT');
  ensureCol('roles', 'memo', 'TEXT');
  ensureCol('roles', 'done_count', 'INTEGER');
  ensureCol('roles', 'empty_count', 'INTEGER');
  ensureCol('people', 'hook_token', 'TEXT');
  ensureCol('tasks', 'replan', 'INTEGER'); // #12 动态重规划 opt-in
  ensureCol('apps', 'type', 'TEXT');
  ensureCol('apps', 'static_dir', 'TEXT');
  ensureCol('apps', 'start_cmd', 'TEXT');
  ensureCol('apps', 'api_prefix', 'TEXT');
  ensureCol('apps', 'health_path', 'TEXT');
  ensureCol('apps', 'port', 'INTEGER');
  ensureCol('apps', 'status', 'TEXT');
  ensureCol('apps', 'last_error', 'TEXT');
  // 自增 id 防碰撞:原 COUNT(*)+1 在删除中间记录后会重算出已存在的 id,配合 INSERT OR REPLACE 静默覆盖另一条记录(数据丢失)。逐个 bump 到空闲。
  const freeAutoId = (table, base) => { let n = db.prepare('SELECT COUNT(*) n FROM ' + table).get().n + 1, id = base + '-' + n; while (db.prepare('SELECT 1 FROM ' + table + ' WHERE id=?').get(id)) id = base + '-' + (++n); return id; };
  const taskArtifactTables = ['steps', 'logs', 'events', 'usage', 'task_messages', 'plan_versions', 'meetings', 'meeting_msgs'];
  const clearTaskArtifacts = (id) => {
    taskArtifactTables.forEach((t) => db.prepare('DELETE FROM ' + t + ' WHERE task_id=?').run(id));
    db.prepare('DELETE FROM apps WHERE task_id=?').run(id);
  };
  db.prepare('SELECT m.task_id FROM meetings m LEFT JOIN tasks t ON t.id=m.task_id WHERE t.id IS NULL OR m.created_at < t.created_at').all()
    .forEach((r) => { db.prepare('DELETE FROM meeting_msgs WHERE task_id=?').run(r.task_id); db.prepare('DELETE FROM meetings WHERE task_id=?').run(r.task_id); });
  return {
    createTask(text, project, owner, opts) {
      const now = new Date().toISOString();
      const o = opts || {};
      const id = db.prepare('INSERT INTO tasks(text,status,project,owner,budget,approve,isolate,ask,replan,parent,models,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(text, 'pending', project || '默认项目', owner || '操作者', o.budget || 0, o.approve ? 1 : 0, o.isolate || 'none', o.ask ? 1 : 0, o.replan ? 1 : 0, o.parent || null, o.models ? JSON.stringify(o.models) : null, now, now).lastInsertRowid;
      clearTaskArtifacts(id); // SQLite rowid 可复用;防旧 steps/会议/应用附身到新任务
      return id;
    },
    addApp(d) {
      return db.prepare('INSERT INTO apps(name,task_id,dir,entry,type,static_dir,start_cmd,api_prefix,health_path,port,status,last_error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(d.name || '应用', d.taskId, d.dir || '', d.entry || 'index.html', d.type || 'static', d.staticDir || d.static_dir || '', d.startCmd || d.start_cmd || '', d.apiPrefix || d.api_prefix || '/api', d.healthPath || d.health_path || '/', Number(d.port) || 0, d.status || (d.startCmd || d.start_cmd ? 'stopped' : 'ready'), d.lastError || d.last_error || '', new Date().toISOString()).lastInsertRowid;
    },
    listApps() { return db.prepare('SELECT * FROM apps ORDER BY id DESC').all(); },
    getApp(id) { return db.prepare('SELECT * FROM apps WHERE id=?').get(id); },
    setAppRuntime(id, d) {
      const cur = this.getApp(id); if (!cur) return false;
      db.prepare('UPDATE apps SET port=?, status=?, last_error=? WHERE id=?')
        .run(d.port == null ? cur.port : Number(d.port), d.status == null ? cur.status : d.status, d.lastError == null ? (d.last_error == null ? cur.last_error : d.last_error) : d.lastError, id);
      return true;
    },
    // 自动构建完成后回填检测结果(entry/类型/静态目录/后端命令等)
    setAppDetect(id, d) {
      const cur = this.getApp(id); if (!cur) return false;
      db.prepare('UPDATE apps SET entry=?, type=?, static_dir=?, start_cmd=?, api_prefix=?, health_path=? WHERE id=?')
        .run(d.entry == null ? cur.entry : d.entry, d.type == null ? cur.type : d.type, d.staticDir == null ? cur.static_dir : d.staticDir, d.startCmd == null ? cur.start_cmd : d.startCmd, d.apiPrefix == null ? cur.api_prefix : d.apiPrefix, d.healthPath == null ? cur.health_path : d.healthPath, id);
      return true;
    },
    isPublishedTask(taskId) { return !!db.prepare('SELECT 1 FROM apps WHERE task_id=? LIMIT 1').get(taskId); }, // 已发布到应用广场→产出视为公开(仅登录用户)
    // 项目级知识/约定:按项目名(任务用名引用)持久化,注入每个任务简报,免每任务从零猜技术栈
    projectKnowledge(name) { const r = db.prepare('SELECT knowledge FROM project_knowledge WHERE project=?').get(name); return (r && r.knowledge) || ''; },
    setProjectKnowledge(name, text) { db.prepare('INSERT OR REPLACE INTO project_knowledge(project,knowledge) VALUES(?,?)').run(name, String(text || '').slice(0, 4000)); },
    // 任务对话:用户与团队的消息流(运行中=指令注入,结束后=继续开发)
    addTaskMsg(taskId, who, text) { db.prepare('INSERT INTO task_messages(task_id,who,text,ts) VALUES(?,?,?,?)').run(taskId, who, text, new Date().toISOString()); },
    getTaskMsgs(taskId) { return db.prepare('SELECT * FROM task_messages WHERE task_id=? ORDER BY id').all(taskId); },
    // 会议室:复杂任务开会讨论需求(员工+用户群聊),结束后产出方案与记录
    createMeeting(taskId, attendees) { db.prepare('DELETE FROM meeting_msgs WHERE task_id=?').run(taskId); db.prepare('INSERT OR REPLACE INTO meetings(task_id,attendees,status,result,created_at) VALUES(?,?,?,?,?)').run(taskId, JSON.stringify(attendees || []), 'open', '', new Date().toISOString()); },
    getMeeting(taskId) { const m = db.prepare('SELECT * FROM meetings WHERE task_id=?').get(taskId); if (m) { try { m.attendees = JSON.parse(m.attendees) || []; } catch (e) { m.attendees = []; } } return m; },
    setMeetingAttendees(taskId, attendees) { db.prepare('UPDATE meetings SET attendees=? WHERE task_id=?').run(JSON.stringify(attendees || []), taskId); },
    setMeetingStatus(taskId, status, result) { db.prepare('UPDATE meetings SET status=?, result=COALESCE(?,result) WHERE task_id=?').run(status, result == null ? null : result, taskId); },
    addMeetingMsg(taskId, m) { db.prepare('INSERT INTO meeting_msgs(task_id,role,name,avatar,text,ts) VALUES(?,?,?,?,?,?)').run(taskId, m.role || '', m.name || '', m.avatar || '', m.text || '', new Date().toISOString()); },
    listMeetingMsgs(taskId) { return db.prepare('SELECT * FROM meeting_msgs WHERE task_id=? ORDER BY id').all(taskId); },
    meetingSummariesByTask() { const m = new Map(); db.prepare('SELECT mt.task_id, mt.status, COUNT(mm.id) msg_count FROM meetings mt LEFT JOIN meeting_msgs mm ON mm.task_id=mt.task_id GROUP BY mt.task_id, mt.status').all().forEach((r) => m.set(r.task_id, { status: r.status, msgCount: r.msg_count || 0 })); return m; },
    // 剧本:成功任务的计划骨架,可复用
    addPlaybook(d) { return db.prepare('INSERT INTO playbooks(name,description,plan,created_at) VALUES(?,?,?,?)').run(d.name || '剧本', d.description || '', JSON.stringify(d.plan || {}), new Date().toISOString()).lastInsertRowid; },
    listPlaybooks() { return db.prepare('SELECT * FROM playbooks ORDER BY id DESC').all(); },
    getPlaybook(id) { return db.prepare('SELECT * FROM playbooks WHERE id=?').get(id); },
    deletePlaybook(id) { db.prepare('DELETE FROM playbooks WHERE id=?').run(id); },
    // 定时任务
    addSchedule(d) { const now = new Date().toISOString(); return db.prepare('INSERT INTO schedules(text,project,owner,spec,dept,agents,models,playbook,enabled,last_run,created_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)').run(d.text, d.project || '默认项目', d.owner, JSON.stringify(d.spec || {}), d.dept || null, JSON.stringify(d.agents || []), d.models ? JSON.stringify(d.models) : null, d.playbook || null, now, now).lastInsertRowid; }, // last_run 播种=created_at:建于槽后当天不误补跑
    listSchedules() { return db.prepare('SELECT * FROM schedules ORDER BY id DESC').all(); },
    setScheduleEnabled(id, on) { db.prepare('UPDATE schedules SET enabled=? WHERE id=?').run(on ? 1 : 0, id); },
    setScheduleRun(id) { db.prepare('UPDATE schedules SET last_run=? WHERE id=?').run(new Date().toISOString(), id); },
    deleteSchedule(id) { db.prepare('DELETE FROM schedules WHERE id=?').run(id); },
    deleteApp(id) { db.prepare('DELETE FROM apps WHERE id=?').run(id); },
    setTaskDir(id, dir) { db.prepare('UPDATE tasks SET dir=? WHERE id=?').run(dir, id); },
    setTaskBudget(id, budget) { db.prepare('UPDATE tasks SET budget=? WHERE id=?').run(Number(budget) || 0, id); }, // 调整成本上限(0=不限),用于解封预算暂停任务
    renameTask(id, text) { db.prepare('UPDATE tasks SET text=?, updated_at=? WHERE id=?').run(String(text || '').slice(0, 2000), new Date().toISOString(), id); }, // #1 任务重命名
    deleteTask(id) { // 级联清任务及其全部关联数据
      db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      clearTaskArtifacts(id); // 含会议数据:task id(rowid)删除后会被复用,残留会议会附身到新任务
    },
    setTaskDecision(id, stepId, question) { db.prepare('UPDATE tasks SET blocked_step=?, question=? WHERE id=?').run(stepId, question, id); },
    clearTaskDecision(id) { db.prepare('UPDATE tasks SET blocked_step=NULL, question=NULL WHERE id=?').run(id); },
    setStepOutput(taskId, stepId, output) { db.prepare('UPDATE steps SET output=? WHERE task_id=? AND step_id=?').run(output, taskId, stepId); },
    doneSteps(taskId) { return db.prepare("SELECT step_id, output FROM steps WHERE task_id=? AND status='done'").all(taskId); },
    // #13 计划版本化:每次动态重规划前快照旧计划,可回滚
    savePlanVersion(taskId, plan, reason) {
      const v = (db.prepare('SELECT MAX(version) m FROM plan_versions WHERE task_id=?').get(taskId).m || 0) + 1;
      db.prepare('INSERT INTO plan_versions(task_id,version,plan,reason,created_at) VALUES(?,?,?,?,?)').run(taskId, v, JSON.stringify(plan || {}), reason || '', new Date().toISOString());
      return v;
    },
    listPlanVersions(taskId) { return db.prepare('SELECT id,version,reason,created_at FROM plan_versions WHERE task_id=? ORDER BY version').all(taskId); },
    getPlanVersion(taskId, version) { return db.prepare('SELECT * FROM plan_versions WHERE task_id=? AND version=?').get(taskId, version); },
    setPlan(id, plan) {
      db.prepare('UPDATE tasks SET plan=? WHERE id=?').run(JSON.stringify(plan), id);
    },
    setTaskStatus(id, status) {
      db.prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?').run(status, new Date().toISOString(), id);
    },
    clearSteps(taskId) { db.prepare('DELETE FROM steps WHERE task_id=?').run(taskId); },
    // 只保留仍在计划里的步骤行:动态重规划会换血 plan.steps,被丢弃的旧步若残留,进度分母虚高、接力记录混入死步
    pruneSteps(taskId, keepIds) {
      const rows = db.prepare('SELECT step_id FROM steps WHERE task_id=?').all(taskId);
      const keep = new Set(keepIds || []);
      const del = db.prepare('DELETE FROM steps WHERE task_id=? AND step_id=?');
      rows.forEach((r) => { if (!keep.has(r.step_id)) del.run(taskId, r.step_id); });
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
    // 日志裁剪:任务终态时保留最近 N 行(流式日志每行入库,长任务几万行,不清理 DB 只涨不减、/api/all 越来越慢)
    trimLogs(taskId, keep) {
      db.prepare('DELETE FROM logs WHERE task_id=? AND id NOT IN (SELECT id FROM logs WHERE task_id=? ORDER BY id DESC LIMIT ?)').run(taskId, taskId, keep || 2000);
    },
    addEvent(taskId, type, data) { db.prepare('INSERT INTO events(task_id,ts,type,data) VALUES(?,?,?,?)').run(taskId, new Date().toISOString(), type, JSON.stringify(data == null ? null : data)); },
    getEvents(taskId) { return db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY id').all(taskId); },
    // 一趟聚合各任务的 auto_retry 事件数:消除 buildAll 里 pendingRetry 对每个 failed 任务一次 getEvents 的 N+1
    autoRetryCounts() { const m = new Map(); db.prepare("SELECT task_id, COUNT(*) c FROM events WHERE type='auto_retry' GROUP BY task_id").all().forEach((r) => m.set(r.task_id, r.c)); return m; },
    // 删除任务时记的目录墓碑(task_id=0 全局):reap 若因锁文件失败残留,importDataDir 据此跳过,不把已删任务当历史产出复活
    deletedDirs() { return db.prepare("SELECT data FROM events WHERE task_id=0 AND type='deleted_dir'").all().map((r) => { try { return JSON.parse(r.data); } catch (e) { return null; } }).filter(Boolean); },
    addUsage(taskId, stepId, agent, u) { db.prepare('INSERT INTO usage(task_id,step_id,agent,input_tokens,output_tokens,cost,ts) VALUES(?,?,?,?,?,?,?)').run(taskId, stepId, agent, (u && u.input) || 0, (u && u.output) || 0, (u && u.cost) || 0, new Date().toISOString()); },
    taskUsage(taskId) { const r = db.prepare('SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cost),0) c FROM usage WHERE task_id=?').get(taskId); return { input: r.i, output: r.o, cost: r.c }; },
    usageByTask() { const m = new Map(); db.prepare('SELECT task_id, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cost),0) c FROM usage GROUP BY task_id').all().forEach((r) => m.set(r.task_id, { input: r.i, output: r.o, cost: r.c })); return m; }, // 一趟聚合,消除 buildAll 每任务 taskUsage 的 N+1
    stepCosts(taskId) { const m = {}; db.prepare('SELECT step_id, COALESCE(SUM(cost),0) c FROM usage WHERE task_id=? GROUP BY step_id').all(taskId).forEach((r) => { m[r.step_id] = r.c; }); return m; }, // 每步成本(供接力展示)
    // "今日"按本地日边界(与 api.isToday 的 toDateString 一致);ts 存 UTC,取本地零点的 UTC ISO 作下界,ts>=该值即今日
    usageToday() { const n = new Date(); const start = new Date(n.getFullYear(), n.getMonth(), n.getDate()).toISOString(); const r = db.prepare("SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cost),0) c FROM usage WHERE ts>=?").get(start); return { input: r.i, output: r.o, cost: r.c }; },
    usageTodayByAgent() { const n = new Date(); const start = new Date(n.getFullYear(), n.getMonth(), n.getDate()).toISOString(); return db.prepare("SELECT agent, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cost),0) c, COUNT(*) n FROM usage WHERE ts>=? GROUP BY agent ORDER BY c DESC").all(start); },
    usageAllTime() { const r = db.prepare('SELECT COALESCE(SUM(cost),0) c, COUNT(*) n FROM usage').get(); return { cost: r.c, calls: r.n }; },
    agentTotals(id) { const r = db.prepare('SELECT COALESCE(SUM(cost),0) c, COUNT(*) n FROM usage WHERE agent=?').get(id); return { cost: r.c, calls: r.n }; }, // 单执行器累计成本(agent详情)
    // 一趟聚合所有执行器累计成本,消除 buildAll 每执行器一次 agentTotals
    agentTotalsAll() { const m = new Map(); db.prepare('SELECT agent, COALESCE(SUM(cost),0) c, COUNT(*) n FROM usage GROUP BY agent').all().forEach((r) => m.set(r.agent, { cost: r.c, calls: r.n })); return m; },
    // 一趟算出所有执行器的平均耗时(秒):替代 buildAll 里每执行器 agentAvgSeconds(内部对其参与的每个历史任务拉一次 events 全表)。
    // 单次全表扫 status events(ORDER BY id 保序,start 按 task 隔离)+ 单次扫 done steps,等价于原逐个算法。
    agentAvgSecondsAll() {
      const stepAgent = {}; // task_id → {step_id: agent}(仅 done 步)
      db.prepare("SELECT task_id, step_id, agent FROM steps WHERE status='done'").all().forEach((r) => { (stepAgent[r.task_id] = stepAgent[r.task_id] || {})[r.step_id] = r.agent; });
      const acc = {}; // agent → {total, n}
      const startByTask = {}; // task_id → {step: startMs}(events 全局混序,须按任务隔离)
      db.prepare("SELECT task_id, ts, data FROM events WHERE type='status' ORDER BY id").all().forEach((e) => {
        let d; try { d = JSON.parse(e.data); } catch (x) { return; }
        if (!d || !d.step) return;
        const st = startByTask[e.task_id] || (startByTask[e.task_id] = {});
        if (d.v === 'running') st[d.step] = new Date(e.ts).getTime();
        else if (d.v === 'done' && st[d.step]) {
          const ag = stepAgent[e.task_id] && stepAgent[e.task_id][d.step];
          if (ag) { const a = acc[ag] || (acc[ag] = { total: 0, n: 0 }); a.total += (new Date(e.ts).getTime() - st[d.step]) / 1000; a.n++; }
          delete st[d.step];
        }
      });
      const m = new Map();
      Object.keys(acc).forEach((ag) => { const a = acc[ag]; m.set(ag, a.n ? Math.round(a.total / a.n) : 0); });
      return m;
    },
    // 某步最后一行日志(idx_logs_task 命中);替代 buildAll 拉整任务全部日志再倒序找
    lastLogLine(taskId, stepId) { const r = db.prepare('SELECT line FROM logs WHERE task_id=? AND step_id=? ORDER BY id DESC LIMIT 1').get(taskId, stepId); return (r && r.line) || ''; },
    // 该执行器已完成步骤的平均耗时(秒):从 status 事件的 running→done 时差算
    agentAvgSeconds(id) {
      const rows = db.prepare("SELECT DISTINCT task_id FROM steps WHERE agent=? AND status='done'").all(id);
      const mySteps = {}; db.prepare("SELECT task_id, step_id FROM steps WHERE agent=? AND status='done'").all(id).forEach((r) => { (mySteps[r.task_id] = mySteps[r.task_id] || {})[r.step_id] = 1; });
      let total = 0, n = 0;
      rows.forEach(({ task_id }) => {
        const evs = db.prepare("SELECT ts, data FROM events WHERE task_id=? AND type='status' ORDER BY id").all(task_id);
        const start = {};
        evs.forEach((e) => { let d; try { d = JSON.parse(e.data); } catch (x) { return; } if (!d || !d.step) return;
          if (d.v === 'running') start[d.step] = new Date(e.ts).getTime();
          else if (d.v === 'done' && start[d.step] && mySteps[task_id] && mySteps[task_id][d.step]) { total += (new Date(e.ts).getTime() - start[d.step]) / 1000; n++; delete start[d.step]; }
        });
      });
      return n ? Math.round(total / n) : 0;
    },
    getTask(id) {
      const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      if (!t) return null;
      t.steps = db.prepare('SELECT * FROM steps WHERE task_id=?').all(id);
      return t;
    },
    listTasks() {
      return db.prepare('SELECT id,text,status,project,owner,budget,approve,isolate,ask,replan,models,dir,blocked_step,question,parent,created_at,updated_at FROM tasks ORDER BY id DESC').all();
    },
    // 一趟批量拿所有任务的 plan(id→plan 字符串):供 buildAll 消除逐任务 getTask 的 N+1
    //(getTask 每次含一个冗余的 steps 全表子查询,而 buildAll 顶部 allSteps 已全量拿过)
    plansByTask() { const m = new Map(); db.prepare('SELECT id, plan FROM tasks').all().forEach((r) => m.set(r.id, r.plan)); return m; },
    getLogs(taskId) {
      return db.prepare('SELECT step_id,line FROM logs WHERE task_id=? ORDER BY id').all(taskId);
    },
    // 内容搜索:任务需求 + 各步产出 + 用户对话里匹配关键词,返回匹配任务(带命中片段)
    searchContent(q, limit) {
      const like = '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%'; const ql = q.toLowerCase(); // 转义 LIKE 通配符:搜 "100%"/"a_b" 不再全表误匹配
      // 用户对话用 EXISTS 子查询(避免 steps×messages 笛卡尔膨胀);限 who='user' 聚焦用户意图/决策,避开系统样板噪声
      const rows = db.prepare("SELECT DISTINCT t.id, t.text, t.project, t.owner, t.status FROM tasks t LEFT JOIN steps s ON s.task_id=t.id WHERE t.text LIKE ? ESCAPE '\\' OR s.output LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM task_messages m WHERE m.task_id=t.id AND m.who='user' AND m.text LIKE ? ESCAPE '\\') ORDER BY t.id DESC LIMIT ?").all(like, like, like, limit || 30);
      return rows.map((t) => {
        let snip = '';
        if (!String(t.text || '').toLowerCase().includes(ql)) {
          const st = db.prepare("SELECT output FROM steps WHERE task_id=? AND output LIKE ? ESCAPE '\\' LIMIT 1").get(t.id, like);
          if (st && st.output) { const i = st.output.toLowerCase().indexOf(ql); snip = st.output.slice(Math.max(0, i - 30), i + 60).replace(/\s+/g, ' '); }
          if (!snip) { const mm = db.prepare("SELECT text FROM task_messages WHERE task_id=? AND who='user' AND text LIKE ? ESCAPE '\\' LIMIT 1").get(t.id, like); if (mm && mm.text) { const i = mm.text.toLowerCase().indexOf(ql); snip = '💬 ' + mm.text.slice(Math.max(0, i - 30), i + 60).replace(/\s+/g, ' '); } }
        }
        return { id: t.id, text: t.text, project: t.project, owner: t.owner, status: t.status, snip };
      });
    },
    allSteps() {
      return db.prepare('SELECT * FROM steps').all();
    },
    recentLogsForAgent(agent, limit) {
      return db.prepare(
        `SELECT l.task_id, l.step_id, l.line FROM logs l
         JOIN steps s ON s.task_id=l.task_id AND s.step_id=l.step_id
         WHERE s.agent=? ORDER BY l.id DESC LIMIT ?`
      ).all(agent, limit || 40).reverse();
    },
    listAgents() { return db.prepare('SELECT * FROM agents').all(); },
    addAgent(d) {
      const id = d.id || freeAutoId('agents', String(d.name || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent');
      // upsert 而非 REPLACE:REPLACE 会擦掉不在列清单里的 enabled/default_model/default_effort;api_key 空传=保留旧值
      db.prepare(`INSERT INTO agents(id,name,command,args,model,caps,color,avatar,dept,pricing,image,kind,base_url,api_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,command=excluded.command,args=excluded.args,model=excluded.model,caps=excluded.caps,color=excluded.color,avatar=excluded.avatar,dept=excluded.dept,pricing=excluded.pricing,image=excluded.image,kind=excluded.kind,base_url=excluded.base_url,api_key=CASE WHEN excluded.api_key='' THEN agents.api_key ELSE excluded.api_key END`)
        .run(id, d.name || id, d.command || '', JSON.stringify(d.args || []), d.model || '—', JSON.stringify(d.caps || []), d.color || '#7C6FD9', d.avatar || (d.name || 'A').slice(0, 1).toUpperCase(), d.dept || 'dev', JSON.stringify(d.pricing || null), d.image || '', d.kind || 'cli', d.base_url || '', d.api_key || '');
      return id;
    },
    listPeople() { return db.prepare('SELECT * FROM people').all(); },
    getPerson(id) { return db.prepare('SELECT * FROM people WHERE id=?').get(id); },
    addPerson(d) {
      const id = d.id || freeAutoId('people', 'p');
      db.prepare('INSERT OR REPLACE INTO people(id,name,email,role,color,av,password,admin) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, d.name || id, d.email || '', d.role || '成员', d.color || '#E0922E', (d.name || '人').slice(0, 1).toUpperCase(), hashPw(d.password || 'admin'), d.admin ? 1 : 0);
      return id;
    },
    setPassword(id, pw) { db.prepare('UPDATE people SET password=? WHERE id=?').run(hashPw(pw), id); },
    // Webhook token:外部系统凭 token 触发任务
    ensureHookToken(id) {
      const p = this.getPerson(id); if (!p) return null;
      if (p.hook_token) return p.hook_token;
      const t = crypto.randomBytes(16).toString('hex');
      db.prepare('UPDATE people SET hook_token=? WHERE id=?').run(t, id);
      return t;
    },
    resetHookToken(id) { const t = crypto.randomBytes(16).toString('hex'); db.prepare('UPDATE people SET hook_token=? WHERE id=?').run(t, id); return t; }, // 直接返回新 token,不再 getPerson(id).hook_token(id 不存在会抛)
    personByHookToken(tok) { return tok ? db.prepare('SELECT * FROM people WHERE hook_token=?').get(tok) : null; },
    verifyLogin(name, pw) { const p = db.prepare('SELECT * FROM people WHERE name=?').get(name); return (p && p.password === hashPw(pw)) ? p : null; },
    // 会话:落库,进程重启不掉线(单机本地工具);30 天过期,读时惰性清理
    addSession(token, userId) { db.prepare('INSERT OR REPLACE INTO sessions(token,user_id,created_at) VALUES(?,?,?)').run(token, userId, new Date().toISOString()); },
    sessionUser(token) {
      if (!token) return null;
      const r = db.prepare('SELECT user_id, created_at FROM sessions WHERE token=?').get(token);
      if (!r) return null;
      if (Date.now() - new Date(r.created_at).getTime() > 30 * 24 * 3600 * 1000) { db.prepare('DELETE FROM sessions WHERE token=?').run(token); return null; }
      return r.user_id;
    },
    delSession(token) { if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token); },
    // 部门
    listDepts() { return db.prepare('SELECT * FROM departments ORDER BY created_at').all(); },
    addDept(d) {
      const id = d.id || freeAutoId('departments', String(d.name || 'dept').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dept');
      db.prepare('INSERT OR REPLACE INTO departments(id,name,glyph,color,created_at) VALUES(?,?,?,?,?)').run(id, d.name || id, d.glyph || '·', d.color || '#7C6FD9', new Date().toISOString());
      return id;
    },
    deleteDept(id) { db.prepare('DELETE FROM departments WHERE id=?').run(id); db.prepare('DELETE FROM dept_agents WHERE dept=?').run(id); },
    setDeptFlow(id, flow) { db.prepare('UPDATE departments SET flow=? WHERE id=?').run(JSON.stringify(flow || []), id); },
    deptFlow(id) { const r = db.prepare('SELECT flow FROM departments WHERE id=?').get(id); try { return JSON.parse(r && r.flow) || []; } catch (e) { return []; } },
    // 部门执行器池:该部门任务只能用这些执行器(空=不限)
    setDeptExecutors(dept, ids) {
      db.prepare('DELETE FROM dept_agents WHERE dept=?').run(dept);
      const ins = db.prepare('INSERT OR IGNORE INTO dept_agents(dept,agent_id) VALUES(?,?)');
      (ids || []).forEach((a) => ins.run(dept, a));
    },
    deptExecutors(dept) { return db.prepare('SELECT agent_id FROM dept_agents WHERE dept=?').all(dept).map((r) => r.agent_id); },
    allDeptExecutors() { const m = {}; db.prepare('SELECT * FROM dept_agents').all().forEach((r) => { (m[r.dept] = m[r.dept] || []).push(r.agent_id); }); return m; },
    // 角色(部门员工)
    listRoles() { return db.prepare('SELECT * FROM roles ORDER BY dept, id').all(); },
    getRole(id) { return db.prepare('SELECT * FROM roles WHERE id=?').get(id); },
    // 组织级绩效:员工步骤有落盘=done+1,空转=empty+1
    addRoleStat(id, produced) { db.prepare('UPDATE roles SET ' + (produced ? 'done_count=COALESCE(done_count,0)+1' : 'empty_count=COALESCE(empty_count,0)+1') + ' WHERE id=?').run(id); },
    addRole(d) {
      const id = d.id || freeAutoId('roles', String(d.name || 'role').toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-') || 'role');
      // upsert 而非 REPLACE:REPLACE 会把不在列清单里的 memo/done_count/empty_count 置空——
      // roles-seed 版本升级与配置导入会把全员经验与绩效清零,摧毁"越用越聪明"的根基
      db.prepare(`INSERT INTO roles(id,dept,name,emoji,description,prompt,executor) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET dept=excluded.dept,name=excluded.name,emoji=excluded.emoji,description=excluded.description,prompt=excluded.prompt,executor=excluded.executor`)
        .run(id, d.dept || 'engineering', d.name || id, d.emoji || '🧑‍💼', d.description || '', d.prompt || '', d.executor || 'claude');
      return id;
    },
    deleteRole(id) { db.prepare('DELETE FROM roles WHERE id=?').run(id); },
    // 重置员工经验与绩效(保留角色卡本身):memo/落盘/空转清零
    resetRoleLearning(id) { const r = db.prepare('SELECT id FROM roles WHERE id=?').get(id); if (!r) return false; db.prepare('UPDATE roles SET memo=NULL, done_count=NULL, empty_count=NULL WHERE id=?').run(id); return true; },
    // 编辑角色卡:只改名称/描述/提示词/执行器,保留 memo 与绩效(不用 addRole 的 REPLACE 以免擦经验)
    updateRole(id, d) { const r = db.prepare('SELECT id FROM roles WHERE id=?').get(id); if (!r) return false; db.prepare('UPDATE roles SET name=?,description=?,prompt=?,executor=? WHERE id=?').run(d.name || id, d.description || '', d.prompt || '', d.executor || 'claude', id); return true; },
    setRoleMemo(id, memo) { db.prepare('UPDATE roles SET memo=? WHERE id=?').run(memo || '', id); }, // 导入恢复用:整段设置 memo
    // 员工经验备忘:追加一条(与已有高度相似则跳过去重),保留最近10条(越用越聪明)
    appendRoleMemo(id, line) {
      const r = db.prepare('SELECT memo FROM roles WHERE id=?').get(id);
      if (!r || !line) return;
      const clean = String(line).replace(/\n/g, ' ').slice(0, 120);
      const toks = (s) => new Set((s.toLowerCase().match(/[a-z0-9]+|[一-鿿]/gi) || [])); // 英文词+中文字
      const nw = toks(clean);
      const existing = (r.memo || '').split('\n').filter(Boolean);
      const dup = existing.some((e) => { const ew = toks(e); const inter = [...nw].filter((w) => ew.has(w)).length; const uni = new Set([...nw, ...ew]).size; return uni && inter / uni > 0.45; });
      if (dup) return; // 与已有经验高度重叠:不重复记
      const lines = existing.concat([clean]).slice(-10);
      db.prepare('UPDATE roles SET memo=? WHERE id=?').run(lines.join('\n'), id);
    },
    // 项目授权
    grantProject(project, userId) { db.prepare('INSERT OR IGNORE INTO project_grants(project,user_id) VALUES(?,?)').run(project, userId); },
    revokeProject(project, userId) { db.prepare('DELETE FROM project_grants WHERE project=? AND user_id=?').run(project, userId); },
    listGrants() { return db.prepare('SELECT * FROM project_grants').all(); },
    grantsFor(project) { return db.prepare('SELECT user_id FROM project_grants WHERE project=?').all(project).map((r) => r.user_id); },
    setPersonAgents(pid, ids) {
      db.prepare('DELETE FROM person_agents WHERE person_id=?').run(pid);
      const ins = db.prepare('INSERT OR IGNORE INTO person_agents(person_id,agent_id) VALUES(?,?)');
      (ids || []).forEach((a) => ins.run(pid, a));
    },
    listPersonAgents(pid) { return db.prepare('SELECT agent_id FROM person_agents WHERE person_id=?').all(pid).map((r) => r.agent_id); },
    updateAgent(id, d) {
      // api_key 编辑留空 = 保留旧 Key(前端不回显明文,空提交不该清空);base_url 直接覆盖
      db.prepare("UPDATE agents SET name=?,command=?,args=?,model=?,caps=?,color=?,avatar=?,dept=?,pricing=?,image=?,kind=?,base_url=?,api_key=COALESCE(NULLIF(?, ''),api_key) WHERE id=?")
        .run(d.name || id, d.command || '', JSON.stringify(d.args || []), d.model || '—', JSON.stringify(d.caps || []), d.color || '#7C6FD9', d.avatar || (d.name || 'A').slice(0, 1).toUpperCase(), d.dept || 'dev', JSON.stringify(d.pricing || null), d.image || '', d.kind || 'cli', d.base_url || '', d.api_key || '', id);
    },
    deleteAgent(id) {
      db.prepare('DELETE FROM agents WHERE id=?').run(id);
      db.prepare('DELETE FROM person_agents WHERE agent_id=?').run(id);
    },
    setAgentDept(agentId, deptId) { db.prepare('UPDATE agents SET dept=? WHERE id=?').run(deptId, agentId); },
    setAgentEnabled(id, on) { db.prepare('UPDATE agents SET enabled=? WHERE id=?').run(on ? 1 : 0, id); }, // 停用的 agent 不进规划器可选列表
    setAgentDefaults(id, model, effort) { db.prepare('UPDATE agents SET default_model=?, default_effort=? WHERE id=?').run(model || '', effort || '', id); }, // #4 执行器默认模型/思考级别
    addProject(d) {
      const id = d.id || freeAutoId('projects', String(d.name || 'proj').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'proj');
      db.prepare('INSERT OR REPLACE INTO projects(id,name,client,created_at,owner) VALUES(?,?,?,?,?)').run(id, d.name || id, d.client || '', new Date().toISOString(), d.owner || null);
      return id;
    },
    listProjects() { return db.prepare('SELECT * FROM projects').all(); },
    // #4 项目级审批:admin 开启后本项目所有任务须先审批再执行(默认关)
    setProjectApprove(name, on) { const r = db.prepare('SELECT id FROM projects WHERE name=?').get(name); if (r) db.prepare('UPDATE projects SET approve=? WHERE name=?').run(on ? 1 : 0, name); else db.prepare('INSERT INTO projects(id,name,created_at,approve) VALUES(?,?,?,?)').run(name, name, new Date().toISOString(), on ? 1 : 0); },
    projectApprove(name) { const r = db.prepare('SELECT approve FROM projects WHERE name=?').get(name); return !!(r && r.approve); },
    // #7 项目/用户总成本:admin 设上限,执行时按项目/用户累计花费核算(超限则暂停,类似日成本护栏)
    setProjectBudget(name, amt) { const r = db.prepare('SELECT id FROM projects WHERE name=?').get(name); if (r) db.prepare('UPDATE projects SET budget=? WHERE name=?').run(Number(amt) || 0, name); else db.prepare('INSERT INTO projects(id,name,created_at,budget) VALUES(?,?,?,?)').run(name, name, new Date().toISOString(), Number(amt) || 0); },
    projectBudgetOf(name) { const r = db.prepare('SELECT budget FROM projects WHERE name=?').get(name); return (r && r.budget) || 0; },
    projectSpend(name) { const r = db.prepare('SELECT COALESCE(SUM(u.cost),0) c FROM usage u JOIN tasks t ON u.task_id=t.id WHERE t.project=?').get(name); return r.c || 0; },
    setUserBudget(id, amt) { db.prepare('UPDATE people SET budget=? WHERE id=?').run(Number(amt) || 0, id); },
    userBudgetOf(name) { const r = db.prepare('SELECT budget FROM people WHERE name=?').get(name); return (r && r.budget) || 0; },
    userSpend(name) { const r = db.prepare('SELECT COALESCE(SUM(u.cost),0) c FROM usage u JOIN tasks t ON u.task_id=t.id WHERE t.owner=?').get(name); return r.c || 0; },
    seed() {
      if (db.prepare('SELECT COUNT(*) n FROM agents').get().n === 0) {
        this.addAgent({ id: 'claude', name: 'Claude', command: 'claude', args: ['-p', '--dangerously-skip-permissions'], model: 'claude CLI', caps: ['代码生成', '重构', '单元测试'], color: '#7C6FD9', avatar: 'C', dept: 'dev', pricing: { in: 3, out: 15 } });
        this.addAgent({ id: 'codex', name: 'Codex', command: 'codex', args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'], model: 'codex CLI', caps: ['功能验证', '回归测试', '沙箱执行'], color: '#4F8BE8', avatar: 'X', dept: 'qa', pricing: { in: 1.25, out: 10 } });
      }
      // 初始管理员密码:公网部署时设 ORCH_ADMIN_PASSWORD 避免默认弱口令 admin/admin(仅首次建库生效,已有库不改)
      const initPw = process.env.ORCH_ADMIN_PASSWORD || 'admin';
      if (db.prepare('SELECT COUNT(*) n FROM people').get().n === 0) {
        const op = process.env.USERNAME || process.env.USER || 'operator';
        this.addPerson({ id: 'op', name: op, role: '操作者', email: op + '@local', password: initPw, admin: 1 });
      }
      // 总调度经验行(存调度复盘,__system 部门不显示在员工墙)
      if (!db.prepare("SELECT 1 FROM roles WHERE id='chief-orchestrator'").get()) {
        this.addRole({ id: 'chief-orchestrator', dept: '__system', name: '总调度', emoji: '🎭', description: '任务拆解调度分配,最高权限', prompt: '' });
      }
      // 保证有 admin 账号(登录提示一致);密码同样支持 ORCH_ADMIN_PASSWORD(仅首次建此账号时)
      if (!db.prepare("SELECT 1 FROM people WHERE name='admin'").get()) {
        this.addPerson({ id: 'admin', name: 'admin', role: '管理员', email: 'admin@local', password: initPw, admin: 1 });
      }
      // 迁移:dev/qa 旧部门并入 工程部/测试部(执行器归属跟随)
      db.prepare("UPDATE agents SET dept='engineering' WHERE dept='dev'").run();
      db.prepare("UPDATE agents SET dept='testing' WHERE dept='qa'").run();
      db.prepare("DELETE FROM departments WHERE id IN ('dev','qa')").run();
      const DEPTS = [
        ['engineering', '工程部', '</>', '#7C6FD9'], ['design', '设计部', '✎', '#2FAE9E'],
        ['product', '产品部', '◧', '#E0922E'], ['testing', '测试部', '✓', '#4F8BE8'],
        ['project-management', '项目管理部', '▤', '#8A6FD0'], ['marketing', '营销部', '📣', '#E06A63'],
        ['sales', '销售部', '¥', '#2E9E5B'], ['security', '安全部', '🛡', '#B4541E'],
        ['finance', '金融部', '𝟙', '#1F7A46'], ['legal', '法务部', '§', '#6B6760'],
        ['hr', '人力资源部', '👥', '#D96FA8'], ['support', '支持部', '☎', '#4F8BE8'],
        ['strategy', '战略部', '♟', '#1A1814'], ['supply-chain', '供应链部', '⛓', '#8A857C'],
        ['game-development', '游戏开发部', '🎮', '#9B59B6'], ['specialized', '专项部', '★', '#F0B400'],
        ['paid-media', '付费媒体部', '◎', '#E0922E'], ['academic', '学术部', '🎓', '#7C6FD9'],
        ['gis', 'GIS部', '🌍', '#2E9E5B'], ['spatial-computing', '空间计算部', '🥽', '#4F8BE8'],
      ];
      DEPTS.forEach(([id, name, glyph, color]) => {
        if (!db.prepare('SELECT 1 FROM departments WHERE id=?').get(id)) this.addDept({ id, name, glyph, color });
      });
      // 员工种子:roles-seed.json(由 agency-agents-zh 原文压缩生成)
      // seedVersion 升级时覆盖已有员工卡(深度升级);用户自建员工(id 不在种子内)不动
      try {
        const seed = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'roles-seed.json'), 'utf8'));
        const ver = String(seed.version || 1);
        const cur = (db.prepare("SELECT data FROM events WHERE task_id=0 AND type='seed_roles' ORDER BY id DESC LIMIT 1").get() || {}).data;
        if (cur !== JSON.stringify(ver)) {
          (seed.depts || seed).forEach((d) => {
            (d.employees || []).forEach((e) => this.addRole({
              id: e.id, dept: d.dept, name: e.name, emoji: e.emoji, description: e.description, prompt: e.prompt,
              executor: d.dept === 'testing' ? 'codex' : 'claude',
            }));
            if (d.flow && d.flow.length && !this.deptFlow(d.dept).length) this.setDeptFlow(d.dept, d.flow);
          });
          this.addEvent(0, 'seed_roles', ver);
        }
      } catch (e) { /* 种子文件缺失则跳过 */ }
      // 迁移回填:旧库 people 无密码/admin
      db.prepare("UPDATE people SET password=? WHERE password IS NULL").run(hashPw('admin'));
      if (db.prepare('SELECT COUNT(*) n FROM people WHERE admin=1').get().n === 0) {
        const first = db.prepare('SELECT id FROM people ORDER BY rowid LIMIT 1').get();
        if (first) db.prepare('UPDATE people SET admin=1 WHERE id=?').run(first.id);
      }
    },
    // 在线备份(整合 WAL,不阻塞写):db.backup 是原子的,备份中途崩溃不影响主库
    backup(dest) { return db.backup(dest); },
    db,
  };
}

module.exports = { open };
