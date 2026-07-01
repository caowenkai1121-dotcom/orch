const crypto = require('crypto');

const sessions = new Map(); // token -> userId

function parseCookie(h) {
  const o = {};
  (h || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function login(store, name, pw) {
  const p = store.verifyLogin(name, pw);
  if (!p) return null;
  const tok = crypto.randomBytes(18).toString('hex');
  sessions.set(tok, p.id);
  return { tok, user: p };
}
function logout(tok) { sessions.delete(tok); }
function tokenFromReq(req) { return parseCookie(req.headers.cookie).orch_sess; }
function userFromReq(store, req) {
  const uid = sessions.get(tokenFromReq(req));
  return uid ? store.getPerson(uid) : null;
}

module.exports = { login, logout, userFromReq, tokenFromReq };
