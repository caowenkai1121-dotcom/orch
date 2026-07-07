const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('published app routes are registered before login gate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const appRoute = src.indexOf("app.get('/apps/:id', servePublishedApp)");
  const loginGate = src.indexOf("app.use((req, res, next) => { if (req.user) return next(); res.status(401)");

  assert.ok(appRoute >= 0, 'server should register /apps/:id route');
  assert.ok(loginGate >= 0, 'server should keep a login gate for private APIs');
  assert.ok(appRoute < loginGate, 'published app routes must be public and run before the login gate');
});

test('rewritten published app text assets are not cached', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const cacheHeader = src.indexOf("res.setHeader('Cache-Control', 'no-store')");
  const rewrite = src.indexOf('appRuntime.rewritePublishedText');

  assert.ok(cacheHeader >= 0, 'server should disable cache for rewritten app assets');
  assert.ok(rewrite >= 0, 'server should rewrite published app text assets');
  assert.ok(cacheHeader < rewrite, 'cache header must be set before sending rewritten text assets');
});
