const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { createHash } = require("node:crypto");
const { ensureLocalDemo, initializeLocalDemo, inspectPaths, openLocalDemo, localDemoStatus } = require("../src/config/local-demo");
const { verifyPassword } = require("../src/services/password.service");
const { localDemoFixture } = require("./local-demo.helpers");
const { testEnv, protectedSnapshot } = require("./helpers");
const fixture = require("../demo/demo-data.json");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const ROOT = path.resolve(__dirname, "../..");
async function freePort() {
  const server = net.createServer(); server.listen(0, "localhost"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

test("one-time fixture bootstrap hashes demo credentials, reuses unchanged DB/key and preserves an existing empty P7 instance", async (t) => {
  const before = protectedSnapshot();
  const p = localDemoFixture(t, { fresh: true });
  assert.equal((await ensureLocalDemo(p.name)).initialized, true);
  const db = openLocalDemo(p.name);
  try {
    assert.equal(db.pragma("foreign_key_check").length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM ParkingSpaces").get().n, 12);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM Vehicles").get().n, 8);
    assert.equal(db.prepare("SELECT hub_id FROM Vehicles WHERE state='IN_USE'").get().hub_id, null);
    assert.deepEqual(db.prepare("SELECT DISTINCT battery_level FROM Vehicles WHERE battery_level IN (0,19,20,100) ORDER BY battery_level").all().map(r => r.battery_level), [0,19,20,100]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM Vehicles WHERE hub_id='new-campus'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM Reservations WHERE type='VEHICLE'").get().n, 2);
    for (const row of db.prepare("SELECT password_hash FROM Users").all()) assert.equal(await verifyPassword(fixture.password, row.password_hash), true);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM (SELECT user_id,type FROM Reservations WHERE state IN ('RESERVED','ACTIVE') GROUP BY user_id,type HAVING COUNT(*)>1)").get().n, 0);
    db.exec("UPDATE ParkingSpaces SET state='AVAILABLE' WHERE space_id='CAMPUS-02'; UPDATE Reservations SET state='CANCELLED' WHERE space_id='CAMPUS-02';");
  } finally { db.close(); }
  const saved = { db: hash(p.database), key: hash(p.env), status: localDemoStatus(p.name) };
  assert.equal((await ensureLocalDemo(p.name)).initialized, false);
  assert.deepEqual({ db: hash(p.database), key: hash(p.env), status: localDemoStatus(p.name) }, saved);
  const old = localDemoFixture(t);
  await ensureLocalDemo(old.name);
  assert.equal(localDemoStatus(old.name).users, 0);
  assert.equal(localDemoStatus(old.name).vehicles, 0);
  assert.deepEqual(protectedSnapshot(), before);
});

test("failed first-run transaction is never ready or silently reseeded", async (t) => {
  const p = localDemoFixture(t, { fresh: true });
  assert.throws(() => initializeLocalDemo(p.name, { populate: db => {
    db.exec("INSERT INTO Hubs VALUES ('h','H',NULL,0)"); throw new Error("owned fixture failure");
  } }));
  assert.equal(JSON.parse(fs.readFileSync(p.marker)).ready, false);
  assert.throws(() => inspectPaths(p.name), /incomplete/);
  await assert.rejects(ensureLocalDemo(p.name), /incomplete/);
  const Database = require("better-sqlite3");
  const db = new Database(p.database, { readonly: true, fileMustExist: true });
  try { assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), []); }
  finally { db.close(); }
});

async function launcher(t, name, options = {}) {
  const backendPort = options.backendPort || await freePort(), frontendPort = options.frontendPort || await freePort();
  const env = { ...testEnv(), NODE_ENV: "development", DEMO_NAME: name, HOST: "localhost", PORT: String(backendPort), VITE_DEV_PORT: String(frontendPort), COOKIE_SECURE: "false" };
  delete env.FRONTEND_ORIGIN; delete env.VITE_API_BASE_URL;
  const child = fork(path.join(ROOT, "scripts/dev-demo.js"), [], { cwd: ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exited = once(child, "exit");
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; options.onOutput?.(String(chunk)); });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("demo launcher timeout")), 30000);
    child.once("message", message => { clearTimeout(timer); resolve(message); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("launcher exited: " + output)); });
  });
  ready.catch(() => {});
  let stopping;
  const close = () => stopping ||= (async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send("shutdown");
    const timer = setTimeout(() => child.kill(), 12000);
    try { const [code] = await exited; assert.equal(code, 0); } finally { clearTimeout(timer); }
  })();
  t.after(close);
  return { child, ready, exited, close, backendPort, frontendPort, output: () => output };
}

