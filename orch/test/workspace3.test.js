const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { worktreeDir, dockerArgs } = require('../workspace');

test('worktree 在 git 仓内建独立分支目录', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  execSync('git init -q', { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  execSync('git add . && git -c user.name=t -c user.email=t@t commit -q -m s', { cwd: repo });
  const dir = worktreeDir(repo, 9);
  assert.ok(fs.existsSync(dir));
  assert.ok(fs.existsSync(path.join(dir, 'a.txt'))); // worktree 含仓内文件
});

test('dockerArgs 构造挂载命令', () => {
  const a = dockerArgs('/work/dir', 'node:20', 'node', ['-e', 'x']);
  assert.deepEqual(a.slice(0, 6), ['run', '--rm', '-v', '/work/dir:/work', '-w', '/work']);
  assert.ok(a.includes('node:20'));
  assert.equal(a[a.length - 2], '-e');
});
