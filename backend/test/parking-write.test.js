const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { authFixture, cookiePair, expectError, credentials } = require("./auth.helpers");
const { ownReservations } = require("../src/services/parking.service");

async function fixture(t) {
  const f = await authFixture(t);
  await f.register();
  const cookie = cookiePair(await f.login());
  const user = f.users()[0];
  f.db.prepare("INSERT INTO Users(user_id,email,role,password_hash) VALUES ('other','other@example.invalid','STUDENT',?)").run(user.password_hash);
  f.db.exec(`INSERT INTO Hubs VALUES ('a','Campus','CAMPUS',3),('b','Metro','METRO',1);
    INSERT INTO ParkingSpaces VALUES ('one','a','AVAILABLE'),('two','a','AVAILABLE'),('special /?','a','AVAILABLE'),('three','b','AVAILABLE');`);
  const route = (space = "one", action = "reserve", hub = "a") => "/hubs/" + encodeURIComponent(hub) + "/parking-spaces/" + encodeURIComponent(space) + "/" + action;
  const act = (space, action, owner = cookie, hub) => f.post(route(space, action, hub), {}, { cookie: owner });
  return { ...f, cookie, user, route, act, other: "semh_auth=" + f.token({ sub: "other" }) };
}

test("Parking HTTP lifecycle synchronizes SQLite, privacy, summaries and cancellation history", async (t) => {
  const f = await fixture(t);
  for (const operation of ["reserve", "arrive", "release"]) {
    const r = await f.act("one", operation);
    assert.equal(r.response.status, operation === "reserve" ? 201 : 200);
    const state = { reserve: "RESERVED", arrive: "OCCUPIED", release: "AVAILABLE" }[operation];
    assert.equal(r.json.data.parking.spaces.find(s => s.space_id === "one").state, state);
    assert.equal(f.db.prepare("SELECT state FROM ParkingSpaces WHERE space_id='one'").get().state, state);
    assert.equal(r.json.data.reservations.length, operation === "release" ? 0 : 1);
    assert.equal(r.json.data.parking.summary.available, operation === "release" ? 3 : 2);
    assert.doesNotMatch(JSON.stringify(r.json), /email|user_id|reservation_id|password|start_time/);
  }
  let row = f.db.prepare("SELECT * FROM Reservations").get();
  assert.equal(row.state, "COMPLETED"); assert.ok(row.end_time > row.start_time);
  await f.act("special /?", "reserve");
  const mine = await f.request("/parking-reservations", { cookie: f.cookie });
  assert.deepEqual(mine.json.data.reservations, [{ space_id: "special /?", hub_id: "a", hub_name: "Campus", state: "RESERVED" }]);
  f.db.exec("UPDATE Hubs SET name='' WHERE hub_id='a'");
  assert.equal((await f.request("/parking-reservations", { cookie: f.cookie })).json.data.reservations[0].hub_name, "");
  f.db.exec("UPDATE Hubs SET name='Campus' WHERE hub_id='a'");
  await f.act("special /?", "release");
  row = f.db.prepare("SELECT * FROM Reservations WHERE space_id='special /?'").get();
  assert.equal(row.state, "CANCELLED"); assert.ok(row.end_time > row.start_time);
});

test("Parking ownership, global one-active rule, unavailable and illegal transitions reject safely", async (t) => {
  const f = await fixture(t);
  expectError(await f.act("one", "arrive"), 409, "INVALID_PARKING_TRANSITION");
  await f.act("one", "reserve");
  expectError(await f.act("one", "reserve", f.other), 409, "SPACE_UNAVAILABLE");
  expectError(await f.act("three", "reserve", f.cookie, "b"), 409, "ACTIVE_RESERVATION_EXISTS");
  for (const action of ["arrive", "release"]) expectError(await f.act("one", action, f.other), 403, "PARKING_NOT_OWNED");
  await f.act("one", "arrive");
  expectError(await f.act("one", "arrive"), 409, "INVALID_PARKING_TRANSITION");
  expectError(await f.act("two", "reserve"), 409, "ACTIVE_RESERVATION_EXISTS");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM Reservations").get().n, 1);
  assert.deepEqual((await f.request("/parking-reservations", { cookie: f.other })).json.data.reservations, []);
});

