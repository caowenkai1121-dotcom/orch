class MaestroBase extends RT.Component {
  state = {
    screen: 'dashboard',
    orchMode: 'graph',
    deptId: 'dev',
    agentId: 'claude-dev-01',
    taskId: 'T-1042',
    projectId: 'P-01',
    tick: 0,
    clockS: 14 * 3600 + 32 * 60 + 10,
    doneToday: 37,
    activity: [],
    prog: {},
    actionTxt: {},
    log: {},
  };

  TYPES = {
    claude:  { label: 'Claude', color: '#7C6FD9', soft: 'rgba(124,111,217,.18)', av: 'C' },
    codex:   { label: 'Codex',  color: '#4F8BE8', soft: 'rgba(79,139,232,.18)', av: 'X' },
    design:  { label: '设计 Agent', color: '#2FAE9E', soft: 'rgba(47,174,158,.18)', av: '设' },
    video:   { label: '视频 Agent', color: '#E06A63', soft: 'rgba(224,106,99,.18)', av: '视' },
    content: { label: '文案 Agent', color: '#E0922E', soft: 'rgba(224,146,46,.18)', av: '文' },
    data:    { label: '数据 Agent', color: '#5AA469', soft: 'rgba(90,164,105,.18)', av: '数' },
  };

  AGENTS = [
    { id:'claude-dev-01', name:'Claude 开发-01', type:'claude', dept:'dev', status:'working', task:'登录模块重构', taskId:'T-1042', action:'编写 token 刷新逻辑…', actions:['编写 token 刷新逻辑…','运行本地单元测试…','修复时区边界用例…','提交第 4 版变更…'], progress:62, model:'claude-sonnet', success:'98.2%', done:142, avg:'4m 12s', cost:'¥3.4', caps:['代码生成','重构','单元测试','文档'] },
    { id:'claude-dev-02', name:'Claude 开发-02', type:'claude', dept:'dev', status:'working', task:'支付回调', taskId:'T-1043', action:'拆分子任务 (7)…', actions:['拆分子任务 (7)…','实现回调签名校验…','接入沙箱环境…'], progress:28, model:'claude-sonnet', success:'97.0%', done:88, avg:'5m 02s', cost:'¥2.1', caps:['代码生成','API 设计','联调'] },
    { id:'codex-qa-01', name:'Codex 验证-01', type:'codex', dept:'qa', status:'working', task:'登录模块重构', taskId:'T-1042', action:'回归用例 18/24…', actions:['回归用例 18/24…','重跑失败断言…','生成测试报告…','回归 24/24 通过 ✓'], progress:75, model:'codex', success:'99.1%', done:210, avg:'2m 03s', cost:'¥1.2', caps:['功能验证','回归测试','沙箱执行'] },
    { id:'codex-qa-02', name:'Codex 验证-02', type:'codex', dept:'qa', status:'review', task:'支付回调', taskId:'T-1043', action:'等待开发移交…', actions:['等待开发移交…'], progress:0, model:'codex', success:'98.7%', done:176, avg:'2m 20s', cost:'¥0.9', caps:['功能验证','安全检查'] },
    { id:'content-01', name:'文案 Agent-01', type:'content', dept:'content', status:'working', task:'新功能引导视频', taskId:'T-1051', action:'撰写引导脚本 第5段…', actions:['撰写引导脚本 第5段…','优化分镜话术…','交付脚本 5 段 ✓'], progress:54, model:'gpt-writer', success:'96.4%', done:64, avg:'3m 40s', cost:'¥1.0', caps:['脚本','文案','分镜'] },
    { id:'design-01', name:'设计 Agent-01', type:'design', dept:'design', status:'working', task:'新功能引导视频', taskId:'T-1051', action:'导出登录页视觉稿 v3…', actions:['导出登录页视觉稿 v3…','生成引导插画 6 张…','交付设计稿 ✓'], progress:48, model:'image-xl', success:'95.0%', done:51, avg:'6m 10s', cost:'¥4.2', caps:['视觉稿','插画','导出切图'] },
    { id:'design-02', name:'设计 Agent-02', type:'design', dept:'design', status:'blocked', task:'登录页视觉稿', taskId:'T-1048', action:'等待文案交付脚本…', actions:['等待文案交付脚本…'], progress:0, model:'image-xl', success:'95.6%', done:39, avg:'6m 02s', cost:'¥0.0', caps:['视觉稿','品牌物料'] },
    { id:'video-01', name:'视频 Agent-01', type:'video', dept:'design', status:'working', task:'新功能引导视频', taskId:'T-1051', action:'渲染引导动画 720p 剩余 00:42…', actions:['渲染引导动画 720p 剩余 00:42…','合成字幕与配乐…','导出 1080p ✓'], progress:81, model:'video-gen', success:'93.8%', done:27, avg:'9m 30s', cost:'¥7.8', caps:['视频生成','动效','字幕'] },
    { id:'data-01', name:'数据 Agent-01', type:'data', dept:'data', status:'idle', task:'—', taskId:'', action:'空闲 · 等待任务', actions:['空闲 · 等待任务'], progress:0, model:'analyst', success:'97.7%', done:73, avg:'1m 58s', cost:'¥0.4', caps:['报表','漏斗','SQL'] },
  ];

  DEPTS = [
    { id:'dev', name:'开发部', glyph:'</>', color:'#7C6FD9', soft:'rgba(124,111,217,.2)', desc:'编写与重构代码、实现功能', lead:'李航', tasks:6, doneWeek:24, successAvg:'97.6%' },
    { id:'qa', name:'测试 / QA 部', glyph:'✓', color:'#4F8BE8', soft:'rgba(79,139,232,.2)', desc:'功能验证、回归与质量把关', lead:'陈默', tasks:4, doneWeek:31, successAvg:'99.0%' },
    { id:'design', name:'设计部', glyph:'◆', color:'#2FAE9E', soft:'rgba(47,174,158,.2)', desc:'脚本 → 设计图 → 视频 一体化产出', lead:'王琪', tasks:5, doneWeek:18, successAvg:'94.4%' },
    { id:'content', name:'内容 / 文案部', glyph:'¶', color:'#E0922E', soft:'rgba(224,146,46,.2)', desc:'脚本、文案与话术', lead:'王琪', tasks:3, doneWeek:22, successAvg:'96.4%' },
    { id:'data', name:'数据分析部', glyph:'▦', color:'#5AA469', soft:'rgba(90,164,105,.2)', desc:'报表、漏斗与数据洞察', lead:'赵蕾', tasks:2, doneWeek:14, successAvg:'97.7%' },
    { id:'ops', name:'运营部', glyph:'◎', color:'#E06A63', soft:'rgba(224,106,99,.2)', desc:'活动编排与增长', lead:'孙阳', tasks:2, doneWeek:9, successAvg:'95.2%' },
  ];

  BOARDS = {
    dev: { todo:[{t:'刷新令牌轮换',m:'待 Claude 认领'},{t:'统一错误码',m:'P-01 · 中优先'}], doing:[{t:'登录模块重构',m:'Claude 开发-01 · 62%'},{t:'支付回调',m:'Claude 开发-02 · 28%'}], done:[{t:'用户表迁移',m:'昨日 · 已合并'},{t:'登录限流',m:'2 天前'}] },
    qa:  { todo:[{t:'支付回调验证',m:'等待开发移交'}], doing:[{t:'登录回归 24 例',m:'Codex 验证-01 · 75%'}], done:[{t:'注册流程回归',m:'24/24 通过'},{t:'权限边界',m:'昨日'}] },
    design: { todo:[{t:'登录页视觉稿',m:'阻塞 · 待脚本'}], doing:[{t:'引导插画 6 张',m:'设计 Agent-01 · 48%'},{t:'引导动画 30s',m:'视频 Agent-01 · 81%'}], done:[{t:'品牌色板',m:'已交付'}] },
    content: { todo:[{t:'FAQ 话术',m:'待认领'}], doing:[{t:'引导脚本 5 段',m:'文案 Agent-01 · 54%'}], done:[{t:'登录页文案',m:'已交付'}] },
    data: { todo:[{t:'留存看板',m:'待排期'}], doing:[{t:'转化漏斗报表',m:'排队中'}], done:[{t:'A/B 显著性',m:'昨日'}] },
    ops: { todo:[{t:'拉新活动编排',m:'草拟中'}], doing:[{t:'推送文案排期',m:'进行中'}], done:[{t:'周报自动化',m:'已上线'}] },
  };

  PROJECTS = [
    { id:'P-01', name:'Acme Web 重构', client:'Acme Inc.', progress:64, status:'进行中', sk:'working', depts:['dev','qa','design'], agentCount:5, taskCount:18, tasks:['T-1042','T-1043','T-1048'] },
    { id:'P-02', name:'智能客服 v2', client:'内部', progress:38, status:'进行中', sk:'working', depts:['dev','data','content'], agentCount:4, taskCount:12, tasks:['T-1043'] },
    { id:'P-03', name:'品牌官网', client:'Lumen', progress:82, status:'验收中', sk:'review', depts:['design','content','video'], agentCount:3, taskCount:9, tasks:['T-1051'] },
    { id:'P-04', name:'数据看板', client:'内部', progress:12, status:'规划', sk:'idle', depts:['data','dev'], agentCount:2, taskCount:6, tasks:['T-1039'] },
  ];

  TASKS = [
    { id:'T-1042', title:'登录模块重构与回归', proj:'Acme Web 重构', sk:'working', agents:['claude-dev-01','codex-qa-01'], updated:'刚刚' },
    { id:'T-1043', title:'支付回调验证', proj:'Acme Web 重构', sk:'review', agents:['claude-dev-02','codex-qa-02'], updated:'3 分钟前' },
    { id:'T-1051', title:'新功能引导视频', proj:'品牌官网', sk:'working', agents:['content-01','design-01','video-01'], updated:'刚刚' },
    { id:'T-1048', title:'登录页视觉稿', proj:'Acme Web 重构', sk:'blocked', agents:['design-02'], updated:'12 分钟前' },
    { id:'T-1039', title:'转化漏斗分析', proj:'数据看板', sk:'done', agents:['data-01'], updated:'1 小时前' },
  ];

  RELAY = [
    { who:'张远', avatar:'张', color:'#E0922E', title:'创建任务并下发编排器', sk:'done', desc:'目标：重构登录模块的 token 刷新逻辑，并通过全部回归用例。', time:'14:20', dur:'—' },
    { who:'编排器', avatar:'◆', color:'#1A1814', title:'拆解任务 · 生成 开发↔验证 流水线', sk:'done', desc:'分配 Claude 开发-01 实现，Codex 验证-01 回归；建立失败回退环。', time:'14:21', dur:'8s' },
    { who:'Claude 开发-01', avatar:'C', color:'#7C6FD9', title:'实现 token 刷新 + 单元测试', sk:'done', desc:'重写 refresh.ts，新增过期边界用例。', time:'14:25', dur:'4m 12s', art:'code', artLabel:'diff · refresh.ts +86 −12' },
    { who:'Codex 验证-01', avatar:'X', color:'#4F8BE8', title:'回归验证 24 用例 → 3 处失败', sk:'done', back:true, desc:'token 过期时区边界断言失败，已退回开发。', time:'14:31', dur:'2m 03s', art:'report', artLabel:'report · 21/24 通过', barPct:'88%', barColor:'#E0922E' },
    { who:'Claude 开发-01', avatar:'C', color:'#7C6FD9', title:'修复时区边界并补充用例', sk:'done', desc:'修正 expiresAt 的 UTC 处理，新增 expiry.spec.ts。', time:'14:36', dur:'3m 28s', art:'code', artLabel:'diff · v4 +34 −9' },
    { who:'Codex 验证-01', avatar:'X', color:'#4F8BE8', title:'重新验证 → 24/24 全部通过', sk:'done', desc:'全部回归与新增用例通过，质量门禁放行。', time:'14:40', dur:'1m 47s', art:'report', artLabel:'report · 24/24 ✓', barPct:'100%', barColor:'#2E9E5B' },
    { who:'编排器', avatar:'◆', color:'#1A1814', title:'合并分支并部署预览环境', sk:'working', desc:'正在合并并部署到 preview-42 …', time:'刚刚', dur:'进行中' },
  ];

  PLAN = [
    { n:1, title:'拆解目标', agent:'编排器', avatar:'◆', color:'#1A1814', sk:'done', eta:'8s', dep:'' },
    { n:2, title:'开发：token 刷新 + 单测', agent:'Claude 开发-01', avatar:'C', color:'#7C6FD9', sk:'working', eta:'~ 6 分钟', dep:'依赖 步骤 1' },
    { n:3, title:'验证：回归 24 用例', agent:'Codex 验证-01', avatar:'X', color:'#4F8BE8', sk:'queued', eta:'~ 3 分钟', dep:'依赖 步骤 2 · 失败回退' },
    { n:4, title:'文案：引导脚本 5 段', agent:'文案 Agent-01', avatar:'文', color:'#E0922E', sk:'working', eta:'~ 4 分钟', dep:'并行' },
    { n:5, title:'设计：登录页 + 引导图', agent:'设计 Agent-01', avatar:'设', color:'#2FAE9E', sk:'queued', eta:'~ 8 分钟', dep:'依赖 步骤 4' },
    { n:6, title:'视频：引导动画 30s', agent:'视频 Agent-01', avatar:'视', color:'#E06A63', sk:'queued', eta:'~ 9 分钟', dep:'依赖 步骤 5' },
    { n:7, title:'合并部署', agent:'编排器', avatar:'◆', color:'#1A1814', sk:'queued', eta:'~ 2 分钟', dep:'依赖 步骤 3' },
  ];

  PEOPLE = [
    { name:'张远', av:'张', color:'#E0922E', role:'产品负责人', email:'zhang@acme.com', projects:3, agents:6, last:'刚刚' },
    { name:'李航', av:'李', color:'#7C6FD9', role:'开发负责人', email:'li@acme.com', projects:2, agents:2, last:'2 分钟前' },
    { name:'王琪', av:'王', color:'#2FAE9E', role:'设计负责人', email:'wang@acme.com', projects:2, agents:3, last:'刚刚' },
    { name:'陈默', av:'陈', color:'#4F8BE8', role:'QA 负责人', email:'chen@acme.com', projects:1, agents:2, last:'8 分钟前' },
    { name:'赵蕾', av:'赵', color:'#5AA469', role:'数据负责人', email:'zhao@acme.com', projects:1, agents:1, last:'1 小时前' },
    { name:'孙阳', av:'孙', color:'#E06A63', role:'运营', email:'sun@acme.com', projects:1, agents:1, last:'昨天' },
  ];

  EVENTS = [
    { a:'Codex 验证-01', c:'#4F8BE8', t:'回归测试 24/24 全部通过 ✓', dot:'#2E9E5B', soft:'#E4F4EA' },
    { a:'编排器', c:'#1A1814', t:'将「合并部署」加入队列', dot:'#C9C5BB', soft:'#F0EEE9' },
    { a:'Claude 开发-01', c:'#7C6FD9', t:'修复 token 过期时区边界，提交第 4 版', dot:'#F0B400', soft:'#FFF6D6' },
    { a:'Codex 验证-01', c:'#4F8BE8', t:'发现 3 处断言失败，已退回 Claude 开发-01', dot:'#DC5B52', soft:'#FBE9E7' },
    { a:'设计 Agent-01', c:'#2FAE9E', t:'导出登录页视觉稿 v3（6 张）', dot:'#2FAE9E', soft:'#E3F5F2' },
    { a:'视频 Agent-01', c:'#E06A63', t:'渲染引导动画 720p，剩余 00:42', dot:'#F0B400', soft:'#FFF6D6' },
    { a:'文案 Agent-01', c:'#E0922E', t:'交付引导脚本 5 段，移交设计部', dot:'#2E9E5B', soft:'#E4F4EA' },
    { a:'Claude 开发-02', c:'#7C6FD9', t:'拉取支付回调需求，拆分为 7 个子任务', dot:'#4F8BE8', soft:'#E8F0FD' },
    { a:'编排器', c:'#1A1814', t:'将「支付回调验证」分配给 Codex 验证-02', dot:'#C9C5BB', soft:'#F0EEE9' },
    { a:'数据 Agent-01', c:'#5AA469', t:'生成转化漏斗报表，等待复核', dot:'#2E9E5B', soft:'#E4F4EA' },
  ];

  LOGS = {
    'claude-dev-01': ['读取 repo · 分析 auth/ 模块 (12 files)','编写 token 刷新逻辑 …','+ src/auth/refresh.ts (+86 −12)','运行本地单测 … 18 passed','▸ 提交第 3 版，移交 Codex 验证-01','◂ Codex 退回：3 处断言失败 (过期边界)','定位 expiresAt 时区问题 …','修正 UTC 处理，新增 expiry.spec.ts','运行本地单测 … 21 passed','▸ 提交第 4 版，重新移交验证'],
    'codex-qa-01': ['接收移交 · 启动沙箱环境','加载回归套件 (24 cases)','run auth.spec … 18 passed','run expiry.spec … 3 failed','✗ 过期边界断言不匹配','▸ 生成报告 21/24，退回开发','◂ 收到修复版 v4','重跑回归套件 …','run expiry.spec … passed','✓ 24/24 全部通过，放行'],
    'content-01': ['解析引导视频需求','撰写第 1 段：欢迎 …','撰写第 2 段：安全说明 …','优化分镜话术 …','撰写第 5 段：行动召唤 …','▸ 交付脚本 5 段，移交设计部'],
    'design-01': ['接收脚本 5 段','生成登录页视觉稿 v1 …','调整栅格与配色 …','导出 v3（6 张切图）','▸ 交付设计稿，移交视频 Agent'],
    'video-01': ['接收设计稿 6 张','合成时间线 30s …','渲染 720p …','合成字幕与配乐 …','导出 1080p …'],
  };

  componentDidMount() {
    for (let i = 0; i < 6; i++) {
      const e = this.EVENTS[(this.EVENTS.length - 1 - i + this.EVENTS.length) % this.EVENTS.length];
      this.state.activity.push({ ...e, id: 'seed' + i, time: this.fmt(this.state.clockS - i * 7) });
    }
    const seedLog = (this.LOGS[this.state.agentId] || []).slice(0, 6).map((l, i) => '[' + this.fmt(this.state.clockS - (6 - i) * 5) + '] ' + l);
    this.state.log[this.state.agentId] = seedLog;
    this.startTimer();
  }
  componentDidUpdate(prev) {
    if (prev && prev.__tickMs !== this.props.tickMs) { this.startTimer(); }
  }
  componentWillUnmount() { clearInterval(this.timer); }
  startTimer() {
    clearInterval(this.timer);
    const ms = Math.max(400, this.props.tickMs || 1200);
    this.timer = setInterval(() => this.tickFn(), ms);
  }

  tickFn() {
    if (this.props.paused) return;
    this.setState(s => {
      const tick = s.tick + 1;
      const clockS = s.clockS + 2 + (tick % 4);
      const prog = { ...s.prog };
      const actionTxt = { ...s.actionTxt };
      this.AGENTS.forEach(a => {
        if (a.status !== 'working') return;
        let p = (prog[a.id] == null ? a.progress : prog[a.id]) + 2 + Math.floor(Math.random() * 5);
        if (p >= 100) {
          p = 4 + Math.floor(Math.random() * 8);
          a._ai = (a._ai == null ? 0 : a._ai + 1);
          actionTxt[a.id] = a.actions[a._ai % a.actions.length];
        }
        prog[a.id] = p;
      });
      const ev = this.EVENTS[tick % this.EVENTS.length];
      const activity = [{ ...ev, id: 'e' + tick, time: '刚刚' }, ...s.activity.map(x => ({ ...x, time: x.time === '刚刚' ? this.fmt(clockS - 3) : x.time }))].slice(0, 18);
      const log = { ...s.log };
      if (s.screen === 'agent') {
        const scr = this.LOGS[s.agentId] || [];
        if (scr.length) {
          const cur = log[s.agentId] ? [...log[s.agentId]] : [];
          cur.push('[' + this.fmt(clockS) + '] ' + scr[tick % scr.length]);
          log[s.agentId] = cur.slice(-60);
        }
      }
      const doneToday = s.doneToday + (tick % 9 === 0 ? 1 : 0);
      return { tick, clockS, prog, actionTxt, activity, log, doneToday };
    });
  }

  fmt(s) {
    s = ((s % 86400) + 86400) % 86400;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), c = s % 60;
    const z = n => (n < 10 ? '0' + n : '' + n);
    return z(h) + ':' + z(m) + ':' + z(c);
  }
  acc() { return this.props.accent || '#FFC400'; }
  accTxt() {
    const h = this.acc().replace('#', '');
    if (h.length < 6) return '#1A1814';
    const r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1A1814' : '#ffffff';
  }

  statusMeta(s) {
    return ({
      working: { label:'运行中', c:'#8a6d00', bg:'#FFF6D6', dot: this.acc() },
      idle:    { label:'空闲', c:'#6B6760', bg:'#F1EFEA', dot:'#C9C4BA' },
      blocked: { label:'阻塞', c:'#B4541E', bg:'#FCEBDD', dot:'#E0922E' },
      done:    { label:'已完成', c:'#1F7A46', bg:'#E4F4EA', dot:'#2E9E5B' },
      failed:  { label:'失败', c:'#B23A33', bg:'#FBE9E7', dot:'#DC5B52' },
      review:  { label:'待审', c:'#3E5BD0', bg:'#E8ECFB', dot:'#4F6AE8' },
      queued:  { label:'排队中', c:'#6B6760', bg:'#F1EFEA', dot:'#C9C4BA' },
    })[s] || { label:s, c:'#6B6760', bg:'#F1EFEA', dot:'#C9C4BA' };
  }

  decA(a) {
    const t = this.TYPES[a.type];
    const sm = this.statusMeta(a.status);
    const p = this.state.prog[a.id] == null ? a.progress : this.state.prog[a.id];
    const act = this.state.actionTxt[a.id] || a.action;
    return { ...a, color:t.color, soft:t.soft, avatar:t.av, typeLabel:t.label, sLabel:sm.label, sC:sm.c, sBg:sm.bg, sDot:sm.dot, pct: p + '%', action: act, open: () => this.go('agent', { agentId: a.id }) };
  }
  decMini(id) { const a = this.AGENTS.find(x => x.id === id); const t = this.TYPES[a.type]; return { color: t.color, avatar: t.av }; }
  deptColor(id) { const d = this.DEPTS.find(x => x.id === id); return d ? d.color : '#C9C5BB'; }
  deptName(id) { const d = this.DEPTS.find(x => x.id === id); return d ? d.name : id; }

  decD(d) {
    const ags = this.AGENTS.filter(a => a.dept === d.id);
    const working = ags.filter(a => a.status === 'working').length;
    const blocked = ags.some(a => a.status === 'blocked');
    const on = this.state.screen === 'department' && this.state.deptId === d.id;
    return {
      ...d, agentCount: ags.length,
      statusDot: blocked ? '#E0922E' : (working ? this.acc() : '#C9C4BA'),
      statusTxt: blocked ? '有阻塞' : (working ? working + ' 个运行中' : '空闲'),
      open: () => this.go('department', { deptId: d.id }),
      nbg: on ? '#F2F0EA' : 'transparent', nfg: on ? '#1A1814' : '#57534E', nw: on ? '600' : '500', nbar: on ? 'inset 3px 0 0 ' + this.acc() : 'none',
      isDesign: d.id === 'design',
      agents: ags.map(a => this.decA(a)),
      board: (() => { const b = this.BOARDS[d.id] || { todo:[], doing:[], done:[] }; return { ...b, todoN: b.todo.length, doingN: b.doing.length, doneN: b.done.length }; })(),
    };
  }

  decP(p) {
    const sm = this.statusMeta(p.sk);
    return {
      ...p, pct: p.progress + '%', barColor: p.sk === 'review' ? '#2E9E5B' : this.acc(),
      sBg: sm.bg, sC: sm.c,
      deptDots: p.depts.map(id => ({ color: this.deptColor(id) })),
      deptChips: p.depts.map(id => ({ color: this.deptColor(id), name: this.deptName(id) })),
      deptN: p.depts.length,
      open: () => this.go('project', { projectId: p.id }),
      tasks: p.tasks.map(tid => this.decTRow(this.TASKS.find(t => t.id === tid))).filter(Boolean),
    };
  }

  decTRow(t) {
    if (!t) return null;
    const sm = this.statusMeta(t.sk);
    return { ...t, sLabel: sm.label, sC: sm.c, sBg: sm.bg, sDot: sm.dot, assignees: t.agents.map(id => this.decMini(id)), open: () => this.go('task', { taskId: t.id }) };
  }

  decTask(t) {
    const sm = this.statusMeta(t.sk);
    const steps = this.RELAY.map(s => {
      const m = this.statusMeta(s.sk);
      return { ...s, sLabel: m.label, sC: m.c, sBg: m.bg, sDot: m.dot, hasCode: s.art === 'code', hasReport: s.art === 'report', barPct: s.barPct || '0%', barColor: s.barColor || '#2E9E5B' };
    });
    return { ...t, sLabel: sm.label, sC: sm.c, sBg: sm.bg, sDot: sm.dot, steps };
  }

  navFor(on) { return { bg: on ? '#F2F0EA' : 'transparent', fg: on ? '#1A1814' : '#57534E', w: on ? '600' : '500', bar: on ? 'inset 3px 0 0 ' + this.acc() : 'none' }; }
  segFor(on) { return { bg: on ? '#fff' : 'transparent', fg: on ? '#1A1814' : '#8A857C', sh: on ? '0 1px 2px rgba(20,18,14,.08)' : 'none' }; }

  go(screen, extra) { this.setState({ screen, ...(extra || {}) }); }

  renderVals() {
    const s = this.state;
    const acc = this.acc();
    const agents = this.AGENTS.map(a => this.decA(a));
    const activeAgents = agents.filter(a => a.status === 'working');
    const depts = this.DEPTS.map(d => this.decD(d));
    const dept = this.decD(this.DEPTS.find(d => d.id === s.deptId) || this.DEPTS[0]);
    const agent = this.decA(this.AGENTS.find(a => a.id === s.agentId) || this.AGENTS[0]);
    const projects = this.PROJECTS.map(p => this.decP(p));
    const project = this.decP(this.PROJECTS.find(p => p.id === s.projectId) || this.PROJECTS[0]);
    const task = this.decTask(this.TASKS.find(t => t.id === s.taskId) || this.TASKS[0]);
    const tasksList = this.TASKS.map(t => this.decTRow(t));
    const cvIds = { dev:'claude-dev-01', qa:'codex-qa-01', content:'content-01', design:'design-01', video:'video-01' };
    const cv = {}; Object.keys(cvIds).forEach(k => cv[k] = this.decA(this.AGENTS.find(a => a.id === cvIds[k])));
    const planSteps = this.PLAN.map(p => {
      const m = this.statusMeta(p.sk);
      const on = p.sk === 'working';
      return { ...p, sLabel: m.label, sC: m.c, sBg: m.bg, sDot: m.dot,
        ringBg: p.sk === 'done' ? '#1A1814' : (on ? acc : '#fff'),
        ringBd: p.sk === 'done' ? '#1A1814' : (on ? acc : '#E2DFD7'),
        ringFg: p.sk === 'done' ? '#fff' : (on ? this.accTxt() : '#A39E94'),
        cardBd: on ? acc : '#E9E7E1' };
    });

    const labels = { dashboard:['工作区','总控台'], orchestration:['工作区','编排画布'], projects:['工作区','项目'], project:['项目', project.name], tasks:['工作区','任务'], task:['任务', task.title], agents:['团队','Agent 团队'], agent:['Agent', agent.name], department:['部门', dept.name], people:['团队','人员'] };
    const lab = labels[s.screen] || ['工作区',''];

    const metrics = [
      { k:'运行中 Agent', v: '' + activeAgents.length, s:'共 9 个 · 4 个部门', dot: acc },
      { k:'进行中任务', v:'14', s:'+3 今日新增', dot:'#4F8BE8' },
      { k:'今日已完成', v: '' + s.doneToday, s:'昨日 31', dot:'#2E9E5B' },
      { k:'阻塞 / 待审', v:'3', s:'1 阻塞 · 2 待审', dot:'#E0922E' },
    ];

    return {
      isDashboard: s.screen === 'dashboard', isOrch: s.screen === 'orchestration', isDept: s.screen === 'department',
      isTask: s.screen === 'task', isAgent: s.screen === 'agent', isProjects: s.screen === 'projects',
      isProject: s.screen === 'project', isTasks: s.screen === 'tasks', isAgents: s.screen === 'agents', isPeople: s.screen === 'people',
      isGraph: s.orchMode === 'graph', isAuto: s.orchMode === 'auto',
      acc, accTxt: this.accTxt(), accBd: acc,
      clock: this.fmt(s.clockS), activeCount: '' + activeAgents.length,
      crumbRoot: lab[0], crumbLeaf: lab[1],
      nav: { dash: this.navFor(s.screen === 'dashboard'), orch: this.navFor(s.screen === 'orchestration'), projects: this.navFor(s.screen === 'projects' || s.screen === 'project'), tasks: this.navFor(s.screen === 'tasks' || s.screen === 'task'), agents: this.navFor(s.screen === 'agents' || s.screen === 'agent'), people: this.navFor(s.screen === 'people') },
      modeGraph: this.segFor(s.orchMode === 'graph'), modeAuto: this.segFor(s.orchMode === 'auto'),
      metrics, activity: s.activity, activeAgents, agents, depts, dept, agent, project, projects, task, tasksList, cv, planSteps, people: this.PEOPLE,
      agentLog: s.log[s.agentId] || [],
      logRef: (el) => { if (el) el.scrollTop = el.scrollHeight; },
      goDash: () => this.go('dashboard'), goOrch: () => this.go('orchestration'), goProjects: () => this.go('projects'),
      goTasks: () => this.go('tasks'), goAgents: () => this.go('agents'), goPeople: () => this.go('people'),
      setGraph: () => this.setState({ orchMode: 'graph' }), setAuto: () => this.setState({ orchMode: 'auto' }),
      newTask: () => this.setState({ screen: 'orchestration', orchMode: 'auto' }),
      openCurTask: () => this.go('task', { taskId: agent.taskId || 'T-1042' }),
    };
  }
}


