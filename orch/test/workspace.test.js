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
