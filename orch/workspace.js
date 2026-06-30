// 共享工作区:同一任务所有步骤共用一个目录,顺序依赖(dev→test→fix)天然可见。
// 真验证发现 per-step git worktree 会让下游步骤看不到上游产物,且 codex 强制要 git 仓内运行;
// 故默认共享。真正的并行隔离(每个独立分支一个 worktree + 汇合时 merge)留作未来 opt-in。
function makeWorkspace(rootRepo) {
  return {
    make() {
      return rootRepo;
    },
  };
}

module.exports = { makeWorkspace };
