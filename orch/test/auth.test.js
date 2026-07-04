const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { open } = require('../store');

function mem() { const s = open(':memory:'); s.seed(); return s; }

test('会话落库,重开同一库仍有效(进程重启不掉线)', () => {
  const f = path.join(os.tmpdir(), 'orch-sess-' + process.pid + '.db');
  try { fs.unlinkSync(f); } catch (e) {}
  let s = open(f); s.seed();
  s.addSession('tokX', 'admin');
  s = open(f); // 模拟重启:重新打开同一文件
  assert.equal(s.sessionUser('tokX'), 'admin'); // 重开后会话仍在
  s.delSession('tokX');
  assert.equal(s.sessionUser('tokX'), null);
  assert.equal(s.sessionUser('不存在'), null);
  try { fs.unlinkSync(f); } catch (e) {}
});

test('verifyLogin: 正确密码过,错误密码拒', () => {
  const s = mem();
  assert.ok(s.verifyLogin('admin', 'admin'));      // seed 的 admin/admin
  assert.equal(s.verifyLogin('admin', 'wrong'), null);
  assert.equal(s.verifyLogin('nobody', 'admin'), null);
});

test('setPassword 改密后旧密失效', () => {
  const s = mem();
  s.setPassword('admin', 'newpw');
  assert.equal(s.verifyLogin('admin', 'admin'), null);
  assert.ok(s.verifyLogin('admin', 'newpw'));
});

test('项目授权 grant/revoke', () => {
  const s = mem();
  s.grantProject('PJ', 'bob');
  assert.deepEqual(s.grantsFor('PJ'), ['bob']);
  s.revokeProject('PJ', 'bob');
  assert.deepEqual(s.grantsFor('PJ'), []);
});

test('部门 CRUD + 设 agent 归属', () => {
  const s = mem();
  const id = s.addDept({ name: '设计部' });
  assert.ok(s.listDepts().some((d) => d.id === id));
  s.addAgent({ id: 'g', name: 'Gem', dept: 'dev' });
  s.setAgentDept('g', id);
  assert.equal(s.listAgents().find((a) => a.id === 'g').dept, id);
});
