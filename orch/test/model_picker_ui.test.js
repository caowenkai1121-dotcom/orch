const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

test('Agent 默认模型使用明确下拉和自定义输入,不依赖 datalist', () => {
  assert.match(html, /<select id="na-defmodel"/);
  assert.match(html, /id="na-defmodel-custom"/);
  assert.doesNotMatch(html, /id="na-defmodel-list"/);
});

test('任务下发模型选择使用明确下拉和自定义输入,不依赖 datalist', () => {
  assert.match(html, /<select id="\{\{ mp\.selId \}\}"/);
  assert.match(html, /id="\{\{ mp\.customId \}\}"/);
  assert.doesNotMatch(html, /list="\{\{ mp\.listId \}\}"/);
});
