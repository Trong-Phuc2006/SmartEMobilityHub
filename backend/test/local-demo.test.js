const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { fork } = require("node:child_process");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const { demoPaths, inspectPaths, initializeLocalDemo, openLocalDemo, startLocalDemo, localDemoStatus, seedLocalDemo } = require("../src/config/local-demo");
const { parseConfig, BACKEND_ROOT } = require("../src/config/env");
const { startServer } = require("../src/server");
const { localDemoFixture } = require("./local-demo.helpers");
const { protectedSnapshot, runNode, testEnv } = require("./helpers");

const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const dummy = { email: "p7-student@example.com", password: "p7-fixture-password" };

async function freePort() {
  const server = net.createServer();
  server.listen(0, "localhost"); await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function childDemo(name, port) {
  const child = fork(path.join(BACKEND_ROOT, "scripts/local-demo.js"), ["start", "--name=" + name], {
    cwd: BACKEND_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...testEnv(), PORT: String(port), HOST: "localhost", FRONTEND_ORIGIN: "http://localhost:5173", COOKIE_SECURE: "false" },
  });
  child.stdout.resume(); child.stderr.resume(); // Never retain secret-bearing objects.
  const exited = once(child, "exit");
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Owned demo child startup timeout")), 12000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("Owned demo child failed")); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Owned demo child exited before ready")); });
      child.once("message", (message) => { clearTimeout(timer); message.ready ? resolve() : reject(new Error("Invalid ready signal")); });
    });
  } catch (error) { child.kill(); await exited; throw error; }
  let closing;
  return { child, close() {
    if (!closing) closing = (async () => {
      if (child.exitCode === null) child.send("shutdown");
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 7000);
      try { const [code] = await exited; assert.equal(code, 0, "owned child must close gracefully"); }
      finally { clearTimeout(timer); }
    })();
    return closing;
  } };
}

test("explicit demo refuses unsafe names, overwrite, missing ownership, redirected files and invalid key", async (t) => {
  const before = protectedSnapshot();
  for (const name of [undefined, "../database", "", "CON", "con", "a/b", "C:\\database", "a b", "x".repeat(33)]) assert.throws(() => demoPaths(name));
  const p = localDemoFixture(t);
  const original = { db: hash(p.database), key: hash(p.env), marker: fs.readFileSync(p.marker, "utf8") };
  assert.throws(() => initializeLocalDemo(p.name));
  assert.equal(hash(p.database), original.db); assert.equal(hash(p.env), original.key);
  fs.writeFileSync(p.marker, '{}'); assert.throws(() => inspectPaths(p.name)); fs.writeFileSync(p.marker, original.marker);
  const keyFile = fs.readFileSync(p.env);
  fs.writeFileSync(p.env, 'JWT_SECRET=invalid\n');
  await assert.rejects(startLocalDemo(p.name)); fs.writeFileSync(p.env, keyFile);
  const linked = p.database + '.hardlink';
  fs.linkSync(p.database, linked);
  assert.throws(() => openLocalDemo(p.name)); fs.unlinkSync(linked);
  // A dangling sidecar must not evade existsSync checks and redirect writes.
  try {
    fs.symlinkSync(path.join(p.directory, 'absent-target'), p.database + '-journal');
    assert.throws(() => openLocalDemo(p.name));
    fs.unlinkSync(p.database + '-journal');
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.diagnostic('SYMLINK_NOT_RUN: OS denied creating the owned dangling-link fixture; hardlink guard was executed.');
  }
  const result = runNode(['scripts/local-demo.js', 'seed', '--name=' + p.name, '--database=../database/smart_mobility.db']);
  assert.equal(result.status, 1);
  assert.deepEqual(protectedSnapshot(), before);
});

