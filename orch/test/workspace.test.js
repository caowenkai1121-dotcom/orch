const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeWorkspace, metaDir, listWorktreeIds, reapWorktree, listDataDirs } = require('../workspace');

test('metaDir:中性 scratch 目录,存在且不在 orch 源码目录内', () => {
  const d = metaDir();
  assert.ok(fs.existsSync(d));                                   // 已建好,可用作 cwd
  assert.ok(!path.resolve(d).startsWith(path.resolve(__dirname, '..'))); // 不在 orch 仓内 → 误写不污染源码
  assert.equal(metaDir(), d);                                    // 幂等
});

test('共享工作区:所有步骤返回同一根目录', () => {
  const ws = makeWorkspace('/some/root');
  assert.equal(ws.make('dev'), '/some/root');
  assert.equal(ws.make('test'), '/some/root');
});

test('#15 doctor:listWorktreeIds 列出 worktrees/task-N 的任务 id', () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'orch-wt-'));
  fs.mkdirSync(path.join(root, 'worktrees', 'task-3'), { recursive: true });
  fs.mkdirSync(path.join(root, 'worktrees', 'task-7'), { recursive: true });
  fs.mkdirSync(path.join(root, 'worktrees', 'misc'), { recursive: true }); // 非 task-N → 忽略
  assert.deepEqual(listWorktreeIds(root).sort((a, b) => a - b), [3, 7]);
  assert.deepEqual(listWorktreeIds(path.join(root, 'nope')), []); // 无 worktrees 目录 → 空
  fs.rmSync(root, { recursive: true, force: true });
});

test('#15 doctor:listDataDirs 列出 data/owner/project/text-id 叶子及任务 id(无-id后缀忽略)', () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'orch-data-'));
  fs.mkdirSync(path.join(root, 'data', 'me', 'proj', 'task-a-12'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'me', 'proj', 'build-site-7'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'me', 'proj', 'no-id-here'), { recursive: true });
  assert.deepEqual(listDataDirs(root).map((x) => x.id).sort((a, b) => a - b), [7, 12]);
  assert.deepEqual(listDataDirs(path.join(root, 'nope')), []); // 无 data 目录 → 空
  fs.rmSync(root, { recursive: true, force: true });
});

test('#15 doctor:reapWorktree 非 git worktree 时回退 rmSync 删目录', () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'orch-reap-'));
  const dir = path.join(root, 'worktrees', 'task-9');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.txt'), 'y');
  assert.equal(reapWorktree(root, 9), true);        // git worktree remove 失败(非仓)→ 回退 rmSync
  assert.ok(!fs.existsSync(dir));                    // 目录已移除
  assert.equal(reapWorktree(root, 99), false);       // 不存在的 → false
  fs.rmSync(root, { recursive: true, force: true });
});
