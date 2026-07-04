// 步骤超时保护:卡死的 agent 子进程到时按 PID 定向杀树(绝不按镜像名,防误杀别的 claude 会话)
const { execSync } = require('child_process');

function killTree(c) {
  try {
    if (!c || !c.pid || c.exitCode !== null || c.killed) return; // 已退出/已杀:跳过,防 PID 回收误伤
    if (process.platform === 'win32') execSync('taskkill /T /F /PID ' + c.pid);
    // POSIX:spawn 用 shell:true → c.pid 是 shell,真 agent 是其子进程。c.kill 只杀 shell 会漏杀 agent(孤儿+继续烧token)。
    // 先按 PID 定向杀该 shell 的子进程(真 agent),再杀 shell。仍是按 PID 不按镜像名(pkill -P 只匹配 PPID=c.pid 的进程)。
    else { try { execSync('pkill -9 -P ' + c.pid); } catch (e) {} c.kill('SIGKILL'); }
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

module.exports = { arm, killTree };
