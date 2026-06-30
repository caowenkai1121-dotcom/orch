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


// ============ 真后端接线:在原型 MaestroBase 上叠加 orch 真实数据 ============
class Maestro extends MaestroBase {
  componentDidMount() {
    this.live = { tasks: [], detail: {}, logs: {}, activity: [] };
    super.componentDidMount();
    this.fetchTasks();
    this.openWS();
  }

  scheduleRender() {
    if (this._pending) return;
    this._pending = true;
    setTimeout(() => { this._pending = false; this.setState({}); }, 250);
  }

  mapStatusKey(s) {
    return ({ pending: 'queued', planning: 'queued', running: 'working', done: 'done', failed: 'failed' })[s] || 'queued';
  }
  realMini(agent) {
    return ({ claude: { color: '#7C6FD9', avatar: 'C' }, codex: { color: '#4F8BE8', avatar: 'X' } })[agent]
      || { color: '#A39E94', avatar: 'A' };
  }
  agentName(a) { return a === 'claude' ? 'Claude' : (a === 'codex' ? 'Codex' : (a || '—')); }

  realRow(t) {
    const sm = this.statusMeta(this.mapStatusKey(t.status));
    const det = this.live.detail[t.id];
    const seen = {}, assignees = [];
    if (det && det.steps) det.steps.forEach((s) => { if (s.agent && !seen[s.agent]) { seen[s.agent] = 1; assignees.push(this.realMini(s.agent)); } });
    return {
      id: '#' + t.id, title: t.text, proj: 'orch · 真实', updated: '实时',
      sLabel: sm.label, sC: sm.c, sBg: sm.bg, sDot: sm.dot, assignees,
      open: () => this.go('task', { taskId: t.id }),
    };
  }

  realTaskVals(id) {
    const t = this.live.tasks.find((x) => x.id === id);
    const det = this.live.detail[id];
    const logs = this.live.logs[id] || [];
    const sm = this.statusMeta(this.mapStatusKey(t ? t.status : 'pending'));
    const steps = ((det && det.steps) || []).map((s) => {
      const m = this.statusMeta(this.mapStatusKey(s.status));
      const mini = this.realMini(s.agent);
      let last = null;
      for (let i = logs.length - 1; i >= 0; i--) if (logs[i].stepId === s.step_id) { last = logs[i].line; break; }
      return {
        who: this.agentName(s.agent), avatar: mini.avatar, color: mini.color,
        title: s.step_id, desc: last ? String(last) : ('状态: ' + s.status), time: '', dur: '',
        sLabel: m.label, sC: m.c, sBg: m.bg, sDot: m.dot,
        back: false, hasCode: false, hasReport: false, barPct: '0%', barColor: '#2E9E5B',
      };
    });
    return { id: '#' + id, title: t ? t.text : ('任务 ' + id), proj: 'orch · 真实', sLabel: sm.label, sC: sm.c, sBg: sm.bg, sDot: sm.dot, steps };
  }

  renderVals() {
    const v = super.renderVals();
    // 任务列表:真实任务排在最前
    const realRows = this.live.tasks.map((t) => this.realRow(t));
    v.tasksList = realRows.concat(v.tasksList);
    // 总控台指标:进行中任务用真实数
    const running = this.live.tasks.filter((t) => t.status === 'running').length;
    if (v.metrics[1]) v.metrics[1] = { ...v.metrics[1], v: '' + running, s: '真实任务 ' + this.live.tasks.length + ' 个' };
    // 实时活动:真实日志流并入
    v.activity = this.live.activity.concat(v.activity).slice(0, 18);
    // 真实任务详情(taskId 为数字)
    if (typeof this.state.taskId === 'number') {
      v.task = this.realTaskVals(this.state.taskId);
      v.crumbLeaf = v.task.title;
    }
    // 新建任务 → 真下发
    v.newTask = () => this.promptNewTask();
    return v;
  }

  go(screen, extra) {
    super.go(screen, extra);
    if (screen === 'task' && extra && typeof extra.taskId === 'number') this.fetchDetail(extra.taskId);
  }

  promptNewTask() {
    const text = window.prompt('给编排器下发任务(走 claude 开发 → codex 验证 模板):');
    if (!text || !text.trim()) return;
    fetch('/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text.trim() }) })
      .then((r) => r.json()).then(() => { this.go('tasks'); setTimeout(() => this.fetchTasks(), 300); })
      .catch(() => {});
  }

  fetchTasks() {
    fetch('/tasks').then((r) => r.json()).then((list) => {
      this.live.tasks = list || [];
      this.live.tasks.forEach((t) => { if (!this.live.detail[t.id]) this.fetchDetail(t.id); });
      this.scheduleRender();
    }).catch(() => {});
  }
  fetchDetail(id) {
    fetch('/task/' + id).then((r) => r.json()).then((d) => { if (d) this.live.detail[id] = d; this.scheduleRender(); }).catch(() => {});
    fetch('/task/' + id + '/logs').then((r) => r.json()).then((rows) => {
      if (rows) this.live.logs[id] = rows.map((r) => ({ stepId: r.step_id, line: r.line }));
      this.scheduleRender();
    }).catch(() => {});
  }

  openWS() {
    try {
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'log') {
          const id = m.taskId;
          (this.live.logs[id] = this.live.logs[id] || []).push({ stepId: m.stepId, line: m.data });
          this.live.activity.unshift({ a: '#' + id + ' ' + (m.stepId || ''), c: '#1A1814', t: String(m.data).slice(0, 80), dot: this.acc(), soft: '#FFF6D6', time: '刚刚' });
          this.live.activity = this.live.activity.slice(0, 18);
          this.scheduleRender();
        } else if (m.type === 'plan' || m.type === 'task' || m.type === 'status') {
          this.fetchTasks();
          if (typeof this.state.taskId === 'number') this.fetchDetail(this.state.taskId);
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
