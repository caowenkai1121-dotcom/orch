// 步骤超时保护:卡死的 agent 子进程到时按 PID 定向杀树(绝不按镜像名,防误杀别的 claude 会话)
const { execSync } = require('child_process');

function posixDescendantPids(rootPid, psOutput) {
  const root = Number(rootPid);
  if (!Number.isInteger(root) || root <= 0) return [];
  const children = new Map();
  String(psOutput || '').split(/\r?\n/).forEach((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) return;
    const pid = Number(m[1]), ppid = Number(m[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0 || ppid <= 0 || pid === root) return;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  });
  const out = [];
  const seen = new Set([root]);
  const walk = (pid) => {
    for (const child of children.get(pid) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      walk(child);
      out.push(child);
    }
  };
  walk(root);
  return out;
}

function killPid(pid) {
  try {
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
  } catch (e) {}
}

function killTree(c) {
  try {
    if (!c || !c.pid || c.exitCode !== null || c.killed) return; // 已退出/已杀:跳过,防 PID 回收误伤
    if (process.platform === 'win32') execSync('taskkill /T /F /PID ' + c.pid);
    // POSIX:spawn 用 shell:true → c.pid 是 shell,真 agent 是其子进程。c.kill 只杀 shell 会漏杀 agent(孤儿+继续烧token)。
    // 递归按 PID 杀完整子孙进程树,再杀 shell。仍是按 PID 不按镜像名,避免误杀其它会话。
    else {
      let descendants = [];
      try { descendants = posixDescendantPids(c.pid, execSync('ps -eo pid=,ppid=', { encoding: 'utf8' })); } catch (e) {}
      if (!descendants.length) { try { execSync('pkill -9 -P ' + c.pid); } catch (e) {} }
      descendants.forEach(killPid);
      c.kill('SIGKILL');
    }
  } catch (e) {}
}

// 给子进程装超时;返回 { clear, timedOut }。ORCH_STEP_TIMEOUT_MS=0 关闭,默认 20 分钟
function arm(child) {
  const ms = process.env.ORCH_STEP_TIMEOUT_MS != null ? Number(process.env.ORCH_STEP_TIMEOUT_MS) : 1200000;
  if (!ms || ms < 0) return { clear() {}, timedOut: () => false };
  let to = false;
  const t = setTimeout(() => { to = true; killTree(child); }, ms);
  return { clear() { clearTimeout(t); }, timedOut: () => to };
}

module.exports = { arm, killTree, posixDescendantPids };
