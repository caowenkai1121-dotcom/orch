const { test } = require('node:test');
const assert = require('node:assert');
const { open } = require('../store');

test('建任务并取回', () => {
  const s = open(':memory:');
  const id = s.createTask('做登录');
  const t = s.getTask(id);
  assert.equal(t.text, '做登录');
  assert.equal(t.status, 'pending');
});

test('setStep 为同一步骤做 upsert', () => {
  const s = open(':memory:');
  const id = s.createTask('x');
  s.setStep(id, 'dev', 'claude', 'running', null);
  s.setStep(id, 'dev', 'claude', 'done', 'ok');
  const t = s.getTask(id);
  assert.equal(t.steps.length, 1);
  assert.equal(t.steps[0].status, 'done');
  assert.equal(t.steps[0].output, 'ok');
});
