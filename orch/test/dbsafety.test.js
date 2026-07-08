// 数据安全:WAL 崩溃保护 + 在线备份可恢复
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { open } = require('../store');

test('文件库启用 WAL 崩溃保护模式', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wal-'));
  const dbp = path.join(dir, 'x.db');
  const s = open(dbp);
  const mode = s.db.pragma('journal_mode', { simple: true });
  assert.equal(String(mode).toLowerCase(), 'wal', 'journal_mode 应为 WAL, 实际=' + mode);
  s.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backup 产出可打开且数据完整的库副本', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bak-'));
  const dbp = path.join(dir, 'x.db');
  const bakp = path.join(dir, 'x.db.bak');
  const s = open(dbp);
  s.seed();
  const id = s.createTask('要备份的任务');
  s.setStep(id, 's1', 'claude', 'done', '产出');
  s.addRole({ id: 'r1', dept: 'eng', name: '员工', prompt: 'p' });
  s.appendRoleMemo('r1', '踩过的坑要保住');
  await s.backup(bakp);
  s.db.close();
  // 打开备份,验证任务/产出/员工经验都在
  assert.ok(fs.existsSync(bakp), '备份文件应存在');
  const b = open(bakp);
  const t = b.getTask(id);
  assert.ok(t && t.text === '要备份的任务', '任务应在备份里');
  assert.equal((t.steps || [])[0].output, '产出', '产出应在备份里');
  const r = b.getRole('r1');
  assert.ok((r.memo || '').includes('踩过的坑'), '员工经验应在备份里');
  b.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