test("Parking POST shares Auth Origin/media/size/empty-object guards and trusted identity", async (t) => {
  const f = await fixture(t);
  expectError(await f.post(f.route(), {}, {}), 401, "AUTH_REQUIRED");
  expectError(await f.post(f.route(), {}, { cookie: f.cookie, headers: { Origin: undefined } }), 403, "ORIGIN_NOT_ALLOWED");
  expectError(await f.post(f.route(), {}, { cookie: f.cookie, headers: { "Content-Type": "text/plain" } }), 415, "UNSUPPORTED_MEDIA_TYPE");
  expectError(await f.post(f.route(), {}, { cookie: f.cookie, raw: "{" }), 400, "INVALID_JSON");
  expectError(await f.post(f.route(), {}, { cookie: f.cookie, raw: " ".repeat(9000) }), 413, "PAYLOAD_TOO_LARGE");
  for (const body of [null, [], "text"]) expectError(await f.post(f.route(), body, { cookie: f.cookie }), 400, "VALIDATION_ERROR", { _body: "INVALID_TYPE" });
  expectError(await f.post(f.route(), { user_id: "other" }, { cookie: f.cookie }), 400, "VALIDATION_ERROR", { user_id: "UNEXPECTED_FIELD" });
  expectError(await f.act("one", "reserve", f.cookie, "b"), 404, "SPACE_NOT_FOUND");
  expectError(await f.act("missing", "reserve"), 404, "SPACE_NOT_FOUND");
  expectError(await f.act("one", "reserve", f.cookie, "missing"), 404, "HUB_NOT_FOUND");
  expectError(await f.act("\n", "reserve"), 400, "VALIDATION_ERROR", { spaceId: "INVALID_SPACE_ID" });
  for (const [status, role, code] of [["DISABLED", "STUDENT", "ACCOUNT_DISABLED"], ["ACTIVE", "OPERATOR", "ROLE_NOT_SUPPORTED"]]) {
    f.db.prepare("UPDATE Users SET status=?,role=? WHERE user_id=?").run(status, role, f.user.user_id);
    expectError(await f.act("one", "reserve"), 403, code);
  }
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM Reservations").get().n, 0);
});

test("Parking rollback includes insert, reservation update, space update and snapshot failures", async (t) => {
  const f = await fixture(t);
  f.db.exec("CREATE TRIGGER fail_space BEFORE UPDATE ON ParkingSpaces BEGIN SELECT RAISE(ABORT,'test'); END;");
  expectError(await f.act("one", "reserve"), 500, "INTERNAL_ERROR");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM Reservations").get().n, 0);
  f.db.exec("DROP TRIGGER fail_space");
  await f.act("one", "reserve");
  f.db.exec("CREATE TRIGGER fail_space BEFORE UPDATE ON ParkingSpaces BEGIN SELECT RAISE(ABORT,'test'); END;");
  for (const action of ["arrive", "release"]) {
    expectError(await f.act("one", action), 500, "INTERNAL_ERROR");
    assert.equal(f.db.prepare("SELECT state FROM Reservations").get().state, "RESERVED");
    assert.equal(f.db.prepare("SELECT state FROM ParkingSpaces WHERE space_id='one'").get().state, "RESERVED");
  }
  f.db.exec("DROP TRIGGER fail_space");
  // Inconsistent duplicate at a different target makes the response snapshot fail.
  f.db.exec("INSERT INTO Reservations SELECT 'duplicate',user_id,type,vehicle_id,space_id,start_time,end_time,state,created_at FROM Reservations;");
  expectError(await f.act("one", "release"), 500, "DATA_INTEGRITY_ERROR");
  assert.throws(() => ownReservations(f.db, f.user.user_id), { code: "DATA_INTEGRITY_ERROR" });
  assert.equal(f.db.prepare("SELECT state FROM ParkingSpaces WHERE space_id='one'").get().state, "RESERVED");
});