test("real demo CLI/API preserves Users, data, key and JWT across graceful backend process restart", { timeout: 60000 }, async (t) => {
  let running;
  t.after(async () => { if (running) await running.close(); });
  const before = protectedSnapshot(), p = localDemoFixture(t), port = await freePort();
  const base = 'http://localhost:' + port;
  const keyHash = hash(p.env);
  const key = dotenv.parse(fs.readFileSync(p.env)).JWT_SECRET;
  assert.equal(/^[a-f0-9]{64}$/.test(key), true); // Never print the key.
  async function request(route, body, cookie) {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: 'http://localhost:5173', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}), Connection: 'close' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, json: await response.json() };
  }
  running = await childDemo(p.name, port);
  const register = await request('/auth/register', dummy);
  assert.equal(register.response.status, 201); assert.equal(register.response.headers.get('set-cookie'), null);
  assert.equal((await request('/auth/register', dummy)).response.status, 409);
  assert.equal((await request('/auth/register', { ...dummy, role: 'OPERATOR' })).response.status, 400);
  const user = register.json.data.user;
  const db = openLocalDemo(p.name, { readonly: true });
  try {
    const saved = db.prepare('SELECT * FROM Users WHERE user_id=?').get(user.user_id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM Users').get().n, 1);
    assert.equal(saved.role, 'STUDENT'); assert.equal(saved.status, 'ACTIVE');
    assert.equal(saved.password_hash.startsWith('scrypt$v1$N=16384,r=8,p=5,maxmem=67108864$'), true);
    assert.equal(saved.password_hash.includes(dummy.password), false);
  } finally { db.close(); }
  assert.equal((await request('/auth/login', { ...dummy, password: 'wrong' })).response.status, 401);
  const login = await request('/auth/login', dummy);
  assert.equal(login.response.status, 200);
  const header = login.response.headers.get('set-cookie');
  for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=3600']) assert.equal(header.includes(attr), true);
  assert.equal(header.includes('Secure'), false);
  const cookie = header.split(';')[0];
  const claims = jwt.verify(cookie.slice('semh_auth='.length), Buffer.from(key, 'hex'), { algorithms: ['HS256'], issuer: 'smartemobilityhub-api', audience: 'smartemobilityhub-web' });
  assert.equal(claims.sub === user.user_id, true); assert.equal(claims.exp - claims.iat, 3600);
  assert.deepEqual((await request('/auth/me', undefined, cookie)).json.data.user, user);
  const seed = runNode(['scripts/local-demo.js', 'seed', '--name=' + p.name, '--student-email=' + dummy.email]);
  assert.equal(seed.status, 0);
  const repeat = runNode(['scripts/local-demo.js', 'seed', '--name=' + p.name, '--student-email=' + dummy.email]);
  assert.equal(repeat.status, 0); assert.deepEqual(JSON.parse(repeat.stdout).inserted, { Users: 0, Hubs: 0, ParkingSpaces: 0, Reservations: 0 });
  const status = runNode(['scripts/local-demo.js', 'status', '--name=' + p.name]);
  assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).spaces, 6);
  assert.equal(localDemoStatus(p.name).hubs, 3);
  const seededHash = hash(p.database);
  const first = (await request('/hubs/demo-campus/parking-spaces', undefined, cookie)).json.data;
  assert.deepEqual(first.summary, { total_spaces: 4, available: 1, reserved: 2, occupied: 1 });
  assert.equal(first.spaces.filter((s) => s.is_mine).length, 2);
  assert.equal(JSON.stringify(first).includes('synthetic-other'), false);
  await running.close(); running = undefined;
  assert.equal(localDemoStatus(p.name).users, 2); // Reopen after process stopped.
  running = await childDemo(p.name, port);
  assert.equal(hash(p.env), keyHash);
  assert.deepEqual((await request('/auth/me', undefined, cookie)).json.data.user, user);
  assert.deepEqual((await request('/hubs/demo-campus/parking-spaces', undefined, cookie)).json.data, first);
  assert.equal((await request('/auth/login', dummy)).response.status, 200);
  const logout = await request('/auth/logout', {}, cookie);
  assert.equal(logout.json.data.logged_out, true);
  assert.equal(logout.response.headers.get('set-cookie').startsWith('semh_auth=;'), true);
  assert.equal((await request('/hubs')).response.status, 401);
  assert.equal(hash(p.database), seededHash, 'GET/Login/Me/Logout and restart must not mutate the seeded SQLite file');
  assert.deepEqual(protectedSnapshot(), before);
});

test("seed preserves unrelated records, refuses collisions atomically, and never runs on startup/GET", async (t) => {
  let running;
  t.after(async () => { if (running) await running.close(); });
  const p = localDemoFixture(t);
  await assert.rejects(seedLocalDemo(p.name, dummy.email));
  const db = openLocalDemo(p.name);
  try {
    db.prepare("INSERT INTO Users(user_id,role,email,password_hash,status) VALUES ('student','STUDENT',?,'unused','ACTIVE')").run(dummy.email);
    db.prepare("INSERT INTO Hubs VALUES ('keep','Keep me',NULL,99)").run();
    db.prepare("INSERT INTO Hubs VALUES ('demo-campus','Teammate synthetic row',NULL,7)").run();
  } finally { db.close(); }
  const before = localDemoStatus(p.name);
  await assert.rejects(seedLocalDemo(p.name, dummy.email));
  assert.deepEqual(localDemoStatus(p.name), before);
  const read = openLocalDemo(p.name, { readonly: true });
  try { assert.equal(read.prepare("SELECT name FROM Hubs WHERE hub_id='demo-campus'").get().name, 'Teammate synthetic row'); }
  finally { read.close(); }
  running = await startLocalDemo(p.name, { env: { PORT: String(await freePort()) } });
  const response = await fetch('http://localhost:' + running.server.address().port + '/hubs');
  assert.equal(response.status, 401);
  assert.deepEqual(localDemoStatus(p.name), before);
});

test("new resource injection still fails closed before open and closes file on port conflict", async (t) => {
  let calls = 0;
  await assert.rejects(startServer({ config: parseConfig({ NODE_ENV: 'test' }), createDatabase: () => { calls++; } }));
  assert.equal(calls, 0);
  let first;
  t.after(async () => { if (first) await first.close(); });
  const p = localDemoFixture(t), port = await freePort();
  first = await startLocalDemo(p.name, { env: { PORT: String(port) } });
  await assert.rejects(startLocalDemo(p.name, { env: { PORT: String(port) } }), { code: 'EADDRINUSE' });
  await first.close(); first = undefined;
  const again = await startLocalDemo(p.name, { env: { PORT: String(port) } });
  await again.close(); assert.equal(again.db.open, false);
});
