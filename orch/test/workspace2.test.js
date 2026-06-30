const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { slug, taskDir } = require('../workspace');

test('slug 文件名安全', () => {
  assert.equal(slug('开发 电商!@#站'), '开发-电商-站');
  assert.equal(slug(''), 'x');
});
test('taskDir 建出 data/owner/project/task 目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchroot-'));
  const dir = taskDir(root, '李四', '店铺', '做首页', 7);
  assert.ok(fs.existsSync(dir));
  assert.equal(path.basename(dir), '做首页-7');
  assert.ok(dir.includes(path.join('data', '李四', '店铺')));
});
