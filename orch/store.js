const Database = require('better-sqlite3');
const crypto = require('crypto');
// ponytail: sha256 固定盐,localhost 单机够用;真联网就换 scrypt+每人盐
const hashPw = (pw) => crypto.createHash('sha256').update('orch:' + (pw || '')).digest('hex');

function open(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks(
      id INTEGER PRIMARY KEY, text TEXT, status TEXT, plan TEXT,
      project TEXT, owner TEXT, budget REAL, approve INTEGER, isolate TEXT,
      ask INTEGER, dir TEXT, blocked_step TEXT, question TEXT, parent INTEGER,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS apps(
      id INTEGER PRIMARY KEY, name TEXT, task_id INTEGER, dir TEXT, entry TEXT, created_at TEXT);
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
    CREATE TABLE IF NOT EXISTS project_grants(
      project TEXT, user_id TEXT, PRIMARY KEY(project, user_id));
    CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY, task_id INTEGER, ts TEXT, type TEXT, data TEXT);
    CREATE TABLE IF NOT EXISTS usage(
      id INTEGER PRIMARY KEY, task_id INTEGER, step_id TEXT, agent TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cost REAL, ts TEXT);
  `);
  // 迁移:给旧库补列
  const ensureCol = (t, c, type) => { const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name); if (!cols.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`); };
  ensureCol('people', 'password', 'TEXT');
  ensureCol('people', 'admin', 'INTEGER');
  ensureCol('projects', 'owner', 'TEXT');
  return {
    createTask(text, project, owner, opts) {
      const now = new Date().toISOString();
      const o = opts || {};
      return db.prepare('INSERT INTO tasks(text,status,project,owner,budget,approve,isolate,ask,parent,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(text, 'pending', project || '默认项目', owner || '操作者', o.budget || 0, o.approve ? 1 : 0, o.isolate || 'none', o.ask ? 1 : 0, o.parent || null, now, now).lastInsertRowid;
    },
    addApp(d) {
      return db.prepare('INSERT INTO apps(name,task_id,dir,entry,created_at) VALUES(?,?,?,?,?)')
        .run(d.name || '应用', d.taskId, d.dir || '', d.entry || 'index.html', new Date().toISOString()).lastInsertRowid;
    },
    listApps() { return db.prepare('SELECT * FROM apps ORDER BY id DESC').all(); },
    deleteApp(id) { db.prepare('DELETE FROM apps WHERE id=?').run(id); },
    setTaskDir(id, dir) { db.prepare('UPDATE tasks SET dir=? WHERE id=?').run(dir, id); },
    setTaskDecision(id, stepId, question) { db.prepare('UPDATE tasks SET blocked_step=?, question=? WHERE id=?').run(stepId, question, id); },
    clearTaskDecision(id) { db.prepare('UPDATE tasks SET blocked_step=NULL, question=NULL WHERE id=?').run(id); },
    setStepOutput(taskId, stepId, output) { db.prepare('UPDATE steps SET output=? WHERE task_id=? AND step_id=?').run(output, taskId, stepId); },
    doneSteps(taskId) { return db.prepare("SELECT step_id, output FROM steps WHERE task_id=? AND status='done'").all(taskId); },
    setPlan(id, plan) {
      db.prepare('UPDATE tasks SET plan=? WHERE id=?').run(JSON.stringify(plan), id);
    },
    setTaskStatus(id, status) {
      db.prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?').run(status, new Date().toISOString(), id);
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
    addEvent(taskId, type, data) { db.prepare('INSERT INTO events(task_id,ts,type,data) VALUES(?,?,?,?)').run(taskId, new Date().toISOString(), type, JSON.stringify(data == null ? null : data)); },
    getEvents(taskId) { return db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY id').all(taskId); },
    addUsage(taskId, stepId, agent, u) { db.prepare('INSERT INTO usage(task_id,step_id,agent,input_tokens,output_tokens,cost,ts) VALUES(?,?,?,?,?,?,?)').run(taskId, stepId, agent, (u && u.input) || 0, (u && u.output) || 0, (u && u.cost) || 0, new Date().toISOString()); },
    taskUsage(taskId) { const r = db.prepare('SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cost),0) c FROM usage WHERE task_id=?').get(taskId); return { input: r.i, output: r.o, cost: r.c }; },
    usageToday() { const day = new Date().toISOString().slice(0, 10); const r = db.prepare("SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cost),0) c FROM usage WHERE substr(ts,1,10)=?").get(day); return { input: r.i, output: r.o, cost: r.c }; },
    getTask(id) {
      const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      if (!t) return null;
      t.steps = db.prepare('SELECT * FROM steps WHERE task_id=?').all(id);
      return t;
    },
    listTasks() {
      return db.prepare('SELECT id,text,status,project,owner,budget,approve,isolate,ask,dir,blocked_step,question,parent,created_at,updated_at FROM tasks ORDER BY id DESC').all();
    },
    getLogs(taskId) {
      return db.prepare('SELECT step_id,line FROM logs WHERE task_id=? ORDER BY id').all(taskId);
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
      const id = d.id || (String(d.name || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent') + '-' + (db.prepare('SELECT COUNT(*) n FROM agents').get().n + 1);
      db.prepare('INSERT OR REPLACE INTO agents(id,name,command,args,model,caps,color,avatar,dept,pricing,image) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, d.name || id, d.command || '', JSON.stringify(d.args || []), d.model || '—', JSON.stringify(d.caps || []), d.color || '#7C6FD9', d.avatar || (d.name || 'A').slice(0, 1).toUpperCase(), d.dept || 'dev', JSON.stringify(d.pricing || null), d.image || '');
      return id;
    },
    listPeople() { return db.prepare('SELECT * FROM people').all(); },
    getPerson(id) { return db.prepare('SELECT * FROM people WHERE id=?').get(id); },
    addPerson(d) {
      const id = d.id || 'p-' + (db.prepare('SELECT COUNT(*) n FROM people').get().n + 1);
      db.prepare('INSERT OR REPLACE INTO people(id,name,email,role,color,av,password,admin) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, d.name || id, d.email || '', d.role || '成员', d.color || '#E0922E', (d.name || '人').slice(0, 1).toUpperCase(), hashPw(d.password || 'admin'), d.admin ? 1 : 0);
      return id;
    },
    setPassword(id, pw) { db.prepare('UPDATE people SET password=? WHERE id=?').run(hashPw(pw), id); },
    verifyLogin(name, pw) { const p = db.prepare('SELECT * FROM people WHERE name=?').get(name); return (p && p.password === hashPw(pw)) ? p : null; },
    // 部门
    listDepts() { return db.prepare('SELECT * FROM departments ORDER BY created_at').all(); },
    addDept(d) {
      const id = d.id || (String(d.name || 'dept').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dept') + '-' + (db.prepare('SELECT COUNT(*) n FROM departments').get().n + 1);
      db.prepare('INSERT OR REPLACE INTO departments(id,name,glyph,color,created_at) VALUES(?,?,?,?,?)').run(id, d.name || id, d.glyph || '·', d.color || '#7C6FD9', new Date().toISOString());
      return id;
    },
    deleteDept(id) { db.prepare('DELETE FROM departments WHERE id=?').run(id); },
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
      db.prepare('UPDATE agents SET name=?,command=?,args=?,model=?,caps=?,color=?,avatar=?,dept=?,pricing=?,image=? WHERE id=?')
        .run(d.name || id, d.command || '', JSON.stringify(d.args || []), d.model || '—', JSON.stringify(d.caps || []), d.color || '#7C6FD9', d.avatar || (d.name || 'A').slice(0, 1).toUpperCase(), d.dept || 'dev', JSON.stringify(d.pricing || null), d.image || '', id);
    },
    deleteAgent(id) {
      db.prepare('DELETE FROM agents WHERE id=?').run(id);
      db.prepare('DELETE FROM person_agents WHERE agent_id=?').run(id);
    },
    setAgentDept(agentId, deptId) { db.prepare('UPDATE agents SET dept=? WHERE id=?').run(deptId, agentId); },
    addProject(d) {
      const base = (String(d.name || 'proj').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'proj');
      const id = d.id || base + '-' + (db.prepare('SELECT COUNT(*) n FROM projects').get().n + 1);
      db.prepare('INSERT OR REPLACE INTO projects(id,name,client,created_at,owner) VALUES(?,?,?,?,?)').run(id, d.name || id, d.client || '', new Date().toISOString(), d.owner || null);
      return id;
    },
    listProjects() { return db.prepare('SELECT * FROM projects').all(); },
    seed() {
      if (db.prepare('SELECT COUNT(*) n FROM agents').get().n === 0) {
        this.addAgent({ id: 'claude', name: 'Claude', command: 'claude', args: ['-p', '--dangerously-skip-permissions'], model: 'claude CLI', caps: ['代码生成', '重构', '单元测试'], color: '#7C6FD9', avatar: 'C', dept: 'dev', pricing: { in: 3, out: 15 } });
        this.addAgent({ id: 'codex', name: 'Codex', command: 'codex', args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'], model: 'codex CLI', caps: ['功能验证', '回归测试', '沙箱执行'], color: '#4F8BE8', avatar: 'X', dept: 'qa', pricing: { in: 1.25, out: 10 } });
      }
      if (db.prepare('SELECT COUNT(*) n FROM people').get().n === 0) {
        const op = process.env.USERNAME || process.env.USER || 'operator';
        this.addPerson({ id: 'op', name: op, role: '操作者', email: op + '@local', password: 'admin', admin: 1 });
      }
      // 保证有 admin/admin 账号(登录提示一致)
      if (!db.prepare("SELECT 1 FROM people WHERE name='admin'").get()) {
        this.addPerson({ id: 'admin', name: 'admin', role: '管理员', email: 'admin@local', password: 'admin', admin: 1 });
      }
      // 部门 seed
      if (db.prepare('SELECT COUNT(*) n FROM departments').get().n === 0) {
        this.addDept({ id: 'dev', name: '开发部', glyph: '</>', color: '#7C6FD9' });
        this.addDept({ id: 'qa', name: '测试 / QA 部', glyph: '✓', color: '#4F8BE8' });
      }
      // 迁移回填:旧库 people 无密码/admin
      db.prepare("UPDATE people SET password=? WHERE password IS NULL").run(hashPw('admin'));
      if (db.prepare('SELECT COUNT(*) n FROM people WHERE admin=1').get().n === 0) {
        const first = db.prepare('SELECT id FROM people ORDER BY rowid LIMIT 1').get();
        if (first) db.prepare('UPDATE people SET admin=1 WHERE id=?').run(first.id);
      }
    },
    db,
  };
}

module.exports = { open };
