// 权限助手:归属/可见性/管理员门。全部服务端强制。
function make(store) {
  const owns = (u, t) => !!(u && t && (u.admin || t.owner === u.name));
  function visibleProjects(u) { // null=全部可见(管理员)
    if (!u || u.admin) return null;
    const set = new Set();
    store.listTasks().forEach((t) => { if (t.owner === u.name) set.add(t.project || '默认项目'); });
    store.listGrants().forEach((g) => { if (g.user_id === u.id) set.add(g.project); });
    store.listProjects().forEach((p) => { if (p.owner === u.id) set.add(p.name); });
    return set;
  }
  const canSeeTask = (u, t) => { if (!u || !t) return false; if (u.admin || t.owner === u.name) return true; const s = visibleProjects(u); return !!(s && s.has(t.project || '默认项目')); };
  const adminOnly = (req, res, next) => req.user.admin ? next() : res.status(403).json({ error: '需管理员' });
  return { owns, visibleProjects, canSeeTask, adminOnly };
}

module.exports = { make };
