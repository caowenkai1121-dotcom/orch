const Database = require('better-sqlite3');

function open(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks(
      id INTEGER PRIMARY KEY, text TEXT, status TEXT, plan TEXT,
      project TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS steps(
      task_id INTEGER, step_id TEXT, agent TEXT, status TEXT, output TEXT,
      PRIMARY KEY(task_id, step_id));
    CREATE TABLE IF NOT EXISTS logs(
      id INTEGER PRIMARY KEY, task_id INTEGER, step_id TEXT, line TEXT);
    CREATE TABLE IF NOT EXISTS agents(
      id TEXT PRIMARY KEY, name TEXT, command TEXT, args TEXT,
      model TEXT, caps TEXT, color TEXT, avatar TEXT, dept TEXT);
    CREATE TABLE IF NOT EXISTS people(
      id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT, color TEXT, av TEXT);
    CREATE TABLE IF NOT EXISTS person_agents(
      person_id TEXT, agent_id TEXT, PRIMARY KEY(person_id, agent_id));
  `);
  return {
    createTask(text, project) {
      const now = new Date().toISOString();
      return db.prepare('INSERT INTO tasks(text,status,project,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(text, 'pending', project || '默认项目', now, now).lastInsertRowid;
    },
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
    getTask(id) {
      const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      if (!t) return null;
      t.steps = db.prepare('SELECT * FROM steps WHERE task_id=?').all(id);
      return t;
    },
    listTasks() {
      return db.prepare('SELECT id,text,status,project,created_at,updated_at FROM tasks ORDER BY id DESC').all();
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
      db.prepare('INSERT OR REPLACE INTO agents(id,name,command,args,model,caps,color,avatar,dept) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, d.name || id, d.command || '', JSON.stringify(d.args || []), d.model || '—', JSON.stringify(d.caps || []), d.color || '#7C6FD9', d.avatar || (d.name || 'A').slice(0, 1).toUpperCase(), d.dept || 'dev');
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
    seed() {
      if (db.prepare('SELECT COUNT(*) n FROM agents').get().n === 0) {
        this.addAgent({ id: 'claude', name: 'Claude', command: 'claude', args: ['-p', '--dangerously-skip-permissions'], model: 'claude CLI', caps: ['代码生成', '重构', '单元测试'], color: '#7C6FD9', avatar: 'C', dept: 'dev' });
        this.addAgent({ id: 'codex', name: 'Codex', command: 'codex', args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'], model: 'codex CLI', caps: ['功能验证', '回归测试', '沙箱执行'], color: '#4F8BE8', avatar: 'X', dept: 'qa' });
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
