const Database = require('better-sqlite3');

function open(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks(
      id INTEGER PRIMARY KEY, text TEXT, status TEXT, plan TEXT,
      project TEXT, owner TEXT, budget REAL, approve INTEGER, isolate TEXT,
      ask INTEGER, dir TEXT, blocked_step TEXT, question TEXT,
      created_at TEXT, updated_at TEXT);
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
      id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT, color TEXT, av TEXT);
    CREATE TABLE IF NOT EXISTS person_agents(
      person_id TEXT, agent_id TEXT, PRIMARY KEY(person_id, agent_id));
    CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY, task_id INTEGER, ts TEXT, type TEXT, data TEXT);
    CREATE TABLE IF NOT EXISTS usage(
      id INTEGER PRIMARY KEY, task_id INTEGER, step_id TEXT, agent TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cost REAL, ts TEXT);
  `);
  return {
    createTask(text, project, owner, opts) {
      const now = new Date().toISOString();
      const o = opts || {};
      return db.prepare('INSERT INTO tasks(text,status,project,owner,budget,approve,isolate,ask,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(text, 'pending', project || '默认项目', owner || '操作者', o.budget || 0, o.approve ? 1 : 0, o.isolate || 'none', o.ask ? 1 : 0, now, now).lastInsertRowid;
    },
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
      return db.prepare('SELECT id,text,status,project,owner,budget,approve,isolate,ask,dir,blocked_step,question,created_at,updated_at FROM tasks ORDER BY id DESC').all();
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
    addPerson(d) {
      const id = d.id || 'p-' + (db.prepare('SELECT COUNT(*) n FROM people').get().n + 1);
      db.prepare('INSERT OR REPLACE INTO people(id,name,email,role,color,av) VALUES(?,?,?,?,?,?)')
        .run(id, d.name || id, d.email || '', d.role || '成员', d.color || '#E0922E', (d.name || '人').slice(0, 1).toUpperCase());
      return id;
    },
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
    addProject(d) {
      const base = (String(d.name || 'proj').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'proj');
      const id = d.id || base + '-' + (db.prepare('SELECT COUNT(*) n FROM projects').get().n + 1);
      db.prepare('INSERT OR REPLACE INTO projects(id,name,client,created_at) VALUES(?,?,?,?)').run(id, d.name || id, d.client || '', new Date().toISOString());
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
        this.addPerson({ id: 'op', name: op, role: '操作者', email: op + '@local' });
      }
    },
    db,
  };
}

module.exports = { open };
