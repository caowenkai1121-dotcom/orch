const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { open } = require('../store');
const { runTask, meetingUserMsg, summonEmployee, endMeeting, resumeTask } = require('../runner');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('会议室:主持人先说明主题,参会员工举手排队后由主持收束', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-host-queue-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('前端使用 vue 后段使用 java springboot 开发一个 天气小工具网站');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'host', dept: 'eng', name: '主持人', prompt: '负责主持会议和生成纪要', executor: 'claude' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  store.addRole({ id: 'qa', dept: 'eng', name: '测试员', prompt: '负责验收', executor: 'claude' });
  const plan = {
    task: '前端使用 vue 后段使用 java springboot 开发一个 天气小工具网站',
    steps: [
      { id: 'meet_arch', role: 'arch', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'meet_qa', role: 'qa', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'decide_plan', role: 'host', agent: 'claude', prompt: '综合方案', deps: ['meet_arch', 'meet_qa'] },
      { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { hostRole: 'host', attendees: ['arch', 'qa'], meetIds: ['meet_arch', 'meet_qa'], decideId: 'decide_plan' },
  };
  const echo = { async run({ prompt }) {
    if (/会议共识判定/.test(prompt)) return { output: '{"status":"consensus","reason":"全员已发言且无疑问"}', success: true };
    if (/方案讨论会主持/.test(prompt)) return { output: '## 决议\n按天气工具方案执行\n## 行动项\n架构师实现\n## 验收口径\n测试员验收\n## 风险清单\n无\n## 待解决问题\n无', success: true };
    return { output: '观点明确。风险无。建议按计划执行。待确认项无。', success: true };
  } };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };

  await runTask(id, deps);
  await wait(160);

  const msgs = store.listMeetingMsgs(id);
  const firstSpeaker = msgs.find((m) => m.role !== 'system');
  const allText = msgs.map((m) => m.text).join('\n');
  assert.equal(firstSpeaker.role, 'host');
  assert.match(firstSpeaker.text, /主题|议题|天气小工具/);
  assert.match(allText, /架构师.*举手|举手.*架构师/);
  assert.match(allText, /测试员.*举手|举手.*测试员/);
  assert.match(allText, /没有疑问|还有疑问/);
  assert.match(allText, /会议纪要|结束会议/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会议室:首轮发言达成一致后自动结束会议并继续执行', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-auto-close-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('开发一个交易看板');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  store.addRole({ id: 'qa', dept: 'eng', name: '测试员', prompt: '负责验收', executor: 'claude' });
  const plan = {
    task: '开发一个交易看板',
    steps: [
      { id: 'meet_arch', role: 'arch', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'meet_qa', role: 'qa', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'decide_plan', role: 'arch', agent: 'claude', prompt: '综合方案', deps: ['meet_arch', 'meet_qa'] },
      { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { attendees: ['arch', 'qa'], meetIds: ['meet_arch', 'meet_qa'], decideId: 'decide_plan' },
  };
  const echo = { async run({ prompt }) {
    if (/会议共识判定/.test(prompt)) return { output: '{"status":"consensus","reason":"方案、风险和分工已明确"}', success: true };
    if (/方案讨论会主持/.test(prompt)) return { output: '## 决议\n按方案执行\n## 行动项\n架构师实现\n## 验收口径\n测试员验收\n## 风险清单\n无\n## 待解决问题\n无', success: true };
    return { output: '观点明确。风险无。建议按计划执行。待确认项无。', success: true };
  } };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };

  await runTask(id, deps);
  await wait(120);

  assert.equal(store.getMeeting(id).status, 'closed');
  assert.equal(store.getTask(id).status, 'done');
  const st = {}; (store.getTask(id).steps || []).forEach((s) => { st[s.step_id] = s.status; });
  assert.equal(st['decide_plan'], 'done');
  assert.equal(st['impl'], 'done');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会议室:首轮发言无法一致时转用户裁决,用户回答后再结束会议', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-user-decision-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('开发一个复杂股票交易网站');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  store.addRole({ id: 'risk', dept: 'eng', name: '风控专家', prompt: '负责风险', executor: 'claude' });
  const plan = {
    task: '开发一个复杂股票交易网站',
    steps: [
      { id: 'meet_arch', role: 'arch', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'meet_risk', role: 'risk', agent: 'claude', prompt: '风险观点', deps: [] },
      { id: 'decide_plan', role: 'arch', agent: 'claude', prompt: '综合方案', deps: ['meet_arch', 'meet_risk'] },
      { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { attendees: ['arch', 'risk'], meetIds: ['meet_arch', 'meet_risk'], decideId: 'decide_plan' },
  };
  const echo = { async run({ prompt }) {
    if (/会议共识判定/.test(prompt)) return { output: '{"status":"needs_user_decision","reason":"风险边界未确认","question":"请选择上线范围:A 模拟盘优先;B 直接实盘"}', success: true };
    if (/方案讨论会主持/.test(prompt)) return { output: '## 决议\n按用户裁决执行\n## 行动项\n架构师实现\n## 验收口径\n风控专家验收\n## 风险清单\n交易风险\n## 待解决问题\n无', success: true };
    return { output: '观点明确。风险需要确认。建议先裁决上线范围。待确认项:上线范围。', success: true };
  } };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };

  await runTask(id, deps);
  await wait(120);

  let task = store.getTask(id);
  assert.equal(task.status, 'awaiting_input');
  assert.equal(task.blocked_step, '__meeting_decision');
  assert.match(task.question, /上线范围/);
  assert.equal(store.getMeeting(id).status, 'open');

  await resumeTask(id, deps, '__meeting_decision', '选择 A:模拟盘优先');
  assert.equal(store.getMeeting(id).status, 'closed');
  task = store.getTask(id);
  assert.equal(task.status, 'done');
  assert.ok(store.listMeetingMsgs(id).some((m) => /用户裁决/.test(m.text)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会议室:共识判定输出无效时转用户裁决,不继续卡在会议中', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-invalid-judge-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('开发一个 DMS 系统');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  const plan = {
    task: '开发一个 DMS 系统',
    steps: [
      { id: 'meet_arch', role: 'arch', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'decide_plan', role: 'arch', agent: 'claude', prompt: '综合方案', deps: ['meet_arch'] },
      { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { attendees: ['arch'], meetIds: ['meet_arch'], decideId: 'decide_plan' },
  };
  const echo = { async run({ prompt }) {
    if (/会议共识判定/.test(prompt)) return { output: '我认为还需要确认 DMS 是文档管理还是经销商管理。', success: true };
    return { output: '观点明确。风险是 DMS 定义不清。建议先裁决。待确认项:DMS 类型。', success: true };
  } };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };

  await runTask(id, deps);
  await wait(120);

  const task = store.getTask(id);
  assert.equal(task.status, 'awaiting_input');
  assert.equal(task.blocked_step, '__meeting_decision');
  assert.match(task.question, /裁决|确认|DMS/);
  assert.equal(store.getMeeting(id).status, 'open');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会议室:用户补充关键信息后再次判定并自动收束', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-rejudge-after-user-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('开发一个 DMS 系统');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'pm', dept: 'eng', name: '产品经理', prompt: '负责需求', executor: 'claude' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  const plan = {
    task: '开发一个 DMS 系统',
    steps: [
      { id: 'meet_pm', role: 'pm', agent: 'claude', prompt: '需求观点', deps: [] },
      { id: 'meet_arch', role: 'arch', agent: 'claude', prompt: '架构观点', deps: [] },
      { id: 'decide_plan', role: 'pm', agent: 'claude', prompt: '综合方案', deps: ['meet_pm', 'meet_arch'] },
      { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { attendees: ['pm', 'arch'], meetIds: ['meet_pm', 'meet_arch'], decideId: 'decide_plan' },
  };
  let judgeCount = 0;
  const echo = { async run({ prompt }) {
    if (/会议共识判定/.test(prompt)) {
      judgeCount += 1;
      if (judgeCount === 1) return { output: '{"status":"continue","reason":"等待用户澄清 DMS 类型"}', success: true };
      return { output: '{"status":"consensus","reason":"用户已确认 DMS 是经销商管理系统"}', success: true };
    }
    if (/方案讨论会主持/.test(prompt)) return { output: '## 决议\n按经销商管理系统执行\n## 行动项\n架构师实现\n## 验收口径\n产品经理验收\n## 风险清单\n无\n## 待解决问题\n无', success: true };
    return { output: '观点明确。风险已收敛。建议按经销商管理系统执行。待确认项无。', success: true };
  } };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };

  await runTask(id, deps);
  await wait(120);
  assert.equal(store.getTask(id).status, 'meeting');

  meetingUserMsg(id, deps, 'DMS 是经销商管理系统', 'admin');
  await wait(180);

  assert.equal(judgeCount, 2);
  assert.equal(store.getMeeting(id).status, 'closed');
  assert.equal(store.getTask(id).status, 'done');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会议室:待用户裁决时在会议室发言也会作为裁决收束', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-room-decision-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('开发一个 DMS 系统');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'pm', dept: 'eng', name: '产品经理', prompt: '负责需求', executor: 'claude' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  const plan = {
    task: '开发一个 DMS 系统',
    steps: [
      { id: 'meet_pm', role: 'pm', agent: 'claude', prompt: '需求观点', deps: [] },
      { id: 'decide_plan', role: 'pm', agent: 'claude', prompt: '综合方案', deps: ['meet_pm'] },
      { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { attendees: ['pm'], meetIds: ['meet_pm'], decideId: 'decide_plan' },
  };
  const echo = { async run({ prompt }) {
    if (/会议共识判定/.test(prompt)) return { output: '{"status":"needs_user_decision","reason":"DMS 定义不清","question":"请确认 DMS 是经销商还是文档管理"}', success: true };
    if (/方案讨论会主持/.test(prompt)) return { output: '## 决议\n按经销商管理系统执行\n## 行动项\n架构师实现\n## 验收口径\n产品经理验收\n## 风险清单\n无\n## 待解决问题\n无', success: true };
    return { output: '观点明确。风险是定义不清。建议用户裁决。待确认项:DMS 类型。', success: true };
  } };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };

  await runTask(id, deps);
  await wait(120);
  assert.equal(store.getTask(id).status, 'awaiting_input');

  meetingUserMsg(id, deps, 'DMS 是经销商管理系统', 'admin');
  await wait(180);

  assert.equal(store.getMeeting(id).status, 'closed');
  assert.equal(store.getTask(id).status, 'done');
  assert.ok(store.listMeetingMsgs(id).some((m) => /用户裁决:DMS 是经销商管理系统/.test(m.text)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会议室:员工发言超时后转用户裁决,不无限等待', async () => {
  const old = process.env.ORCH_MEETING_TURN_TIMEOUT_MS;
  process.env.ORCH_MEETING_TURN_TIMEOUT_MS = '30';
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-speaker-timeout-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  try {
    const id = store.createTask('开发一个 DMS 系统');
    store.setTaskDir(id, dir);
    store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
    store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
    const plan = {
      task: '开发一个 DMS 系统',
      steps: [
        { id: 'meet_arch', role: 'arch', agent: 'claude', prompt: '开场观点', deps: [] },
        { id: 'decide_plan', role: 'arch', agent: 'claude', prompt: '综合方案', deps: ['meet_arch'] },
        { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
      ],
      meeting: { attendees: ['arch'], meetIds: ['meet_arch'], decideId: 'decide_plan' },
    };
    const echo = { async run({ prompt }) {
      if (/群聊发言/.test(prompt)) return new Promise(() => {});
      return { output: '{"status":"needs_user_decision","reason":"员工发言超时","question":"员工发言超时,是否按当前信息继续?"}', success: true };
    } };
    const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };

    await runTask(id, deps);
    await wait(120);

    const task = store.getTask(id);
    assert.equal(task.status, 'awaiting_input');
    assert.equal(task.blocked_step, '__meeting_decision');
    assert.match(task.question, /超时|继续/);
  } finally {
    if (old == null) delete process.env.ORCH_MEETING_TURN_TIMEOUT_MS;
    else process.env.ORCH_MEETING_TURN_TIMEOUT_MS = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
  let judgeCount = 0;
  const echo = { async run({ prompt }) {
    if (/会议共识判定/.test(prompt)) {
      judgeCount++;
      return { output: judgeCount < 3 ? '{"status":"continue","reason":"等待用户补充和测试加入"}' : '{"status":"consensus","reason":"测试手动会议流程已具备结论"}', success: true };
    }
    return { output: '发言内容(' + prompt.slice(0, 8) + ')', success: true };
  } };
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

test('会议室:中途加入员工先获得会议前情再发表意见', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-join-context-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('开发一个DMS供应商管理系统');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'host', dept: 'eng', name: '会议主持', prompt: '负责主持会议和拍板', executor: 'claude' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  store.addRole({ id: 'qa', dept: 'eng', name: '测试员', prompt: '负责验收', executor: 'claude' });
  const prompts = [];
  const echo = { async run({ prompt }) {
    prompts.push(prompt);
    if (/会议共识判定/.test(prompt)) return { output: '{"status":"continue","reason":"等待更多意见"}', success: true };
    return { output: '观点:同意。风险:接口边界。建议:补验收。待确认项:无。', success: true };
  } };
  const plan = {
    task: '开发一个DMS供应商管理系统',
    steps: [
      { id: 'meet_arch', role: 'arch', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'decide_plan', role: 'host', agent: 'claude', prompt: '综合方案', deps: ['meet_arch'] },
      { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { hostRole: 'host', attendees: ['arch'], meetIds: ['meet_arch'], decideId: 'decide_plan' },
  };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };

  await runTask(id, deps);
  await wait(80);
  meetingUserMsg(id, deps, '用户补充:供应商准入要有审批流');
  await wait(40);
  await summonEmployee(id, deps, 'qa');

  const qaPrompt = prompts.reverse().find((p) => /你是「测试员」/.test(p));
  assert.ok(/会议前情摘要/.test(qaPrompt), '新加入员工应先收到会议前情摘要');
  assert.ok(/供应商准入要有审批流/.test(qaPrompt), '新加入员工应知道用户补充的前后文');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会议室:争论无法一致但主持人可以拍板时自动生成结论并关闭', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-host-decision-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('开发复杂股票交易网站');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'host', dept: 'eng', name: '主持人', prompt: '负责拍板', executor: 'claude' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  store.addRole({ id: 'risk', dept: 'eng', name: '风控专家', prompt: '负责风险', executor: 'claude' });
  const echo = { async run({ prompt }) {
    if (/会议共识判定/.test(prompt)) return { output: '{"status":"host_decision","reason":"双方争论实盘风险,主持拍板先做模拟盘","decision":"先交付模拟盘与权限风控,实盘交易后续由用户确认"}', success: true };
    if (/方案讨论会主持/.test(prompt)) return { output: '## 决议\n先交付模拟盘与权限风控\n## 行动项\n架构师实现\n## 验收口径\n风控专家验收\n## 风险清单\n实盘交易暂不做\n## 待解决问题\n无', success: true };
    return { output: '观点:存在分歧。风险:实盘交易。建议:主持拍板。待确认项:无。', success: true };
  } };
  const plan = {
    task: '开发复杂股票交易网站',
    steps: [
      { id: 'meet_arch', role: 'arch', agent: 'claude', prompt: '架构观点', deps: [] },
      { id: 'meet_risk', role: 'risk', agent: 'claude', prompt: '风险观点', deps: [] },
      { id: 'decide_plan', role: 'host', agent: 'claude', prompt: '综合方案', deps: ['meet_arch', 'meet_risk'] },
      { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { hostRole: 'host', attendees: ['arch', 'risk'], meetIds: ['meet_arch', 'meet_risk'], decideId: 'decide_plan' },
  };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };

  await runTask(id, deps);
  await wait(150);

  assert.equal(store.getMeeting(id).status, 'closed');
  assert.equal(store.getTask(id).status, 'done');
  assert.ok(store.listMeetingMsgs(id).some((m) => /主持人拍板/.test(m.text) && /模拟盘/.test(m.text)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会议室:没有形成结论时手动结束会议不能关闭', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-no-result-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('开发一个不明确的DMS系统');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'host', dept: 'eng', name: '主持人', prompt: '负责主持', executor: 'claude' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  const echo = { async run({ prompt }) {
    if (/会议共识判定/.test(prompt)) return { output: '{"status":"continue","reason":"DMS含义未确认,会议没有达成结论"}', success: true };
    if (/方案讨论会主持/.test(prompt)) return { output: '不应生成方案', success: true };
    return { output: '观点:DMS含义不清。风险:方向错误。建议:继续确认。待确认项:DMS含义。', success: true };
  } };
  const plan = {
    task: '开发一个不明确的DMS系统',
    steps: [
      { id: 'meet_arch', role: 'arch', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'decide_plan', role: 'host', agent: 'claude', prompt: '综合方案', deps: ['meet_arch'] },
      { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { hostRole: 'host', attendees: ['arch'], meetIds: ['meet_arch'], decideId: 'decide_plan' },
  };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };

  await runTask(id, deps);
  await wait(80);
  await endMeeting(id, deps);

  assert.equal(store.getMeeting(id).status, 'open');
  assert.equal(store.getTask(id).status, 'meeting');
  assert.ok(!fs.existsSync(path.join(dir, '方案.md')), '没有结论时不能生成方案并关闭会议');
  assert.ok(store.listMeetingMsgs(id).some((m) => /尚未形成可执行结论/.test(m.text)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会议室:复杂任务按有界辩论和经理裁决议程组织', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-agenda-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('开发股票交易网站');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  store.addRole({ id: 'qa', dept: 'eng', name: '验收员', prompt: '负责验收和风险质询', executor: 'claude' });
  const prompts = [];
  const echo = { async run({ prompt }) { prompts.push(prompt); if (/会议共识判定/.test(prompt)) return { output: '{"status":"consensus","reason":"议程已收束"}', success: true }; return { output: '结构化发言', success: true }; } };
  const plan = {
    task: '开发股票交易网站',
    process: { type: 'risk_review', reason: '交易风险高', manager_role: 'arch', debate_rounds: 1, risk_review: true },
    steps: [
      { id: 'meet_arch', role: 'arch', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'meet_qa', role: 'qa', agent: 'claude', prompt: '风险质询', deps: [] },
      { id: 'decide_plan', role: 'arch', agent: 'claude', prompt: '综合方案', deps: ['meet_arch', 'meet_qa'] },
      { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { attendees: ['arch', 'qa'], meetIds: ['meet_arch', 'meet_qa'], decideId: 'decide_plan', agenda: ['目标澄清', '方案推进', '反方质询', '风险复核', '经理裁决'] },
  };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };

  await runTask(id, deps);
  await wait(60);
  await endMeeting(id, deps);

  const speakingPrompts = prompts.filter((p) => /群聊发言/.test(p));
  const summaryPrompts = prompts.filter((p) => /群聊发言/.test(p) === false);
  assert.ok(speakingPrompts.some((p) => /目标澄清/.test(p) && /方案推进/.test(p) && /反方质询/.test(p) && /风险复核/.test(p) && /一轮有界讨论/.test(p)), '发言 prompt 应基于会议议程固定为一轮有界讨论');
  assert.ok(summaryPrompts.some((p) => /经理裁决/.test(p) && /验收口径/.test(p) && /风险清单/.test(p)), '总结 prompt 应包含经理裁决/验收口径/风险清单');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会议室:发言与总结按结构化议程收敛', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-structure-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const id = store.createTask('设计一个多角色协作系统');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  store.addRole({ id: 'qa', dept: 'eng', name: '验收员', prompt: '负责验收', executor: 'claude' });
  const prompts = [];
  const echo = { async run({ prompt }) { prompts.push(prompt); if (/会议共识判定/.test(prompt)) return { output: '{"status":"consensus","reason":"议程已收束"}', success: true }; return { output: '结构化输出', success: true }; } };
  const plan = {
    task: '设计一个多角色协作系统',
    steps: [
      { id: 'meet_arch', role: 'arch', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'meet_qa', role: 'qa', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'decide_plan', role: 'arch', agent: 'claude', prompt: '综合方案', deps: ['meet_arch', 'meet_qa'] },
      { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { attendees: ['arch', 'qa'], meetIds: ['meet_arch', 'meet_qa'], decideId: 'decide_plan' },
  };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };
  await runTask(id, deps);
  await wait(60);
  await endMeeting(id, deps);
  assert.ok(prompts.some((p) => /观点/.test(p) && /风险/.test(p) && /建议/.test(p) && /待确认项/.test(p)), '会议发言应按观点/风险/建议/待确认项组织');
  assert.ok(prompts.some((p) => /决议/.test(p) && /行动项/.test(p) && /待解决问题/.test(p)), '会议总结应提炼决议/行动项/待解决问题');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会议室:注入任务目录Markdown知识检索片段', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-knowledge-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '项目约定.md'), '# 项目约定\n\n本地存储必须使用 SQLite,所有写入要有失败回滚说明。\n', 'utf8');
  const id = store.createTask('设计本地存储与失败回滚方案');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  store.addRole({ id: 'qa', dept: 'eng', name: '验收员', prompt: '负责验收', executor: 'claude' });
  const prompts = [];
  const echo = { async run({ prompt }) { prompts.push(prompt); if (/会议共识判定/.test(prompt)) return { output: '{"status":"consensus","reason":"议程已收束"}', success: true }; return { output: '发言', success: true }; } };
  const plan = {
    task: '设计本地存储与失败回滚方案',
    steps: [
      { id: 'meet_arch', role: 'arch', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'meet_qa', role: 'qa', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'decide_plan', role: 'arch', agent: 'claude', prompt: '综合方案', deps: ['meet_arch', 'meet_qa'] },
      { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { attendees: ['arch', 'qa'], meetIds: ['meet_arch', 'meet_qa'], decideId: 'decide_plan' },
  };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };
  await runTask(id, deps);
  await wait(60);
  await endMeeting(id, deps);
  assert.ok(prompts.some((p) => /【知识检索】/.test(p) && /项目约定\.md/.test(p) && /SQLite/.test(p)), '会议应注入任务目录Markdown知识片段');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会议室:知识检索跳过未命中文件继续扫描后续Markdown', async () => {
  const store = open(':memory:');
  const dir = path.join(os.tmpdir(), 'orch-meet-knowledge-scan-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '00-无关.md'), '# 无关\n\n这里没有目标词。', 'utf8');
  fs.writeFileSync(path.join(dir, '99-项目约定.md'), '# 项目约定\n\nSQLite 方案必须声明事务回滚 UNIQUE_MEET_KNOWLEDGE。\n', 'utf8');
  const id = store.createTask('设计 SQLite 本地存储方案');
  store.setTaskDir(id, dir);
  store.addDept({ id: 'eng', name: '工程部', color: '#7C6FD9' });
  store.addRole({ id: 'arch', dept: 'eng', name: '架构师', prompt: '负责架构', executor: 'claude' });
  store.addRole({ id: 'qa', dept: 'eng', name: '验收员', prompt: '负责验收', executor: 'claude' });
  const prompts = [];
  const echo = { async run({ prompt }) { prompts.push(prompt); if (/会议共识判定/.test(prompt)) return { output: '{"status":"consensus","reason":"议程已收束"}', success: true }; return { output: '发言', success: true }; } };
  const plan = {
    task: '设计 SQLite 本地存储方案',
    steps: [
      { id: 'meet_arch', role: 'arch', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'meet_qa', role: 'qa', agent: 'claude', prompt: '开场观点', deps: [] },
      { id: 'decide_plan', role: 'arch', agent: 'claude', prompt: '综合方案', deps: ['meet_arch', 'meet_qa'] },
      { id: 'impl', role: 'arch', agent: 'claude', prompt: '按方案实现', deps: ['decide_plan'] },
    ],
    meeting: { attendees: ['arch', 'qa'], meetIds: ['meet_arch', 'meet_qa'], decideId: 'decide_plan' },
  };
  const deps = { store, adapters: { claude: echo }, workspace: { make: () => dir }, runs: new Map(), onEvent: () => {}, makePlan: async () => plan };
  await runTask(id, deps);
  await wait(60);
  await endMeeting(id, deps);
  assert.ok(prompts.some((p) => /【知识检索】/.test(p) && /99-项目约定\.md/.test(p) && /UNIQUE_MEET_KNOWLEDGE/.test(p)), '会议检索不能被前面的无关 Markdown 截断');
  fs.rmSync(dir, { recursive: true, force: true });
});
