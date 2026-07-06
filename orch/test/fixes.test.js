// 轮210 修复回归:删任务清会议数据 / endMeeting 防重入 / relay 无产出误标 / gate_cmd 落库
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { open } = require('../store');
const { endMeeting, openMeeting } = require('../runner');
const { runPlan } = require('../engine');
const api = require('../api');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('deleteTask 级联清 meetings/meeting_msgs(防 rowid 复用把旧会议附身新任务)', () => {
  const s = open(':memory:');
  const id = s.createTask('t');
  s.createMeeting(id, ['a']);
  s.addMeetingMsg(id, { role: 'a', name: 'A', text: 'hi' });
  s.deleteTask(id);
  assert.equal(s.getMeeting(id), undefined);
  assert.equal(s.listMeetingMsgs(id).length, 0);
});

test('endMeeting 并发双调只执行一遍实现步(防双击双跑)', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-fix-meet-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('复杂应用');
  store.setTaskDir(id, dir);
  const plan = {
    task: '复杂应用',
    steps: [
      { id: 'meet_a', agent: 'claude', prompt: '开场', deps: [] },
      { id: 'decide_plan', agent: 'claude', prompt: '综合', deps: ['meet_a'] },
      { id: 'impl', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { attendees: [], meetIds: ['meet_a'], decideId: 'decide_plan' },
  };
  store.setPlan(id, plan);
  store.createMeeting(id, []);
  store.setTaskStatus(id, 'meeting');
  const prompts = [];
  const echo = { async run({ prompt }) { prompts.push(prompt); if (/会议共识判定/.test(prompt)) return { output: '{"status":"consensus","reason":"已有结论"}', success: true }; return { output: 'ok', success: true }; } };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {} };
  await Promise.all([endMeeting(id, deps), endMeeting(id, deps)]);
  const implRuns = prompts.filter((p) => p.includes('按方案实现')).length;
  assert.equal(implRuns, 1, '实现步应只执行一次, 实际=' + implRuns);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('relay:done 步无 files 事件不误标「⚠ 无产出」,统计到 0 才警示', () => {
  const s = open(':memory:');
  s.seed();
  const id = s.createTask('t');
  s.setPlan(id, { task: 't', steps: [{ id: 's1', agent: 'claude', prompt: 'x', deps: [] }] });
  s.setStep(id, 's1', 'claude', 'done', '完成');
  let row = api.relay(s, id)[0];
  assert.equal(row.filesLabel, '', '无统计事件不应标无产出');
  s.addEvent(id, 'files', { step: 's1', n: 0 });
  row = api.relay(s, id)[0];
  assert.equal(row.filesLabel, '⚠ 无产出');
});

test('用户强制结束会议(user_forced):待裁决态直接收束,不过主持人判定,清挂起问题', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-fix-force-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('复杂应用');
  store.setTaskDir(id, dir);
  store.setPlan(id, {
    task: '复杂应用',
    steps: [
      { id: 'meet_a', agent: 'claude', prompt: '开场', deps: [] },
      { id: 'decide_plan', agent: 'claude', prompt: '综合', deps: ['meet_a'] },
      { id: 'impl', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { attendees: [], meetIds: ['meet_a'], decideId: 'decide_plan' },
  });
  store.createMeeting(id, []);
  store.setTaskDecision(id, '__meeting_decision', '请你裁决');
  store.setTaskStatus(id, 'awaiting_input');
  const prompts = [];
  const echo = { async run({ prompt }) { prompts.push(prompt); return { output: 'ok', success: true }; } };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {} };
  await endMeeting(id, deps, { status: 'user_forced', reason: '用户手动结束会议' });
  assert.equal(store.getMeeting(id).status, 'closed', '用户拍板应直接关闭会议');
  assert.ok(!prompts.some((p) => p.includes('会议共识判定')), '带 decision 不应再过主持人判定');
  const t = store.getTask(id);
  assert.ok(!t.blocked_step, '挂起的裁决问题应被清掉, 实际=' + t.blocked_step);
  assert.equal(t.status, 'done', '应按方案执行至完成');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会议后台协程不复活已取消任务(askMeetingDecision 守卫任务状态)', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-fix-cancel-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('复杂应用');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  store.setPlan(id, { task: '复杂应用', steps: [{ id: 'impl', role: 'arch', agent: 'claude', prompt: '实现', deps: [] }], meeting: { attendees: ['arch'], meetIds: [], decideId: '' } });
  const echo = { async run() { return { output: '', success: true } } }; // 发言输出为空 → meetingSpeak 失败 → 走 askMeetingDecision 分支
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {} };
  await openMeeting(id, deps);
  store.setTaskStatus(id, 'cancelled'); // 用户取消(开场发言协程仍在后台跑)
  await wait(150);
  assert.equal(store.getTask(id).status, 'cancelled', '已取消任务不应被会议协程改成 awaiting_input');
  assert.ok(!store.getTask(id).blocked_step, '不应给已取消任务挂裁决问题');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('searchContent 转义 LIKE 通配符:搜 % 只命中含 % 字面的任务', () => {
  const s = open(':memory:');
  s.createTask('普通任务');
  s.createTask('折扣100%活动');
  const hits = s.searchContent('%', 10);
  assert.equal(hits.length, 1, '搜 % 不应全表匹配, 实际=' + hits.length);
  assert.ok(hits[0].text.includes('%'));
});

test('gate_cmd 步输出经 onResult 落库(失败原因/摘要不再为空)', async () => {
  const results = {};
  const ctx = {
    adapters: {}, workspace: { make: async () => process.cwd() },
    onStatus: () => {}, onLog: () => {},
    onResult: (sid, out) => { results[sid] = out; },
  };
  const done = await runPlan({ steps: [{ id: 'g', gate_cmd: 'node -e "process.exit(0)"', deps: [] }] }, ctx);
  assert.ok(done.g && done.g.success);
  assert.ok(/^PASS/.test(results.g || ''), 'gate_cmd 的 PASS 输出应落库, 实际=' + results.g);
});