// —— 迷你 Markdown 渲染(零依赖,够用) ——
function mdEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function mdInline(s) {
  return mdEsc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
}
function md2html(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  let html = '', inCode = false, codeBuf = [], listType = null;
  const closeList = () => { if (listType) { html += '</' + listType + '>'; listType = null; } };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^```/.test(ln)) { if (inCode) { html += '<pre><code>' + mdEsc(codeBuf.join('\n')) + '</code></pre>'; codeBuf = []; inCode = false; } else { closeList(); inCode = true; } continue; }
    if (inCode) { codeBuf.push(ln); continue; }
    if (/^\s*$/.test(ln)) { closeList(); continue; }
    let m;
    if ((m = ln.match(/^(#{1,6})\s+(.*)/))) { closeList(); html += '<h' + m[1].length + '>' + mdInline(m[2]) + '</h' + m[1].length + '>'; continue; }
    if (/^\s*[-*+]\s+/.test(ln)) { if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; } html += '<li>' + mdInline(ln.replace(/^\s*[-*+]\s+/, '')) + '</li>'; continue; }
    if (/^\s*\d+\.\s+/.test(ln)) { if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; } html += '<li>' + mdInline(ln.replace(/^\s*\d+\.\s+/, '')) + '</li>'; continue; }
    if (/^>\s?/.test(ln)) { closeList(); html += '<blockquote>' + mdInline(ln.replace(/^>\s?/, '')) + '</blockquote>'; continue; }
    if (/^(-{3,}|\*{3,})$/.test(ln)) { closeList(); html += '<hr>'; continue; }
    closeList(); html += '<p>' + mdInline(ln) + '</p>';
  }
  if (inCode) html += '<pre><code>' + mdEsc(codeBuf.join('\n')) + '</code></pre>';
  closeList();
  return html;
}
function mdDoc(md) {
  return '<!doctype html><html><head><meta charset="utf-8"><style>'
    + 'body{font:14px/1.7 -apple-system,system-ui,"Segoe UI",sans-serif;color:#2A2722;padding:22px 26px;max-width:820px;margin:0 auto;}'
    + 'h1,h2,h3,h4{line-height:1.3;margin:1.2em 0 .5em;}h1{font-size:1.7em;border-bottom:1px solid #eee;padding-bottom:.3em;}h2{font-size:1.4em;}h3{font-size:1.15em;}'
    + 'pre{background:#F6F5F2;padding:12px 14px;border-radius:8px;overflow:auto;}code{background:#F0EEE9;padding:1px 5px;border-radius:4px;font-family:ui-monospace,Menlo,monospace;font-size:.9em;}pre code{background:none;padding:0;}'
    + 'a{color:#B4541E;}blockquote{border-left:3px solid #E6E3DC;margin:.6em 0;padding:.2em 0 .2em 14px;color:#6B6760;}ul,ol{padding-left:1.5em;}hr{border:none;border-top:1px solid #E6E3DC;margin:1.4em 0;}img{max-width:100%;}'
    + '</style></head><body>' + md2html(md) + '</body></html>';
}

// ============ 全真数据接线:用 orch 真实数据替换原型所有 mock 数组 ============
class Maestro extends MaestroBase {
  componentDidMount() {
    // 不调 super:跳过 mock 种子与 mock tick。真实数据全部从后端拉。
    this.live = { relay: {}, plan: {}, activeId: null, counts: {} };
    this.AGENTS = []; this.DEPTS = []; this.BOARDS = {}; this.PROJECTS = []; this.TASKS = []; this.PEOPLE = [];
    this.state.activity = []; this.state.log = {}; this.state.console = {}; this.state.modal = null;
    this.state.me = null; this.state.needLogin = false; this.state.loginErr = '';
    const now = new Date();
    this.state.clockS = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    this.fetchAll();
    this.openWS();
    this._poll = setInterval(() => { this.state.clockS += 20; this.fetchAll(); }, 20000); // WS 实时推送为主,轮询只兜底
  }
  startTimer() {} // 关闭原型的 mock 动画 tick

  // —— 防御:真实数据可能为空,基类找不到对象时给安全占位 ——
  decA(a) {
    if (!a) return { name: '—', action: '未启用', pct: '0%', avatar: '·', color: '#C9C5BB', soft: '#F1EFEA', typeLabel: '', status: 'idle', sLabel: '空闲', sC: '#6B6760', sBg: '#F1EFEA', sDot: '#C9C4BA', open: () => {} };
    // 用 agent 自带 color/avatar(支持自定义 agent),不依赖写死的 TYPES
    const sm = this.statusMeta(a.status);
    const p = this.state.prog[a.id] == null ? a.progress : this.state.prog[a.id];
    const act = this.state.actionTxt[a.id] || a.action;
    return { ...a, color: a.color, soft: a.soft || ((a.color || '#7C6FD9') + '2b'), avatar: a.avatar, typeLabel: a.model || a.name, sLabel: sm.label, sC: sm.c, sBg: sm.bg, sDot: sm.dot, pct: (p || 0) + '%', action: act, open: () => this.go('agent', { agentId: a.id }) };
  }
  decTask(t) { if (!t) return { id: '', title: '暂无任务', proj: '—', sLabel: '', sC: '#6B6760', sBg: '#F1EFEA', sDot: '#C9C4BA', steps: [] }; return super.decTask(t); }
  decP(p) { if (!p) return { id: '', name: '暂无项目', client: '—', pct: '0%', barColor: '#C9C5BB', sBg: '#F1EFEA', sC: '#6B6760', status: '—', deptDots: [], deptChips: [], deptN: 0, agentCount: 0, taskCount: 0, tasks: [], open: () => {} }; return super.decP(p); }
  decD(d) { if (!d) return { id: '', name: '—', glyph: '·', color: '#C9C5BB', soft: '#F1EFEA', desc: '', lead: '—', tasks: 0, agentCount: 0, doneWeek: 0, successAvg: '—', isDesign: false, agents: [], board: { todo: [], doing: [], done: [], todoN: 0, doingN: 0, doneN: 0 }, statusDot: '#C9C4BA', statusTxt: '—', nbg: 'transparent', nfg: '#57534E', nw: '500', nbar: 'none', open: () => {} }; return super.decD(d); }

  scheduleRender() {
    if (this._pending) return;
    this._pending = true;
    setTimeout(() => { this._pending = false; this.setState({}); }, 200);
  }

  renderVals() {
    // 渲染前把基类用到的 RELAY(当前任务) / PLAN(活动任务) 同步成真实数据
    const _tid = this.state.taskId;
    const _tRec = typeof _tid === 'number' && (this.TASKS || []).find((t) => t.id === _tid);
    if (_tRec && _tRec.sk === 'awaiting') { // 审批态:任务详情用计划预览代替接力记录
      if (!this.live.plan[_tid]) this.fetchPlan(_tid);
      this.RELAY = (this.live.plan[_tid] || []).map((p) => ({ who: p.agent, avatar: p.avatar, color: p.color, title: p.title, desc: '待执行' + (p.dep ? (' · ' + p.dep) : ''), time: '', dur: '', sk: 'queued', back: false, hasCode: false, hasReport: false, barPct: '0%', barColor: '#2E9E5B' }));
    } else {
      this.RELAY = (typeof _tid === 'number' && this.live.relay[_tid]) || [];
    }
    const activeId = this.live.activeId != null ? this.live.activeId : (this.TASKS[0] && this.TASKS[0].id);
    this.PLAN = (activeId != null && this.live.plan[activeId]) || [];
    const v = super.renderVals();
    v.metrics = this.realMetrics();
    v.cv = this.realCv();
    v.graph = this.realGraph();
    v.orchLog = (this.state.activity || []).slice(0, 8).map((e) => ({ time: e.time, c: e.c, a: e.a, txt: e.t }));
    // 弹窗 + 表单提交
    v.newTask = () => this.newTask();
    v.newAgent = () => this.newAgent();
    v.newPerson = () => this.newPerson();
    v.closeModal = () => this.closeModal();
    v.submitTask = () => this.submitTask();
    v.quickLaunch = () => this.quickLaunch();
    v.onQuickKey = (e) => { if (e.key === 'Enter') this.quickLaunch(); };
    v.modelPick = this.modelPickers();
    // 剧本选项(新建任务)
    if (this.state.modal === 'task' && !this.live.playbooks) { this.live.playbooks = []; this.fetchPlaybooks(); }
    v.playbookOpts = (this.live.playbooks || []).map((p) => ({ id: p.id, name: p.name }));
    // 任务看板(参考 vibe-kanban):按状态分列
    v.taskViewBoard = this.state.taskView === 'board';
    v.taskViewList = !v.taskViewBoard;
    v.setViewList = () => this.setState({ taskView: 'list' });
    v.setViewBoard = () => this.setState({ taskView: 'board' });
    v.viewListBg = v.taskViewList ? '#fff' : 'transparent';
    v.viewBoardBg = v.taskViewBoard ? '#fff' : 'transparent';
    const COLS = [
      { key: ['queued'], name: '排队', color: '#C9C4BA' },
      { key: ['awaiting'], name: '待审批', color: '#F0B400' },
      { key: ['working'], name: '进行中', color: '#E0922E' },
      { key: ['awaiting_input'], name: '待输入', color: '#B4541E' },
      { key: ['done'], name: '已完成', color: '#2E9E5B' },
      { key: ['failed', 'cancelled'], name: '失败/取消', color: '#DC5B52' },
    ];
    v.board = COLS.map((c) => {
      const items = (this.TASKS || []).filter((t) => c.key.indexOf(t.sk) >= 0).map((t) => ({
        id: t.id, title: t.title, proj: t.proj, nowDoing: t.nowDoing || '',
        cost: t.cost ? ('$' + t.cost.toFixed(2)) : '', open: () => this.go('task', { taskId: t.id }),
      }));
      return { name: c.name, color: c.color, n: items.length, items };
    });
    // 定时任务列表(任务页)
    v.schedules = (this.live.schedules || []).map((s) => {
      const sp = s.spec || {};
      const rule = sp.kind === 'daily' ? '每天 ' + sp.at : sp.kind === 'weekly' ? '每周' + '日一二三四五六'[sp.dow] + ' ' + sp.at : sp.kind === 'hours' ? '每 ' + sp.n + ' 小时' : '?';
      return { id: s.id, text: s.text, rule, last: s.last_run ? new Date(s.last_run).toLocaleString() : '未运行', on: !!s.enabled, onLabel: s.enabled ? '开' : '停', onBg: s.enabled ? '#E4F4EA' : '#F0EEE9', onC: s.enabled ? '#1F7A46' : '#6B6760', toggle: () => this.toggleSchedule(s.id), del: () => this.delSchedule(s.id) };
    });
    v.hasSchedules = v.schedules.length > 0;
    if (this.state.screen === 'tasks' && !this.live.schedules) { this.live.schedules = []; this.fetchSchedules(); }
    // 回放(canReplay 依赖 curT,在后面补)
    v.openReplay = () => this.openReplay();
    v.modalReplay = this.state.modal === 'replay';
    const rp2 = this.live.replay || { events: [], logsByStep: {} };
    v.repTitle = rp2.task || '';
    v.repEvents = (rp2.events || []).map((e, i) => {
      const d = e.data;
      const txt = e.type === 'status' && d && d.step ? (d.step + ' → ' + d.v) : e.type === 'plan' ? ('拆解计划(' + ((d && d.steps) || '?') + '步)') : e.type + (typeof d === 'string' ? ': ' + d : '');
      return { i, time: (e.ts || '').slice(11, 19), txt, sel: i === this.state.repSel, bg: i === this.state.repSel ? '#FFF6D6' : 'transparent', pick: () => this.setState({ repSel: i }) };
    });
    const selEv = (rp2.events || [])[this.state.repSel || 0];
    const selStep = selEv && selEv.data && selEv.data.step;
    v.repStep = selStep || '(任务级事件)';
    v.repLogs = selStep ? ((rp2.logsByStep || {})[selStep] || []).join('\n') : ((rp2.logsByStep || {})[''] || []).join('\n');
    // Webhook(账号弹窗)
    if (this.state.modal === 'account' && !this.live.hookUrl) this.fetchHook();
    v.hookUrl = this.live.hookUrl ? (location.origin + this.live.hookUrl) : '…';
    v.resetHook = () => this.resetHook();
    v.submitAgent = () => this.submitAgent();
    v.submitPerson = () => this.submitPerson();
    v.modalTask = this.state.modal === 'task';
    v.modalAgent = this.state.modal === 'agent';
    v.modalPerson = this.state.modal === 'person';
    v.modalPersonNew = this.state.modal === 'person' && !this.state.assignPid;
    v.modalPersonTitle = this.state.assignPid ? '分配 Agent' : '新建人员';
    // 真实文案绑定(替换原型写死的 张远/9个Agent/Acme 等)
    const op = this.PEOPLE[0] || { name: '操作者', av: '操', role: '操作者' };
    v.opName = op.name; v.opAv = op.av; v.opRole = (op.role || '操作者') + ' · orch';
    v.agentTotal = this.AGENTS.length; v.deptTotal = this.DEPTS.length; v.today = this.todayStr();
    const at = this.TASKS[0];
    v.activeTitle = at ? at.title : '暂无任务'; v.activeProj = at ? at.proj : '—';
    v.planCount = this.PLAN.length;
    v.planAgents = new Set(this.PLAN.map((p) => p.agent)).size;
    const r = this.RELAY || [];
    v.taskRounds = r.length; v.taskAgentN = new Set(r.map((x) => x.who)).size;
    // 人员行分配按钮 + 每 agent 实时控制台
    (v.people || []).forEach((p) => { p.assign = () => this.assignPerson(p.id); });
    v.agentLog = (this.state.console && this.state.console[this.state.agentId]) || this.state.log[this.state.agentId] || [];

    // —— T5: Agent 编辑/删除 + 弹窗编辑态 ——
    const ea = this.state.editAgent;
    v.editCurAgent = () => this.editCurAgent();
    v.delCurAgent = () => this.delCurAgent();
    v.agentModalTitle = ea ? '编辑 Agent' : '新建 Agent';
    v.agentSubmitLabel = ea ? '保存' : '创建';
    v.naName = ea ? ea.name : '';
    v.naCmd = ea ? (ea.command || '') : '';
    v.naArgs = ea ? (Array.isArray(ea.args) ? ea.args.join(' ') : '') : '';
    v.naModel = ea && ea.model && ea.model !== '—' ? ea.model : '';
    v.naCaps = ea && ea.caps ? ea.caps.join(',') : '';
    v.naImage = ea && ea.image ? ea.image : '';

    // —— T6: 项目 + 全局搜索 ——
    v.isSearch = this.state.screen === 'search';
    v.q = this.state.q || '';
    v.modalProject = this.state.modal === 'project';
    v.newProject = () => this.newProject();
    v.submitProject = () => this.submitProject();
    v.onSearchKey = (e) => this.onSearchKey(e);
    v.projOpts = (this.PROJECTS || []).map((p) => ({ name: p.name }));
    if (v.isSearch) { v.searchGroups = this.searchResults(this.state.q || ''); v.searchSummary = v.searchGroups.reduce((a, g) => a + g.items.length, 0) + ' 条结果'; v.crumbRoot = '工作区'; v.crumbLeaf = '搜索'; } else { v.searchGroups = []; v.searchSummary = ''; }

    // —— 当前登录用户(替换原身份切换) ——
    const me = this.state.me;
    const cur = me ? (this.PEOPLE || []).find((p) => p.id === me.id) : null;
    if (me) { v.opName = me.name; v.opAv = (me.name || '?').slice(0, 1).toUpperCase(); v.opRole = (me.admin ? '管理员' : (me.role || '成员')) + ' · orch'; }
    v.isAdmin = !!(me && me.admin);
    v.pickWho = () => this.openAccount(); // 点用户 → 账号菜单
    v.modalWho = false; v.whoList = [];
    // 非管理员:Agent 团队只显示分配给自己的 agent
    if (cur && !me.admin && cur.assignedIds && cur.assignedIds.length) {
      const set = new Set(cur.assignedIds);
      v.agents = (v.agents || []).filter((a) => set.has(a.id));
      v.activeAgents = (v.activeAgents || []).filter((a) => set.has(a.id));
    }
    // —— 登录/账号 ——
    v.needLogin = !!this.state.needLogin;
    v.loginErr = this.state.loginErr || '';
    v.submitLogin = () => this.submitLogin();
    v.onLoginKey = (e) => { if (e.key === 'Enter') this.submitLogin(); };
    v.logout = () => this.logout();
    v.modalAccount = this.state.modal === 'account';
    v.changePw = () => this.changePw();
    // —— 部门管理(#3) ——
    v.newDept = () => this.newDept();
    v.modalDept = this.state.modal === 'dept';
    v.submitDept = () => this.submitDept();
    v.allAgents = (this.AGENTS || []).map((a) => ({ id: a.id, name: a.name }));
    v.naKind = ea && ea.kind ? ea.kind : 'cli';
    v.kindOpts = [{ id: 'cli', name: 'CLI 智能体(claude/codex 类)' }, { id: 'llm', name: '大模型(DeepSeek 等)' }, { id: 'video', name: '视频模型(Seedance 等)' }, { id: 'voice', name: '语音模型' }].sort((a, b) => (a.id === v.naKind ? 0 : 1) - (b.id === v.naKind ? 0 : 1));
    v.naDept = ea && ea.dept ? ea.dept : ((this.DEPTS[0] && this.DEPTS[0].id) || 'dev');
    v.deptOpts = (this.DEPTS || []).map((d) => ({ id: d.id, name: d.name })).sort((a, b) => (a.id === v.naDept ? 0 : 1) - (b.id === v.naDept ? 0 : 1)); // 当前部门置顶=默认选中
    // —— 部门员工(角色) ——
    const curD = (this.DEPTS || []).find((d) => d.id === this.state.deptId);
    v.deptEmployees = ((curD && curD.employees) || []).map((e) => ({ ...e, del: () => this.fireEmp(e.id, e.name) }));
    v.deptEmpN = v.deptEmployees.length;
    v.hireEmp = () => this.setState({ modal: 'hire' });
    v.modalHire = this.state.modal === 'hire';
    v.submitHire = () => this.submitHire();
    v.execOpts = (this.AGENTS || []).filter((a) => (a.kind || 'cli') === 'cli').map((a) => ({ id: a.id, name: a.name }));
    // —— 部门工作流程(可编辑) + 执行器池 + 部门任务 ——
    v.newDeptTask = () => this.newDeptTask();
    const empName = {}; (v.deptEmployees || []).forEach((e) => { empName[e.id] = e; });
    v.deptFlow = ((curD && curD.flow) || []).map((s, i, arr) => ({
      n: i + 1, name: (empName[s.role] || {}).name || s.role, emoji: (empName[s.role] || {}).emoji || '·',
      optLabel: s.optional ? '可选' : '必经', optBg: s.optional ? '#F0EEE9' : '#E4F4EA', optC: s.optional ? '#6B6760' : '#1F7A46',
      gate: !!s.gate, notGate: !s.gate, notLast: i < arr.length - 1,
      up: () => this.moveFlow(i, -1), down: () => this.moveFlow(i, 1),
      tOpt: () => this.toggleFlowFlag(i, 'optional'), tGate: () => this.toggleFlowFlag(i, 'gate'), del: () => this.delFlowStep(i),
    }));
    v.hasFlow = v.deptFlow.length > 0;
    v.noFlow = !v.hasFlow;
    v.addFlowStep = () => this.addFlowStep();
    v.flowAddOpts = v.deptEmployees.map((e) => ({ id: e.id, name: e.name }));
    v.deptExecs = ((this.AGENTS || []).filter((a) => (a.kind || 'cli') === 'cli')).map((a) => {
      const on = ((curD && curD.executors) || []).indexOf(a.id) >= 0;
      return { id: a.id, name: a.name, on, bd: on ? '#B9E2C8' : '#E6E3DC', bg: on ? '#E4F4EA' : '#fff', toggle: () => this.toggleDeptExec(a.id) };
    });
    v.deptPoolHint = ((curD && curD.executors) || []).length ? '本部门任务只用勾选的执行器' : '未限制(可用全部执行器)';
    // 新建任务弹窗:部门上下文
    v.taskDeptName = this.state.taskDept ? ((this.DEPTS.find((d) => d.id === this.state.taskDept) || {}).name || '') : '';
    v.isDeptTask = !!(this.state.modal === 'task' && this.state.taskDept);
    // —— 项目授权(#4):项目详情 ——
    const curProj = this.state.projectId && (this.PROJECTS || []).find((p) => p.id === this.state.projectId);
    v.projAmOwner = !!(curProj && curProj.amOwner);
    v.grantPeople = (curProj ? (this.PEOPLE || []) : []).filter((p) => !me || p.id !== me.id).map((p) => {
      const on = (curProj.grantIds || []).indexOf(p.id) >= 0;
      return { id: p.id, name: p.name, av: p.av, color: p.color, on, label: on ? '已授权 ✓' : '授权', bd: on ? '#B9E2C8' : '#E6E3DC', bg: on ? '#E4F4EA' : '#fff', toggle: () => this.grantProj(curProj.name, p.id, !on) };
    });
    v.memberOpts = (this.PEOPLE || []).filter((p) => !me || p.id !== me.id).map((p) => ({ id: p.id, name: p.name })); // 新建项目归属用户选项(排除自己)

    // —— v4: 取消/成本 ——
    v.cancelTask = () => this.cancelTask();
    v.costToday = '$' + ((this.live.usage && this.live.usage.cost) || 0).toFixed(3);
    const curT = typeof this.state.taskId === 'number' && this.TASKS.find((t) => t.id === this.state.taskId);
    const canMod = !!(curT && curT.canModify); // #4 非本人任务只读
    v.viewOnly = !!(curT && !curT.canModify);
    v.canCancel = !!(curT && curT.sk === 'working' && canMod);
    v.canApprove = !!(curT && curT.sk === 'awaiting' && canMod);
    v.approveTask = () => this.approveTask();
    // 审批前编辑计划
    if (v.canApprove && this.live.rawPlanFor !== this.state.taskId) this.fetchRawPlan(this.state.taskId);
    const rp = v.canApprove && this.live.rawPlanFor === this.state.taskId && this.live.rawPlan;
    const cut = this.state.epCut || {};
    v.editSteps = (rp && rp.steps ? rp.steps : []).filter((s) => !cut[s.id]).map((s, i) => ({
      n: i + 1, id: s.id, isLoop: !!s.body, editable: !s.body,
      who: s.role || s.agent || '',
      prompt: s.body ? '' : (s.prompt || ''),
      del: () => { const c = { ...(this.state.epCut || {}) }; c[s.id] = 1; this.setState({ epCut: c }); },
    }));
    v.taskCost = curT ? ('$' + (curT.cost || 0).toFixed(3) + ' · ' + (curT.tokens || 0) + ' tok') : '—';
    // #1 决策回答
    v.canAnswer = !!(curT && curT.sk === 'awaiting_input' && canMod);
    v.question = curT ? (curT.question || '') : '';
    v.answerTask = () => this.answerTask();
    // #3 产出预览
    v.openDir = () => this.openDir();
    const filesReady = curT && this.live.filesFor === this.state.taskId && (this.live.files || []).length;
    v.hasFiles = !!filesReady;
    v.files = (filesReady ? this.live.files : []).map((f) => ({ path: f.path, bg: (f.path === this.state.previewFile ? '#F2F0EA' : 'transparent'), open: () => this.setState({ previewFile: f.path, srcMode: false }) }));
    v.preview = this.previewOf(this.state.taskId);
    v.toggleSrc = () => this.toggleSrc();
    // 产出改动(diff)
    if (curT && this.live.diffsFor !== this.state.taskId) this.fetchDiffs(this.state.taskId);
    const diffs = (curT && this.live.diffsFor === this.state.taskId && this.live.diffs) || [];
    v.hasDiffs = diffs.length > 0;
    v.diffCommits = diffs.map((c) => ({ ...c, sel: c.sha === this.state.diffSha, bg: c.sha === this.state.diffSha ? '#FFF6D6' : 'transparent', open: () => this.openDiff(c.sha) }));
    v.patchLines = (this.state.diffSha && this.live.patch ? this.live.patch.split('\n').slice(0, 1200) : []).map((l) => ({
      t: l, c: l[0] === '+' ? '#1F7A46' : l[0] === '-' ? '#B23A33' : (l.startsWith('@@') || l.startsWith('diff ')) ? '#4F8BE8' : '#57534E',
      bg: l[0] === '+' ? '#E4F4EA' : l[0] === '-' ? '#FBE9E7' : 'transparent',
    }));
    v.hasPatch = v.patchLines.length > 0;
    v.noPatch = !v.hasPatch;
    v.continueFromDiff = () => this.continueFromDiff();
    v.downloadZip = () => this.downloadZip();
    // #发布/继续
    v.canPublish = !!(curT && curT.sk === 'done' && this.state.me && this.state.me.admin && this.live.filesFor === this.state.taskId && (this.live.files || []).some((f) => /\.html$/i.test(f.path))); // 仅管理员可发布
    v.publishApp = () => this.publishApp();
    v.canContinue = !!(curT && canMod && ['done', 'cancelled', 'failed'].indexOf(curT.sk) >= 0);
    v.continueTask = () => this.continueTask();
    v.canRetry = !!(curT && canMod && curT.sk === 'failed'); // 失败任务:重试失败步骤(已完成的不重跑)
    v.retryTask = () => this.retryTask();
    v.canReplay = !!(curT && ['done', 'failed', 'cancelled', 'paused'].indexOf(curT.sk) >= 0); // 回放
    // —— 任务会话化:对话流 + 控制面 + 实时输出 ——
    if (curT && this.live.msgsFor !== this.state.taskId) this.fetchMsgs(this.state.taskId);
    v.taskMsgs = ((this.live.msgsFor === this.state.taskId && this.live.msgs) || []).slice(-30).map((m) => ({
      mine: m.who === 'user', txt: m.text, time: (m.ts || '').slice(11, 16),
      al: m.who === 'user' ? 'flex-end' : 'flex-start',
      bg: m.who === 'user' ? '#1A1814' : '#F4F2ED', fg: m.who === 'user' ? '#fff' : '#3C3933',
    }));
    v.hasMsgs = v.taskMsgs.length > 0;
    v.sendTaskMsg = () => this.sendTaskMsg();
    v.onMsgKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault && e.preventDefault(); this.sendTaskMsg(); } };
    v.msgHint = !curT ? '' : curT.sk === 'working' ? '发指令 → 注入下一个开始的步骤(实时纠偏)' : curT.sk === 'paused' ? '发消息 → 恢复执行并注入指令' : curT.sk === 'awaiting_input' ? '回答员工的问题 → 续跑' : curT.sk === 'awaiting' ? '任务待审批,先批准' : '发新需求 → 在原任务上继续开发';
    v.canPause = !!(curT && curT.sk === 'working' && canMod);
    v.pauseTaskUI = () => this.pauseTaskUI();
    v.canResume = !!(curT && curT.sk === 'paused' && canMod);
    v.resumeTaskUI = () => this.resumeTaskUI();
    // 当前任务实时输出(运行中)
    const tcl = (this.live.taskConsole && this.live.taskConsole[this.state.taskId]) || [];
    v.taskLive = tcl.slice(-14).join('\n');
    v.hasTaskLive = !!(curT && curT.sk === 'working' && tcl.length);
    // 接力记录步骤操作:排队步可跳过(运行中),失败/完成步可重跑(非运行中)
    if (v.task && v.task.steps) v.task.steps.forEach((s) => {
      s.canSkip = !!(curT && curT.sk === 'working' && s.sk === 'queued' && canMod);
      s.canRerun = !!(curT && ['done', 'failed', 'paused', 'cancelled'].indexOf(curT.sk) >= 0 && (s.sk === 'failed' || s.sk === 'done') && canMod);
      s.doSkip = () => this.skipStepUI(s.title);
      s.doRerun = () => this.rerunStepUI(s.title);
    });
    v.savePlaybook = () => this.saveAsPlaybook();
    v.canSavePb = !!(curT && curT.sk === 'done' && canMod); // 存为剧本
    v.modalContinue = this.state.modal === 'continue';
    v.continueSubmit = () => this.continueSubmit();
    // 应用广场
    v.isApps = this.state.screen === 'apps';
    if (v.nav) v.nav.apps = this.navFor(this.state.screen === 'apps');
    v.goApps = () => this.goApps();
    // 执行器健康(Agent 团队页)
    if (this.state.screen === 'agents' && !this.live.health) { this.live.health = {}; this.fetchHealth(); }
    v.execHealth = (this.AGENTS || []).filter((a) => (a.kind || 'cli') === 'cli').map((a) => { const h = (this.live.health || {})[a.id] || {}; return { name: a.name, bg: h.ok ? '#E4F4EA' : '#FBE9E7', c: h.ok ? '#1F7A46' : '#B4541E', label: h.ok ? ('✓ ' + (h.version || '可用')) : '✗ 未检测到' }; });
    v.refreshHealth = () => this.fetchHealth(true);
    const openApp = this.state.openApp;
    v.appOpen = !!openApp; v.appList = !openApp; v.curApp = openApp || {};
    v.closeApp = () => this.setState({ openApp: null });
    v.apps = (this.live.apps || []).map((a) => ({ ...a, canDel: !!(this.state.me && this.state.me.admin), open: () => this.setState({ openApp: a }), del: () => this.delApp(a.id) }));
    if (v.isApps) { v.crumbRoot = '工作区'; v.crumbLeaf = '应用广场'; }
    return v;
  }

  statusMeta(s) {
    if (s === 'cancelled') return { label: '已取消', c: '#6B6760', bg: '#F1EFEA', dot: '#C9C4BA' };
    if (s === 'awaiting') return { label: '待审批', c: '#8a6d00', bg: '#FFF6D6', dot: '#F0B400' };
    if (s === 'awaiting_input') return { label: '待输入', c: '#B4541E', bg: '#FCEBDD', dot: '#E0922E' };
    if (s === 'paused') return { label: '已暂停', c: '#6B6760', bg: '#F1EFEA', dot: '#8A857C' };
    return super.statusMeta(s);
  }
  // —— 任务会话化 ——
  fetchMsgs(id) { fetch('/api/msgs/' + id).then((r) => r.json()).then((m) => { this.live.msgs = m || []; this.live.msgsFor = id; this.scheduleRender(); }).catch(() => {}); }
  sendTaskMsg() {
    const id = this.state.taskId; if (typeof id !== 'number') return;
    const el = document.getElementById('tm-input'); const text = el ? el.value.trim() : '';
    if (!text) return;
    el.value = '';
    fetch('/task/' + id + '/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
      .then(() => { this.fetchMsgs(id); this.fetchAll(); }).catch(() => {});
  }
  pauseTaskUI() { const id = this.state.taskId; fetch('/task/' + id + '/pause', { method: 'POST' }).then(() => { this.fetchMsgs(id); this.fetchAll(); }).catch(() => {}); }
  resumeTaskUI() { const id = this.state.taskId; fetch('/task/' + id + '/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '继续按原计划执行' }) }).then(() => { this.fetchMsgs(id); this.fetchAll(); }).catch(() => {}); }
  skipStepUI(sid) { const id = this.state.taskId; fetch('/task/' + id + '/skip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stepId: sid }) }).then(() => this.fetchMsgs(id)).catch(() => {}); }
  rerunStepUI(sid) { if (!window.confirm('重跑步骤「' + sid + '」?其余已完成步骤保留。')) return; const id = this.state.taskId; fetch('/task/' + id + '/rerun', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stepId: sid }) }).then(() => this.fetchAll()).catch(() => {}); }
  answerTask() {
    const id = this.state.taskId; if (typeof id !== 'number') return;
    const el = document.getElementById('answer-input'); const answer = el ? el.value : '';
    if (!answer.trim()) return;
    const t = (this.TASKS || []).find((x) => x.id === id);
    fetch('/task/' + id + '/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stepId: t && t.blockedStep, answer: answer.trim() }) }).then(() => this.fetchAll()).catch(() => {});
  }
  openDir() { const id = this.state.taskId; if (typeof id !== 'number') return; fetch('/task/' + id + '/open', { method: 'POST' }).catch(() => {}); }
  downloadZip() { const id = this.state.taskId; if (typeof id !== 'number') return; window.open('/api/download/' + id, '_blank'); }
  fetchHealth(refresh) { fetch('/api/health' + (refresh ? '?refresh=1' : '')).then((r) => r.json()).then((h) => { this.live.health = h || {}; this.scheduleRender(); }).catch(() => {}); }
  goApps() { this.setState({ screen: 'apps', openApp: null }); }
  publishApp() {
    const id = this.state.taskId; if (typeof id !== 'number') return;
    fetch('/api/apps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: id }) })
      .then((r) => r.json()).then((d) => { if (d && d.ok !== false) this.setState({ screen: 'apps', openApp: null }); this.fetchAll(); }).catch(() => {});
  }
  delApp(id) { fetch('/api/apps/' + id, { method: 'DELETE' }).then(() => this.fetchAll()).catch(() => {}); }
  continueTask() { this.setState({ modal: 'continue' }); }
  continueSubmit() {
    const id = this.state.taskId; if (typeof id !== 'number') return;
    const el = document.getElementById('cont-text'); const text = el ? el.value : '';
    if (!text.trim()) return;
    fetch('/task/' + id + '/continue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text.trim() }) })
      .then((r) => r.json()).then((d) => { this.setState({ modal: null }); if (d && d.id) this.go('task', { taskId: d.id }); setTimeout(() => this.fetchAll(), 300); }).catch(() => {});
  }
  fetchFiles(id) { fetch('/api/files/' + id).then((r) => r.json()).then((fs) => { this.live.files = fs || []; this.live.filesFor = id; this.scheduleRender(); }).catch(() => {}); }
  previewOf(id) {
    const p = this.state.previewFile;
    if (!p) return { none: true, hint: '选择左侧文件预览' };
    const url = '/output/' + id + '/' + p.split('/').map(encodeURIComponent).join('/');
    const e = (p.split('.').pop() || '').toLowerCase();
    const src = !!this.state.srcMode;
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].indexOf(e) >= 0) return { img: true, url };
    if (['mp4', 'webm', 'mov', 'ogg', 'm4v'].indexOf(e) >= 0) return { video: true, url };
    const TEXT = ['js', 'css', 'json', 'txt', 'yaml', 'yml', 'xml', 'csv', 'log', 'sh', 'py', 'ts', 'tsx', 'jsx', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'vue', 'svelte', 'ini', 'conf', 'sql'];
    if (['html', 'htm'].indexOf(e) >= 0) {
      if (!src) return { iframe: true, url, canSource: true, toggleLabel: '查看源码' };
      const t = this.getText(id, p); return { code: true, text: t == null ? '加载中…' : t, canSource: true, toggleLabel: '预览' };
    }
    if (e === 'md' || e === 'markdown') {
      const t = this.getText(id, p);
      if (t == null) return { none: true, hint: '加载中…' };
      if (src) return { code: true, text: t, canSource: true, toggleLabel: '渲染' };
      return { mddoc: true, doc: mdDoc(t), canSource: true, toggleLabel: '查看源码' };
    }
    if (TEXT.indexOf(e) >= 0) { const t = this.getText(id, p); return { code: true, text: t == null ? '加载中…' : t }; }
    return { none: true, hint: p + ' — 此类型不预览,点「打开目录」查看' };
  }
  getText(id, p) {
    const key = id + '/' + p;
    this.live.fileText = this.live.fileText || {};
    if (key in this.live.fileText) return this.live.fileText[key];
    this._fetchingText = this._fetchingText || {};
    if (!this._fetchingText[key]) {
      this._fetchingText[key] = 1;
      const url = '/output/' + id + '/' + p.split('/').map(encodeURIComponent).join('/');
      fetch(url).then((r) => r.text()).then((t) => { this.live.fileText[key] = t; this.scheduleRender(); }).catch(() => { this.live.fileText[key] = ''; this.scheduleRender(); });
    }
    return null;
  }
  toggleSrc() { this.setState({ srcMode: !this.state.srcMode }); }
  cancelTask() {
    const id = this.state.taskId;
    if (typeof id !== 'number') return;
    fetch('/task/' + id + '/cancel', { method: 'POST' }).then(() => this.fetchAll()).catch(() => {});
  }
  retryTask() {
    const id = this.state.taskId; if (typeof id !== 'number') return;
    fetch('/task/' + id + '/retry', { method: 'POST' }).then(() => this.fetchAll()).catch(() => {});
  }
  // —— 剧本 ——
  fetchPlaybooks() { fetch('/api/playbooks').then((r) => r.json()).then((p) => { this.live.playbooks = p || []; this.scheduleRender(); }).catch(() => {}); }
  saveAsPlaybook() {
    const id = this.state.taskId; if (typeof id !== 'number') return;
    const name = window.prompt('剧本名称(存下这套步骤,以后一键复用):'); if (!name) return;
    fetch('/api/playbooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: id, name }) })
      .then(() => { this.fetchPlaybooks(); }).catch(() => {});
  }
  // —— 定时任务 ——
  fetchSchedules() { fetch('/api/schedules').then((r) => r.json()).then((s) => { this.live.schedules = s || []; this.scheduleRender(); }).catch(() => {}); }
  toggleSchedule(id) { fetch('/api/schedules/' + id + '/toggle', { method: 'POST' }).then(() => this.fetchSchedules()).catch(() => {}); }
  delSchedule(id) { if (!window.confirm('删除该定时任务?')) return; fetch('/api/schedules/' + id, { method: 'DELETE' }).then(() => this.fetchSchedules()).catch(() => {}); }
  // —— 产出改动(diff) ——
  fetchDiffs(id) { fetch('/api/diff/' + id).then((r) => r.json()).then((d) => { this.live.diffs = d || []; this.live.diffsFor = id; this.scheduleRender(); }).catch(() => {}); }
  openDiff(sha) {
    const id = this.state.taskId;
    fetch('/api/diff/' + id + '/' + sha).then((r) => r.json()).then((d) => { this.live.patch = d.patch || ''; this.setState({ diffSha: sha }); }).catch(() => {});
  }
  continueFromDiff() { // N1:针对改动直接派活
    this.setState({ modal: 'continue' });
    setTimeout(() => { const el = document.getElementById('cont-text'); if (el && !el.value) el.value = '针对最近一次改动(见 git 记录),请修改: '; }, 60);
  }
  // —— 回放 ——
  openReplay() {
    const id = this.state.taskId; if (typeof id !== 'number') return;
    fetch('/api/replay/' + id).then((r) => r.json()).then((d) => { this.live.replay = d; this.setState({ modal: 'replay', repSel: 0 }); }).catch(() => {});
  }
  // —— Webhook ——
  fetchHook() { fetch('/api/me/hook').then((r) => r.json()).then((d) => { this.live.hookUrl = d.url; this.scheduleRender(); }).catch(() => {}); }
  resetHook() { fetch('/api/me/hook/reset', { method: 'POST' }).then((r) => r.json()).then((d) => { this.live.hookUrl = d.url; this.scheduleRender(); }).catch(() => {}); }
  notifyTask(m) { // 桌面通知:任务结束/需要人
    if (m.type !== 'task') return;
    const MAP = { done: '✅ 任务完成', failed: '❌ 任务失败', awaiting_input: '⚠ 任务等你决策', awaiting: '⏸ 任务待审批' };
    const title = MAP[m.data]; if (!title) return;
    try {
      if (window.Notification && Notification.permission === 'granted' && document.hidden) {
        const t = (this.TASKS || []).find((x) => x.id === m.taskId);
        new Notification(title, { body: (t ? t.title : '任务 ' + m.taskId), tag: 'orch-task-' + m.taskId });
      }
    } catch (e) {}
  }
  fetchRawPlan(id) { // 审批编辑用:拉任务原始 plan JSON
    fetch('/task/' + id).then((r) => r.json()).then((t) => {
      let p = null; try { p = JSON.parse(t.plan); } catch (e) {}
      this.live.rawPlan = p; this.live.rawPlanFor = id; this.state.epCut = {};
      this.scheduleRender();
    }).catch(() => {});
  }
  approveTask() {
    const id = this.state.taskId;
    if (typeof id !== 'number') return;
    // 合并编辑:textarea 改写 prompt,epCut 删步(并清理指向被删步的依赖)
    let body = {};
    const p = this.live.rawPlanFor === id && this.live.rawPlan;
    if (p && p.steps) {
      const cut = this.state.epCut || {};
      const edits = {};
      document.querySelectorAll('.ep-prompt').forEach((el) => { edits[el.getAttribute('data-sid')] = el.value; });
      const steps = p.steps.filter((s) => !cut[s.id]).map((s) => {
        const o = { ...s };
        if (!o.body && edits[o.id] != null && edits[o.id].trim()) o.prompt = edits[o.id];
        return o;
      });
      const ids = new Set(steps.map((s) => s.id));
      steps.forEach((s) => { if (s.deps) s.deps = s.deps.filter((d) => ids.has(d)); });
      body = { plan: { task: p.task, steps } };
    }
    fetch('/task/' + id + '/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(() => this.fetchAll()).catch(() => {});
  }

  // —— 登录/账号 ——
  submitLogin() {
    const name = (document.getElementById('lg-name') || {}).value || '';
    const pw = (document.getElementById('lg-pw') || {}).value || '';
    if (!name.trim()) return;
    fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim(), password: pw }) })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j }))).then(({ ok, j }) => {
        if (!ok) { this.setState({ loginErr: (j && j.error) || '登录失败' }); return; }
        this.state.needLogin = false; this.state.loginErr = ''; this.fetchAll();
        try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}
      }).catch(() => this.setState({ loginErr: '网络错误' }));
  }
  logout() { fetch('/logout', { method: 'POST' }).then(() => { this.state.me = null; this.setState({ modal: null, needLogin: true, screen: 'dash' }); }).catch(() => {}); }
  openAccount() { this.setState({ modal: 'account' }); }
  changePw() {
    const pw = (document.getElementById('ac-pw') || {}).value || '';
    if (!pw.trim()) return;
    fetch('/api/me/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw.trim() }) })
      .then(() => this.setState({ modal: null })).catch(() => {});
  }
  // —— 部门管理 ——
  newDept() { this.setState({ modal: 'dept' }); }
  submitDept() {
    const name = (document.getElementById('nd-name') || {}).value || '';
    if (!name.trim()) return;
    const glyph = (document.getElementById('nd-glyph') || {}).value || '·';
    const ids = [...document.querySelectorAll('.nd-agent:checked')].map((c) => c.value);
    fetch('/api/depts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim(), glyph }) })
      .then((r) => r.json()).then((d) => { if (ids.length && d.id) return fetch('/api/depts/' + d.id + '/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentIds: ids }) }); })
      .then(() => { this.setState({ modal: null }); this.fetchAll(); }).catch(() => {});
  }
  delDept(id) { if (!window.confirm('删除该部门?(旗下 agent 会变无部门)')) return; fetch('/api/depts/' + id, { method: 'DELETE' }).then(() => this.fetchAll()).catch(() => {}); }
  assignDept(id) { this.setState({ modal: 'deptAssign', deptId: id }); }
  submitDeptAssign() {
    const id = this.state.deptId; const ids = [...document.querySelectorAll('.da-agent:checked')].map((c) => c.value);
    fetch('/api/depts/' + id + '/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentIds: ids }) })
      .then(() => { this.setState({ modal: null, deptId: null }); this.fetchAll(); }).catch(() => {});
  }
  // —— 项目授权 ——
  grantProj(project, userId, on) { fetch('/api/grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, userId, on }) }).then(() => this.fetchAll()).catch(() => {}); }
  // —— 部门员工 ——
  submitHire() {
    const g = (id) => (document.getElementById(id) || {}).value || '';
    if (!g('he-name').trim()) return;
    fetch('/api/roles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dept: this.state.deptId, name: g('he-name').trim(), description: g('he-desc'), prompt: g('he-prompt'), executor: g('he-exec') || 'claude' }) })
      .then(() => { this.setState({ modal: null }); this.fetchAll(); }).catch(() => {});
  }
  fireEmp(id, name) { if (!window.confirm('移除员工「' + name + '」?')) return; fetch('/api/roles/' + id, { method: 'DELETE' }).then(() => this.fetchAll()).catch(() => {}); }
  // —— 部门任务 + 流程编辑 + 执行器池 ——
  newDeptTask() { this.setState({ modal: 'task', taskDept: this.state.deptId }); }
  saveFlow(deptId, flow) {
    fetch('/api/depts/' + deptId + '/flow', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flow }) })
      .then(() => this.fetchAll()).catch(() => {});
  }
  moveFlow(i, dir) {
    const d = (this.DEPTS || []).find((x) => x.id === this.state.deptId); if (!d) return;
    const f = (d.flow || []).slice(); const j = i + dir;
    if (j < 0 || j >= f.length) return;
    const t = f[i]; f[i] = f[j]; f[j] = t;
    this.saveFlow(d.id, f);
  }
  toggleFlowFlag(i, key) {
    const d = (this.DEPTS || []).find((x) => x.id === this.state.deptId); if (!d) return;
    const f = (d.flow || []).slice(); f[i] = { ...f[i], [key]: !f[i][key] };
    this.saveFlow(d.id, f);
  }
  delFlowStep(i) {
    const d = (this.DEPTS || []).find((x) => x.id === this.state.deptId); if (!d) return;
    const f = (d.flow || []).slice(); f.splice(i, 1);
    this.saveFlow(d.id, f);
  }
  addFlowStep() {
    const d = (this.DEPTS || []).find((x) => x.id === this.state.deptId); if (!d) return;
    const sel = document.getElementById('flow-add'); const role = sel && sel.value;
    if (!role) return;
    this.saveFlow(d.id, (d.flow || []).concat([{ role, optional: false, gate: false }]));
  }
  toggleDeptExec(id) {
    const d = (this.DEPTS || []).find((x) => x.id === this.state.deptId); if (!d) return;
    const cur = new Set(d.executors || []);
    cur.has(id) ? cur.delete(id) : cur.add(id);
    fetch('/api/depts/' + d.id + '/executors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentIds: [...cur] }) })
      .then(() => this.fetchAll()).catch(() => {});
  }

  todayStr() {
    const d = new Date();
    const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return wk + ' ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }
  realMetrics() {
    const c = this.live.counts || {};
    return [
      { k: '运行中 Agent', v: '' + (c.runningAgents || 0), s: '共 ' + (c.totalAgents || 0) + ' 个', dot: this.acc() },
      { k: '进行中任务', v: '' + (c.runningTasks || 0), s: '真实任务 ' + (c.totalTasks || 0) + ' 个', dot: '#4F8BE8' },
      { k: '今日已完成', v: '' + (c.doneToday || 0), s: '今日成本 $' + ((c.costToday) || 0).toFixed(3), dot: '#2E9E5B' },
      { k: '失败 / 待处理', v: '' + (c.failed || 0), s: (c.failed || 0) + ' 个失败', dot: '#E0922E' },
    ];
  }
  // #2 画布:把当前活动任务的真实 plan 排成节点图(层级=依赖深度)
  realGraph() {
    const P = this.PLAN || [];
    if (!P.length) return { nodes: [], edges: [], empty: true };
    const byId = {}; P.forEach((p) => { byId[p.title] = p; });
    const depth = {}; const lv = (id, seen) => {
      if (depth[id] != null) return depth[id];
      const p = byId[id]; if (!p || !p.deps || !p.deps.length) return (depth[id] = 0);
      if (seen && seen.has(id)) return 0; const s = seen || new Set(); s.add(id);
      const d = 1 + Math.max(...p.deps.map((x) => lv(x, s))); return (depth[id] = d);
    };
    P.forEach((p) => lv(p.title));
    const cols = {}; P.forEach((p) => { const d = depth[p.title] || 0; (cols[d] = cols[d] || []).push(p.title); });
    const pos = {}; const W = 200, H = 66, GX = 260, GY = 118;
    Object.keys(cols).forEach((d) => { cols[d].forEach((id, i) => { pos[id] = { x: 40 + (Number(d) + 1) * GX, y: 30 + i * GY }; }); }); // +1 列给起点腾位
    const col = { queued: '#C9C5BB', working: '#F0B400', done: '#2E9E5B', failed: '#DC5B52' };
    const SKTXT = { queued: '排队', working: '进行中', done: '完成 ✓', failed: '失败' };
    const nodes = P.map((p) => ({ title: p.title, agent: p.agent, avatar: p.avatar, aColor: p.color, x: pos[p.title].x, y: pos[p.title].y, dot: col[p.sk] || '#C9C5BB', sk: p.sk, nbg: '#fff', nfg: '#1A1814', seq: p.n, skTxt: SKTXT[p.sk] || p.sk, skBg: (col[p.sk] || '#C9C5BB') + '22', skC: p.sk === 'queued' ? '#6B6760' : (col[p.sk] || '#6B6760'), pulse: p.sk === 'working' }));
    const edges = []; let ei = 0;
    P.forEach((p) => (p.deps || []).forEach((dp) => {
      if (!pos[dp] || !pos[p.title]) return;
      const x1 = pos[dp].x + W, y1 = pos[dp].y + H / 2, x2 = pos[p.title].x, y2 = pos[p.title].y + H / 2;
      const mx = (x1 + x2) / 2;
      const sk = byId[p.title].sk;
      const c = sk === 'done' ? '#2E9E5B' : (sk === 'working' ? '#F0B400' : '#CFCBC1');
      edges.push({ d: `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, color: c, flow: sk !== 'done', dash: sk === 'working', dur: (1.8 + (ei++ % 4) * 0.4).toFixed(2) + 's' });
    }));
    const maxCol = Math.max(...Object.keys(cols).map(Number)) + 2; // +起点列
    const maxRow = Math.max(...Object.values(cols).map((a) => a.length));
    // 起点「开始」:连到所有无依赖步骤 → 明确的开始与流转
    const roots = P.filter((p) => !p.deps || !p.deps.length).map((p) => p.title);
    const oy = roots.length ? roots.reduce((a, id) => a + pos[id].y, 0) / roots.length : 30;
    const anyRun = P.some((p) => p.sk === 'working');
    nodes.unshift({ origin: true, title: '▶ 开始 · 任务下发', agent: this.activeTitle || '编排目标', avatar: '◆', aColor: '#F0B400', x: 40, y: oy, dot: '#F0B400', sk: 'origin', nbg: '#1A1814', nfg: '#fff', seq: '', skTxt: '', skBg: 'transparent', skC: '#C9C5BB' });
    roots.forEach((id) => { const x1 = 40 + W, y1 = oy + H / 2, x2 = pos[id].x, y2 = pos[id].y + H / 2; const mx = (x1 + x2) / 2; const sk = byId[id].sk; edges.unshift({ d: `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, color: sk === 'done' ? '#2E9E5B' : '#F0B400', flow: sk !== 'done', dash: sk === 'working', dur: '2.2s' }); });
    // 终点「完成 · 交付」:所有无下游的步骤汇入;全部完成 → 绿
    const hasDown = new Set(); P.forEach((p) => (p.deps || []).forEach((d) => hasDown.add(d)));
    const leaves = P.filter((p) => !hasDown.has(p.title)).map((p) => p.title);
    const allDone = P.length > 0 && P.every((p) => p.sk === 'done');
    const ex = 40 + (Math.max(...Object.keys(cols).map(Number)) + 2) * GX;
    const eyv = leaves.length ? leaves.reduce((a, id) => a + pos[id].y, 0) / leaves.length : 30;
    nodes.push({ origin: true, title: allDone ? '✓ 完成 · 已交付' : '⏳ 完成 · 交付', agent: allDone ? '全部步骤已完成' : '等待全部步骤完成', avatar: allDone ? '✓' : '⏳', aColor: allDone ? '#2E9E5B' : '#8A857C', x: ex, y: eyv, dot: allDone ? '#2E9E5B' : '#C9C5BB', sk: 'end', nbg: allDone ? '#1F7A46' : '#F0EEE9', nfg: allDone ? '#fff' : '#6B6760', seq: '', skTxt: '', skBg: 'transparent', skC: '#C9C5BB' });
    leaves.forEach((id) => { const x1 = pos[id].x + W, y1 = pos[id].y + H / 2, x2 = ex, y2 = eyv + H / 2; const mx = (x1 + x2) / 2; const sk = byId[id].sk; edges.push({ d: `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, color: sk === 'done' ? '#2E9E5B' : '#CFCBC1', flow: sk === 'working' || anyRun && sk !== 'done', dash: sk === 'working', dur: '2.6s' }); });
    edges.forEach((e) => { e.pstyle = e.dash ? 'stroke-dasharray:6 6;animation:dash 1s linear infinite;' : ''; });
    nodes.forEach((n) => { n.subc = n.origin ? (n.nfg === '#fff' ? '#C9C5BB' : '#8A857C') : '#8A857C'; n.still = !n.pulse; });
    return { nodes, edges, empty: false, w: Math.max(1000, 80 + (maxCol + 1) * GX), h: Math.max(400, 30 + maxRow * GY) };
  }
  realCv() {
    const find = (id) => this.AGENTS.find((a) => a.id === id);
    return { dev: this.decA(find('claude')), qa: this.decA(find('codex')), content: this.decA(null), design: this.decA(null), video: this.decA(null) };
  }

  go(screen, extra) {
    super.go(screen, extra);
    if (screen === 'task' && extra && typeof extra.taskId === 'number') { this.fetchRelay(extra.taskId); this.state.previewFile = null; this.state.diffSha = null; this.live.patch = ''; this.live.msgsFor = null; this.fetchFiles(extra.taskId); this.fetchDiffs(extra.taskId); this.fetchMsgs(extra.taskId); }
    if (screen === 'agent' && extra && extra.agentId) {
      fetch('/api/agentlog/' + extra.agentId).then((r) => r.json()).then((lines) => {
        const c = this.state.console || (this.state.console = {});
        c[extra.agentId] = lines || [];
        this.scheduleRender();
      }).catch(() => {});
    }
  }

  // 内置执行器的大模型+思考级别选项(仅对已存在的 claude/codex 显示)
  modelPickers() {
    const EFF = [{ v: '', n: '思考:默认' }, { v: 'low', n: '低' }, { v: 'medium', n: '中' }, { v: 'high', n: '高' }, { v: 'xhigh', n: '超高' }];
    const CAT = {
      claude: { label: 'Claude', selId: 'nt-model-claude', effId: 'nt-effort-claude', opts: [{ v: '', n: '默认' }, { v: 'claude-fable-5', n: 'Fable 5' }, { v: 'claude-opus-4-8', n: 'Opus 4.8' }], effOpts: EFF.concat([{ v: 'max', n: '极限' }]) },
      codex: { label: 'Codex', selId: 'nt-model-codex', effId: 'nt-effort-codex', opts: [{ v: '', n: '默认' }, { v: 'gpt-5.5', n: 'GPT-5.5' }, { v: 'gpt-5.4', n: 'GPT-5.4' }], effOpts: EFF },
    };
    const have = new Set((this.AGENTS || []).map((a) => a.id));
    return Object.keys(CAT).filter((id) => have.has(id)).map((id) => ({ agent: id, ...CAT[id] }));
  }
  // 快捷下发:一行描述→全默认智能拆分建任务(免弹窗)
  quickLaunch() {
    const el = document.getElementById('ql-input'); const text = el ? el.value.trim() : '';
    if (!text) return;
    el.value = '';
    fetch('/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, refine: true }) })
      .then((r) => r.json()).then(() => { this.setState({ screen: 'tasks' }); setTimeout(() => this.fetchAll(), 300); }).catch(() => {});
  }
  // —— 弹窗 ——
  newTask() { this.setState({ modal: 'task', taskDept: null }); }
  newAgent() { this.setState({ modal: 'agent', editAgent: null }); }
  editCurAgent() { const a = this.AGENTS.find((x) => x.id === this.state.agentId); if (a) this.setState({ modal: 'agent', editAgent: a }); }
  delCurAgent() { const id = this.state.agentId; if (!id || !window.confirm('删除该 Agent?')) return; fetch('/api/agents/' + id, { method: 'DELETE' }).then(() => { this.setState({ screen: 'agents' }); this.fetchAll(); }).catch(() => {}); }
  newProject() { this.setState({ modal: 'project' }); }
  submitProject() {
    const name = (document.getElementById('pr-name') || {}).value || '';
    if (!name.trim()) return;
    const client = (document.getElementById('pr-client') || {}).value || '';
    const members = [...document.querySelectorAll('.pr-member:checked')].map((c) => c.value);
    fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim(), client, members }) })
      .then((r) => r.json()).then(() => { this.setState({ modal: null }); this.fetchAll(); }).catch(() => {});
  }
  pickWho() { this.setState({ modal: 'who' }); }
  currentName() { const c = (this.PEOPLE || []).find((p) => p.id === this.state.currentPersonId); return c ? c.name : ((this.PEOPLE[0] && this.PEOPLE[0].name) || '操作者'); }
  onSearchKey(e) { if (e.key === 'Enter') { const q = (e.currentTarget.value || '').trim(); if (q) this.go('search', { q }); } }
  searchResults(q) {
    const lc = q.toLowerCase();
    const hit = (s) => String(s || '').toLowerCase().includes(lc);
    const groups = [];
    const tasks = this.TASKS.filter((t) => hit(t.title) || hit(t.proj)).map((t) => ({ title: t.title, sub: t.proj, open: () => this.go('task', { taskId: t.id }) }));
    const agents = this.AGENTS.filter((a) => hit(a.name) || hit(a.id)).map((a) => ({ title: a.name, sub: a.model || '', open: () => this.go('agent', { agentId: a.id }) }));
    const projects = this.PROJECTS.filter((p) => hit(p.name) || hit(p.client)).map((p) => ({ title: p.name, sub: p.client || '', open: () => this.go('project', { projectId: p.id }) }));
    const people = this.PEOPLE.filter((p) => hit(p.name) || hit(p.role)).map((p) => ({ title: p.name, sub: p.role || '', open: () => this.go('people') }));
    if (tasks.length) groups.push({ label: '任务', items: tasks });
    if (agents.length) groups.push({ label: 'Agent', items: agents });
    if (projects.length) groups.push({ label: '项目', items: projects });
    if (people.length) groups.push({ label: '人员', items: people });
    return groups;
  }
  newPerson() { this.setState({ modal: 'person', assignPid: null }); }
  assignPerson(pid) { this.setState({ modal: 'person', assignPid: pid }); }
  closeModal() { this.setState({ modal: null, assignPid: null, taskDept: null }); }

  submitTask() {
    const text = (document.getElementById('nt-text') || {}).value || '';
    if (!text.trim()) return;
    const sel = (document.getElementById('nt-proj-sel') || {}).value || '';
    const nw = (document.getElementById('nt-proj-new') || {}).value || '';
    const project = (nw.trim() || sel || '默认项目');
    const modeEl = document.querySelector('input[name="nt-mode"]:checked');
    const mode = modeEl ? modeEl.value : 'llm';
    const user = this.currentName();
    const approve = (document.getElementById('nt-approve') || {}).checked ? 1 : 0;
    const ask = (document.getElementById('nt-ask') || {}).checked ? 1 : 0;
    const isolate = (document.getElementById('nt-isolate') || {}).value || 'none';
    const agents = [...document.querySelectorAll('.nt-agent:checked')].map((c) => c.value);
    const orchestration = (document.getElementById('nt-orch') || {}).value || '';
    const refine = (document.getElementById('nt-refine') || {}).checked ? 1 : 0;
    const dept = this.state.taskDept || null; // 部门任务:按该部门流程拆分
    const models = {}; // 用户为 claude/codex 选的大模型+思考级别
    (this.modelPickers() || []).forEach((mp) => {
      const m = (document.getElementById(mp.selId) || {}).value || '';
      const e = (document.getElementById(mp.effId) || {}).value || '';
      if (m || e) models[mp.agent] = { model: m || null, effort: e || null };
    });
    const playbook = (document.getElementById('nt-playbook') || {}).value || null; // 用剧本:骨架复用不走LLM规划
    // 定时重复:建 schedule 而非立即任务
    const skind = (document.getElementById('nt-sched-kind') || {}).value || '';
    if (skind) {
      const sval = ((document.getElementById('nt-sched-val') || {}).value || '').trim();
      const sdow = Number((document.getElementById('nt-sched-dow') || {}).value || 1);
      const spec = skind === 'hours' ? { kind: 'hours', n: Number(sval) || 24 } : skind === 'weekly' ? { kind: 'weekly', dow: sdow, at: sval || '09:00' } : { kind: 'daily', at: sval || '09:00' };
      fetch('/api/schedules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text.trim(), project, dept, agents, models, playbook, spec }) })
        .then(() => { this.setState({ modal: null, taskDept: null, screen: 'tasks' }); this.fetchSchedules(); }).catch(() => {});
      return;
    }
    fetch('/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text.trim(), project, mode, user, approve, ask, isolate, agents, orchestration, refine, dept, models, playbook }) })
      .then((r) => r.json()).then(() => { this.setState({ modal: null, taskDept: null, screen: 'tasks' }); setTimeout(() => this.fetchAll(), 300); }).catch(() => {});
  }
  submitAgent() {
    const g = (id) => (document.getElementById(id) || {}).value || '';
    const name = g('na-name'), command = g('na-cmd'), kind = g('na-kind') || 'cli';
    if (!name.trim()) return;
    if (kind === 'cli' && !command.trim()) return; // CLI 类必须有命令
    const body = { name: name.trim(), command: command.trim(), kind, args: g('na-args').split(/\s+/).filter(Boolean), model: g('na-model'), caps: g('na-caps').split(/[,，]/).map((s) => s.trim()).filter(Boolean), image: g('na-image'), dept: g('na-dept') };
    const ea = this.state.editAgent;
    if (ea) { body.color = ea.color; body.avatar = ea.avatar; }
    fetch(ea ? '/api/agents/' + ea.id : '/api/agents', { method: ea ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json()).then(() => { this.setState({ modal: null, editAgent: null }); this.fetchAll(); }).catch(() => {});
  }
  submitPerson() {
    const ids = [...document.querySelectorAll('.np-agent:checked')].map((c) => c.value);
    if (this.state.assignPid) { // 分配模式:只改分配
      const pid = this.state.assignPid;
      fetch('/api/people/' + pid + '/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentIds: ids }) })
        .then(() => { this.setState({ modal: null, assignPid: null }); this.fetchAll(); }).catch(() => {});
      return;
    }
    const g = (id) => (document.getElementById(id) || {}).value || '';
    if (!g('np-name').trim()) return;
    fetch('/api/people', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: g('np-name').trim(), email: g('np-email'), role: g('np-role') }) })
      .then((r) => r.json()).then((d) => { if (ids.length && d.id) return fetch('/api/people/' + d.id + '/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentIds: ids }) }); })
      .then(() => { this.setState({ modal: null }); this.fetchAll(); }).catch(() => {});
  }

  fetchAll() {
    fetch('/api/all').then((r) => { if (r.status === 401) { if (!this.state.needLogin) { this.state.needLogin = true; this.scheduleRender(); } return null; } return r.json(); }).then((d) => {
      if (!d) return;
      if (this.state.needLogin) this.state.needLogin = false;
      this.state.me = d.me || null;
      this.AGENTS = d.agents || []; this.DEPTS = d.depts || []; this.BOARDS = d.boards || {};
      this.PROJECTS = d.projects || []; this.TASKS = d.tasks || []; this.PEOPLE = d.people || [];
      this.live.counts = d.counts || {};
      this.live.usage = d.usage || {};
      this.live.apps = d.apps || [];
      this.state.activity = d.activity || [];
      const active = this.TASKS[0] && this.TASKS[0].id;
      if (active != null) { this.live.activeId = active; if (!this.live.plan[active]) this.fetchPlan(active); }
      if (typeof this.state.taskId === 'number' && !this.live.relay[this.state.taskId]) this.fetchRelay(this.state.taskId);
      this.scheduleRender();
    }).catch(() => {});
  }
  fetchRelay(id) { fetch('/api/relay/' + id).then((r) => r.json()).then((s) => { this.live.relay[id] = s || []; this.scheduleRender(); }).catch(() => {}); }
  fetchPlan(id) { fetch('/api/plan/' + id).then((r) => r.json()).then((s) => { this.live.plan[id] = s || []; this.scheduleRender(); }).catch(() => {}); }
  fetchAgentLog(id) { fetch('/api/agentlog/' + id).then((r) => r.json()).then((lines) => { this.state.log[id] = lines || []; this.scheduleRender(); }).catch(() => {}); }

  openWS() {
    try {
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'activity') {
          this.state.activity = [m.data].concat(this.state.activity).slice(0, 18);
          this.scheduleRender();
        } else if (m.type === 'log') {
          if (m.agent) { // 累积到每 agent 实时控制台,标注来源 task/step
            const c = this.state.console || (this.state.console = {});
            (c[m.agent] = c[m.agent] || []).push('[T' + m.taskId + '·' + (m.stepId || '') + '] ' + m.data);
            c[m.agent] = c[m.agent].slice(-200);
            this.scheduleRender();
          }
          if (m.taskId === this.state.taskId) { // 当前任务详情:实时输出流
            const tc = this.live.taskConsole || (this.live.taskConsole = {});
            (tc[m.taskId] = tc[m.taskId] || []).push('[' + (m.stepId || '') + '] ' + m.data);
            tc[m.taskId] = tc[m.taskId].slice(-80);
            this.scheduleRender();
          }
        } else if (m.type === 'msg') {
          if (m.taskId === this.state.taskId) this.fetchMsgs(m.taskId);
        } else if (m.type === 'plan' || m.type === 'status' || m.type === 'task' || m.type === 'agents' || m.type === 'apps') {
          this.notifyTask(m); // 桌面通知:任务完成/失败/待输入
          this.fetchAll();
          if (typeof this.state.taskId === 'number') { this.fetchRelay(this.state.taskId); if (m.type === 'task') this.fetchFiles(this.state.taskId); }
          if (this.live.activeId != null) this.fetchPlan(this.live.activeId);
        }
      };
      ws.onclose = () => { setTimeout(() => this.openWS(), 2000); };
    } catch (e) {}
  }
}

const _tpl = document.getElementById('tpl');
const _root = document.getElementById('root');
const _app = new Maestro({ accent: '#FFC400', paused: false, tickMs: 1200 });
_app.mount(_root, _tpl);