test("root launcher starts both services twice; registered accounts, key and Parking changes survive separate process restarts", { timeout: 90000 }, async (t) => {
  const stops = []; t.after(async () => { for (const stop of stops) await stop(); });
  const p = localDemoFixture(t, { fresh: true });
  const owned = { after: fn => stops.push(fn) };
  let run = await launcher(owned, p.name); await run.ready;
  let base = "http://localhost:" + run.backendPort, origin = "http://localhost:" + run.frontendPort;
  const post = (route, body, cookie) => fetch(base + route, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  assert.equal((await fetch(origin)).status, 200);
  const credentials = { email: "registered@demo.example", password: "registered-demo-password" };
  assert.equal((await post("/auth/register", credentials)).status, 201);
  let login = await post("/auth/login", credentials); assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const route = action => "/hubs/campus/parking-spaces/CAMPUS-01/" + action;
  assert.equal((await post(route("reserve"), {}, cookie)).status, 201);
  const savedKey = hash(p.env), savedDb = hash(p.database), count = localDemoStatus(p.name);
  await run.close(); run = await launcher(owned, p.name); await run.ready;
  assert.equal(hash(p.env), savedKey); assert.equal(hash(p.database), savedDb); assert.deepEqual(localDemoStatus(p.name), count);
  base = "http://localhost:" + run.backendPort; origin = "http://localhost:" + run.frontendPort;
  assert.equal((await fetch(base + "/auth/me", { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await post(route("arrive"), {}, cookie)).status, 200);
  await run.close(); run = await launcher(owned, p.name); await run.ready;
  base = "http://localhost:" + run.backendPort; origin = "http://localhost:" + run.frontendPort;
  assert.equal((await (await fetch(base + "/parking-reservations", { headers: { Cookie: cookie } })).json()).data.reservations[0].state, "OCCUPIED");
  assert.equal((await post(route("release"), {}, cookie)).status, 200);
  await run.close(); run = await launcher(owned, p.name); await run.ready;
  base = "http://localhost:" + run.backendPort; origin = "http://localhost:" + run.frontendPort;
  login = await post("/auth/login", credentials); assert.equal(login.status, 200);
  const db = openLocalDemo(p.name, { readonly: true });
  try { assert.equal(db.prepare("SELECT state FROM ParkingSpaces WHERE space_id='CAMPUS-01'").get().state, "AVAILABLE");
    assert.equal(db.prepare("SELECT state FROM Reservations WHERE space_id='CAMPUS-01'").get().state, "COMPLETED"); }
  finally { db.close(); }
  assert.match(run.output(), /Reusing persistent SQLite/);
});

test("launcher occupied ports and backend startup failure exit clearly without orphan companion or data reset", { timeout: 45000 }, async (t) => {
  const stops = []; t.after(async () => { for (const stop of stops) await stop(); });
  const p = localDemoFixture(t); const owned = { after: fn => stops.push(fn) };
  const blocker = net.createServer(); blocker.listen(0, "localhost"); await once(blocker, "listening");
  const blocked = await launcher(owned, p.name, { frontendPort: blocker.address().port });
  const [code] = await blocked.exited; assert.equal(code, 1); assert.match(blocked.output(), /occupied/);
  await new Promise(resolve => blocker.close(resolve));
  const saved = hash(p.database); fs.writeFileSync(p.env, "JWT_SECRET=invalid\n");
  const failed = await launcher(owned, p.name); const [failedCode] = await failed.exited;
  assert.equal(failedCode, 1); assert.match(failed.output(), /backend exited before becoming ready/);
  assert.equal(hash(p.database), saved);
  assert.equal((await ensureLocalDemo(p.name)).initialized, false);
});

test("frontend late port failure closes the owned backend and leaves unrelated listener alone", { timeout: 45000 }, async (t) => {
  const stops = []; t.after(async () => { for (const stop of stops) await stop(); });
  const p = localDemoFixture(t, { fresh: true }); const owned = { after: fn => stops.push(fn) };
  const frontendPort = await freePort(), backendPort = await freePort();
  const blocker = net.createServer(); let bound;
  t.after(async () => { if (blocker.listening) await new Promise(resolve => blocker.close(resolve)); });
  const run = await launcher(owned, p.name, { frontendPort, backendPort, onOutput: chunk => {
    if (chunk.includes("Initialized once:")) { blocker.listen(frontendPort, "localhost"); bound = once(blocker, "listening"); }
  } });
  const [code] = await run.exited; assert.equal(code, 1); await bound;
  assert.match(run.output(), /Frontend startup failed/); assert.equal(blocker.listening, true);
  await assert.rejects(fetch("http://localhost:" + backendPort));
});

test("losing the owning launcher IPC closes both child listeners without leaving orphan servers", { timeout: 30000 }, async (t) => {
  const stops = []; t.after(async () => { for (const stop of stops) await stop(); });
  const p = localDemoFixture(t, { fresh: true });
  const run = await launcher({ after: fn => stops.push(fn) }, p.name); await run.ready;
  run.child.kill(); // Only the exact launcher process created by this test.
  await run.exited;
  const until = Date.now() + 10000;
  let open = true;
  while (Date.now() < until) {
    const results = await Promise.allSettled([fetch("http://localhost:" + run.backendPort), fetch("http://localhost:" + run.frontendPort)]);
    if (results.every(result => result.status === "rejected")) { open = false; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(open, false, "both children must close when their owning IPC disconnects");
});
