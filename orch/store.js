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
    getLogs(taskId) {
      return db.prepare('SELECT step_id,line FROM logs WHERE task_id=? ORDER BY id').all(taskId);
    },
    db,
  };
}

module.exports = { open };
