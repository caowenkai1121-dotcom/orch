// 定时到点判断:daily HH:MM / weekly dow+HH:MM / every N 小时。
// 截止式(已到点且本槽未跑过)而非"精确分钟相等"——进程重启/tick 漂移越过目标分钟也能补跑一次自愈。
function scheduleDue(s, now) {
  let spec = {}; try { spec = JSON.parse(s.spec || '{}'); } catch (e) { return false; }
  const last = s.last_run ? new Date(s.last_run) : null;
  if (spec.kind === 'hours') return !last || (now - last) >= (Number(spec.n) || 1) * 3600e3;
  const parts = String(spec.at || '00:00').split(':');
  const h = Number(parts[0]) || 0, m = Number(parts[1]) || 0;
  if (spec.kind === 'daily') {
    const target = new Date(now); target.setHours(h, m, 0, 0);         // 今日槽时刻
    return now >= target && (!last || last < target);                  // 已到点且本槽未跑过
  }
  if (spec.kind === 'weekly') {
    if (now.getDay() !== Number(spec.dow)) return false;
    const target = new Date(now); target.setHours(h, m, 0, 0);         // 本周对应 dow 的槽时刻
    return now >= target && (!last || last < target);
  }
  return false;
}
module.exports = { scheduleDue };
