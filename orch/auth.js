const crypto = require('crypto');

// 会话持久化在 SQLite(见 store.sessions),进程重启不掉线

function parseCookie(h) {
  const o = {};
  (h || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) { const raw = p.slice(i + 1).trim(); let v; try { v = decodeURIComponent(raw); } catch (e) { v = raw; } o[p.slice(0, i).trim()] = v; } }); // decodeURIComponent 遇畸形 %编码会抛→兜底原值,防一个坏 cookie 让每个请求 500
  return o;
}
function login(store, name, pw) {
  const p = store.verifyLogin(name, pw);
  if (!p) return null;
  const tok = crypto.randomBytes(18).toString('hex');
  store.addSession(tok, p.id);
  return { tok, user: p };
}
function logout(store, tok) { store.delSession(tok); }
function tokenFromReq(req) { return parseCookie(req.headers.cookie).orch_sess; }
function userFromReq(store, req) {
  const uid = store.sessionUser(tokenFromReq(req));
  return uid ? store.getPerson(uid) : null;
}

module.exports = { login, logout, userFromReq, tokenFromReq };
