// prompt 作为 arg 传给 spawn(shell:true)。POSIX 下双引号内 $()/`` 会被 sh 命令替换执行——
// prompt 含上游不可信 handoff,只读档(--sandbox read-only / --disallowedTools)下会在宿主 sh、
// agent 沙箱之外执行,绕过只读边界。POSIX 用单引号包裹(内部全字面,连 $ 反引号都不解释);
// Windows cmd.exe 无命令替换语法,保持原 JSON.stringify(与既有行为字节一致)。
function shArg(s, plat) {
  s = String(s == null ? '' : s);
  return (plat || process.platform) === 'win32' ? JSON.stringify(s) : "'" + s.replace(/'/g, "'\\''") + "'";
}
module.exports = { shArg };
