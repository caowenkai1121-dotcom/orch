// augmentPath:补全服务进程 PATH,让 npm-global/nvm 装的 CLI 也能被检测/执行
const { test } = require('node:test');
const assert = require('node:assert');
const boot = require('../bootstrap');

test('augmentPath 不抛错,PATH 保持有效字符串', () => {
  const before = process.env.PATH;
  assert.doesNotThrow(() => boot.augmentPath());
  assert.equal(typeof process.env.PATH, 'string');
  assert.ok(process.env.PATH.length > 0);
  if (process.platform === 'win32') assert.equal(process.env.PATH, before, 'Windows 应 no-op 不改 PATH');
});

test('augmentPath POSIX:原有 PATH 目录不丢失(非 win32)', { skip: process.platform === 'win32' }, () => {
  const before = new Set((process.env.PATH || '').split(':').filter(Boolean));
  boot.augmentPath();
  const after = new Set((process.env.PATH || '').split(':').filter(Boolean));
  before.forEach((d) => assert.ok(after.has(d), '原有目录不应丢失: ' + d));
});