async function processServer(t, f) {
  const child = fork(path.join(__dirname, "parking-process.fixture.js"), [], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = once(child, "exit");
  const ready = once(child, "message");
  child.send({ filename: f.filename, secret: f.config.jwtSecret });
  const [{ port }] = await ready;
  let stopped;
  const close = () => stopped ||= (async () => {
    if (child.connected) child.send("shutdown");
    const timer = setTimeout(() => child.kill(), 8000);
    try { const [code] = await exited; assert.equal(code, 0); }
    finally { clearTimeout(timer); }
  })();
  t.after(close);
  return { base: "http://localhost:" + port, close };
}

test("post-write snapshot failure rolls everything back; busy writer returns safe503; inconsistent state is rejected", async (t) => {
  const f = await fixture(t);
  f.db.exec(`UPDATE ParkingSpaces SET state='RESERVED' WHERE space_id='two';
    INSERT INTO Reservations(reservation_id,user_id,type,space_id,start_time,state,created_at)
      VALUES ('bad1','other','PARKING','two','2026-10-01T00:00:00Z','RESERVED','2026-10-01T00:00:00Z'),
      ('bad2','other','PARKING','two','2026-10-01T00:00:00Z','RESERVED','2026-10-01T00:00:00Z');`);
  expectError(await f.act("one", "reserve"), 500, "DATA_INTEGRITY_ERROR");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM Reservations WHERE space_id='one'").get().n, 0);
  assert.equal(f.db.prepare("SELECT state FROM ParkingSpaces WHERE space_id='one'").get().state, "AVAILABLE");
  f.db.exec("DELETE FROM Reservations; UPDATE ParkingSpaces SET state='AVAILABLE';");
  const Database = require("better-sqlite3");
  const locker = new Database(f.filename, { fileMustExist: true });
  try {
    f.db.pragma("busy_timeout=20"); locker.exec("BEGIN IMMEDIATE");
    expectError(await f.act("one", "reserve"), 503, "SERVICE_UNAVAILABLE");
    locker.exec("ROLLBACK");
  } finally { locker.close(); }
  await f.act("one", "reserve");
  f.db.exec("UPDATE ParkingSpaces SET state='OCCUPIED' WHERE space_id='one'");
  expectError(await f.act("one", "release"), 500, "DATA_INTEGRITY_ERROR");
  assert.equal(f.db.prepare("SELECT state FROM Reservations").get().state, "RESERVED");
});

test("two independent server processes race on same SQLite; close/reopen preserves users and full lifecycle", { timeout: 60000 }, async (t) => {
  const stops = [];
  t.after(async () => { for (const stop of stops) await stop(); });
  const f = await fixture(t);
  const owned = { after: (stop) => stops.push(stop) };
  let a = await processServer(owned, f), b = await processServer(owned, f);
  async function post(server, space, cookie = f.cookie, action = "reserve") {
    return fetch(server.base + f.route(space, action), { method: "POST", headers: { Origin: f.config.frontendOrigin, "Content-Type": "application/json", Cookie: cookie }, body: "{}" });
  }
  let race = await Promise.all([post(a, "one"), post(b, "one", f.other)]);
  assert.deepEqual(race.map(r => r.status).sort(), [201, 409]);
  const winner = race[0].status === 201 ? f.cookie : f.other;
  assert.equal((await post(a, "one", winner, "release")).status, 200);
  race = await Promise.all([post(a, "one"), post(b, "two")]);
  assert.deepEqual(race.map(r => r.status).sort(), [201, 409]);
  const space = race[0].status === 201 ? "one" : "two";
  await a.close(); await b.close();
  a = await processServer(owned, f);
  assert.equal((await fetch(a.base + "/auth/me", { headers: { Cookie: f.cookie } })).status, 200);
  assert.equal((await post(a, space, f.cookie, "arrive")).status, 200);
  await a.close(); a = await processServer(owned, f);
  let snapshot = await (await fetch(a.base + "/parking-reservations", { headers: { Cookie: f.cookie } })).json();
  assert.equal(snapshot.data.reservations[0].state, "OCCUPIED");
  assert.equal((await post(a, space, f.cookie, "release")).status, 200);
  await a.close(); a = await processServer(owned, f);
  snapshot = await (await fetch(a.base + "/parking-reservations", { headers: { Cookie: f.cookie } })).json();
  assert.deepEqual(snapshot.data.reservations, []);
  const login = await fetch(a.base + "/auth/login", { method: "POST", headers: { Origin: f.config.frontendOrigin, "Content-Type": "application/json" }, body: JSON.stringify(credentials) });
  assert.equal(login.status, 200);
  assert.equal(f.db.pragma("foreign_key_check").length, 0);
});
