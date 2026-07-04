const { test } = require('node:test');
const assert = require('node:assert');
const { scheduleDue } = require('../schedule');

const at = (h, m) => new Date(2026, 5, 4, h, m, 0, 0); // 2026-06-04 本地
const iso = (h, m, d) => new Date(2026, 5, d || 4, h, m, 0, 0).toISOString();

test('daily:已到点且今日未跑过 → 补跑(错过精确分钟也补)', () => {
  const s = { spec: JSON.stringify({ kind: 'daily', at: '09:00' }), last_run: null };
  assert.equal(scheduleDue(s, at(9, 5)), true);   // 09:05 越过 09:00 仍补跑
  assert.equal(scheduleDue(s, at(8, 59)), false); // 未到点
});
test('daily:今日已跑过不重复', () => {
  const s = { spec: JSON.stringify({ kind: 'daily', at: '09:00' }), last_run: iso(9, 1) };
  assert.equal(scheduleDue(s, at(9, 30)), false);
});
test('daily:重启后越过槽补跑一次(last=昨天)', () => {
  const s = { spec: JSON.stringify({ kind: 'daily', at: '09:00' }), last_run: iso(9, 1, 3) }; // 昨天跑过
  assert.equal(scheduleDue(s, at(10, 0)), true);
});
test('daily:建于槽后当天不误补跑(last_run=created_at)', () => {
  const s = { spec: JSON.stringify({ kind: 'daily', at: '09:00' }), last_run: iso(15, 0) }; // 15:00 建
  assert.equal(scheduleDue(s, at(15, 1)), false);                     // 当天不跑
  assert.equal(scheduleDue(s, new Date(2026, 5, 5, 9, 0)), true);     // 次日 09:00 跑
});
test('weekly:正确dow到点跑,错误dow不跑', () => {
  const now = at(9, 5); const dow = now.getDay();
  assert.equal(scheduleDue({ spec: JSON.stringify({ kind: 'weekly', dow, at: '09:00' }), last_run: null }, now), true);
  assert.equal(scheduleDue({ spec: JSON.stringify({ kind: 'weekly', dow: (dow + 1) % 7, at: '09:00' }), last_run: null }, now), false);
});
test('hours:间隔到跑、未到不跑(不受改动影响)', () => {
  const s = { spec: JSON.stringify({ kind: 'hours', n: 2 }), last_run: iso(7, 0) };
  assert.equal(scheduleDue(s, at(9, 1)), true);   // 差 2h
  assert.equal(scheduleDue(s, at(8, 0)), false);  // 差 1h
});
