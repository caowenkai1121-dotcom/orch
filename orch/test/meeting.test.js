const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { open } = require('../store');
const { runTask, meetingUserMsg, summonEmployee, endMeeting } = require('../runner');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('会议室:复杂任务开会→开场发言→用户发言→拉人→结束会议→落方案并按实现步执行', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('开发一个复杂应用');
  store.setTaskDir(id, dir);
  // 自建三个员工做参会/候补(:memory: 不 seed 角色)
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'arch', dept: 'eng', name: '后端架构师', prompt: '负责架构', executor: 'claude' });
  store.addRole({ id: 'fe', dept: 'eng', name: '前端工程师', prompt: '负责前端', executor: 'claude' });
  store.addRole({ id: 'qa', dept: 'eng', name: '测试员', prompt: '负责测试', executor: 'claude' });
  const emps = ['arch', 'fe'];
  const echo = { async run({ prompt }) { return { output: '发言内容(' + prompt.slice(0, 8) + ')', success: true }; } };
  const plan = {
    task: '开发一个复杂应用',
    steps: [
      { id: 'meet_a', role: emps[0], agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'meet_b', role: emps[1], agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'decide_plan', role: emps[0], agent: 'claude', prompt: '综合方案', deps: ['meet_a', 'meet_b'] },
      { id: 'impl', role: emps[0], agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { attendees: emps, meetIds: ['meet_a', 'meet_b'], decideId: 'decide_plan' },
  };
  const runs = new Map();
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs, onEvent: () => {}, makePlan: async () => plan };

  await runTask(id, deps);
  assert.equal(store.getTask(id).status, 'meeting', '复杂任务应进入会议状态,不直接执行');
  assert.equal(store.getMeeting(id).status, 'open');
  await wait(60); // 开场发言(后台异步)
  const opening = store.listMeetingMsgs(id);
  assert.ok(opening.length >= 3, '应有会议室系统开场 + 两位员工开场发言, 实际=' + opening.length);

  // 用户发言(无@ → 主持回应),等待
  meetingUserMsg(id, deps, '我希望重点保证本地存储可靠');
  await wait(40);
  assert.ok(store.listMeetingMsgs(id).some((m) => m.role === 'user'), '应记录用户发言');

  // 拉一个新员工加入
  await summonEmployee(id, deps, 'qa');
  assert.ok(store.getMeeting(id).attendees.includes('qa'), '被@员工应加入参会名单');

  // 结束会议 → 落方案 + 执行实现步
  await endMeeting(id, deps);
  assert.equal(store.getMeeting(id).status, 'closed');
  assert.ok(fs.existsSync(path.join(dir, '方案.md')), '应生成 方案.md');
  assert.ok(fs.existsSync(path.join(dir, '会议记录.md')), '应生成 会议记录.md');
  assert.equal(store.getTask(id).status, 'done', '会议结束后应按实现步执行至完成');
  // 会议步应被标记 done(画布显示已开会),impl 真正执行
  const st = {}; (store.getTask(id).steps || []).forEach((s) => { st[s.step_id] = s.status; });
  assert.equal(st['decide_plan'], 'done');
  assert.equal(st['impl'], 'done');

  fs.rmSync(dir, { recursive: true, force: true });
});
