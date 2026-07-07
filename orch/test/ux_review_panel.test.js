const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

test('任务详情提供智能复核面板', () => {
  assert.match(html, /智能复核/);
  assert.match(html, /交付蓝图/);
  assert.match(html, /验收清单/);
  assert.match(app, /\/api\/plan-meta\//);
  assert.match(app, /planReview/);
});

test('发布失败展示诊断明细而不是只吞掉错误', () => {
  assert.match(html, /发布诊断/);
  assert.match(html, /诊断检查/);
  assert.match(app, /publishDiag/);
  assert.match(app, /formatPublishDiag/);
});
