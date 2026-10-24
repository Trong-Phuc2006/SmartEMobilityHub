const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { authFixture, cookiePair, expectError, expectClear } = require("./auth.helpers");
const { seedParking } = require("./parking.helpers");
const { readParking } = require("../src/services/parking.service");

async function fixture(t, seed = true) {
  const f = await authFixture(t);
  const registered = await f.register();
  const userId = registered.json.data.user.user_id;
  const cookie = cookiePair(await f.login());
  const seeded = seed ? seedParking(f.db, userId) : {};
  return { ...f, ...seeded, userId, cookie, get: (path) => f.request(path, { cookie }) };
}

test("Hubs/parking enforce current Auth account and reject forged request identities", async (t) => {
  const f = await fixture(t);
  const routes = ["/hubs", "/hubs/hub-a/parking-spaces"];
  for (const route of routes) {
    for (const [name, token, code] of [
      ["missing", undefined, "AUTH_REQUIRED"], ["invalid", "invalid", "SESSION_INVALID"],
      ["unknown", f.token(), "SESSION_INVALID"],
      ["expired", f.token({ sub: f.userId, iat: Math.floor(Date.now() / 1000) - 3601, exp: Math.floor(Date.now() / 1000) - 1 }), "SESSION_EXPIRED"],
    ]) await t.test(route + " " + name, async () => {
      const result = await f.request(route, { cookie: token === undefined ? undefined : "semh_auth=" + token });
      expectError(result, 401, code);
      expectClear(result);
    });
    for (const [field, value, code] of [["status", "INACTIVE", "ACCOUNT_DISABLED"], ["role", "OPERATOR", "ROLE_NOT_SUPPORTED"]]) {
      await t.test(route + " " + field, async () => {
        // Field is a fixed fixture identifier, never user input.
        f.db.prepare(`UPDATE Users SET ${field}=? WHERE user_id=?`).run(value, f.userId);
        const result = await f.get(route);
        expectError(result, 403, code); expectClear(result);
        f.db.prepare("UPDATE Users SET role='STUDENT',status='ACTIVE' WHERE user_id=?").run(f.userId);
      });
    }
  }
  const result = await f.get("/hubs/hub-a/parking-spaces?user_id=" + f.otherId + "&role=OPERATOR");
  assert.equal(result.response.status, 200);
  assert.equal(result.json.data.spaces.find((s) => s.space_id === "B-reserved-mine").is_mine, true);
});

test("Hubs return sorted whitelisted SQLite values, empty list, no cookie renewal or writes", async (t) => {
  const f = await fixture(t, false);
  assert.deepEqual((await f.get("/hubs")).json, { ok: true, data: { hubs: [] } });
  seedParking(f.db, f.userId);
  const changes = f.changes();
  f.db.pragma("query_only = ON");
  const { response, json } = await f.get("/hubs");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(json.data.hubs.map((h) => h.hub_id), ["hub-a", "hub-a2", "hub-b", "hub-empty", "hub/special ?"]);
  assert.deepEqual(json.data.hubs[0], { hub_id: "hub-a", name: "Alpha Hub", location_type: "CAMPUS", total_parking_capacity: 12 });
  assert.equal(json.data.hubs[1].location_type, null);
  assert.equal(f.changes(), changes);
});

test("Parking projection counts every space once, preserves enums/IDs and only exposes ownership booleans", async (t) => {
  const f = await fixture(t);
  const changes = f.changes();
  f.db.pragma("query_only = ON");
  const { response, json } = await f.get("/hubs/hub-a/parking-spaces");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  const { hub, summary, spaces } = json.data;
  assert.equal(hub.total_parking_capacity, 12);
  assert.deepEqual(summary, { total_spaces: 7, available: 1, reserved: 3, occupied: 3 });
  assert.deepEqual(spaces.map((s) => s.space_id), f.spaces.map(([id]) => id).sort());
  for (const s of spaces) {
    assert.deepEqual(Object.keys(s).sort(), ["has_current_reservation", "hub_id", "is_mine", "space_id", "state"]);
    assert.equal(s.hub_id, "hub-a");
    assert.equal(s.has_current_reservation, ["B-reserved-mine", "C-occupied-mine", "D-reserved-other", "E-occupied-other"].includes(s.space_id));
    assert.equal(s.is_mine, ["B-reserved-mine", "C-occupied-mine"].includes(s.space_id));
  }
  assert.doesNotMatch(JSON.stringify(json), /user_id|email|private-other|other-parking-user|password/);
  assert.equal(f.changes(), changes);
  assert.equal((await f.get("/hubs/hub-b/parking-spaces")).json.data.spaces[0].space_id, "Beta-space");
  assert.equal((await f.get("/hubs/" + encodeURIComponent("hub/special ?") + "/parking-spaces")).json.data.spaces[0].space_id, "Special-space");
});

test("Parking distinguishes missing Hub, invalid opaque ID, valid boundary IDs and empty Hub", async (t) => {
  const f = await fixture(t);
  expectError(await f.get("/hubs/missing/parking-spaces"), 404, "HUB_NOT_FOUND");
  for (const id of ["x".repeat(129), "control\u0000", "control\u007f", "control\u0085"]) {
    expectError(await f.get("/hubs/" + encodeURIComponent(id) + "/parking-spaces"), 400, "VALIDATION_ERROR", { hubId: "INVALID_HUB_ID" });
  }
  for (const id of ["x", "🔋".repeat(128), "x' OR 1=1 --"]) {
    f.db.prepare("INSERT INTO Hubs(hub_id,name,total_parking_capacity) VALUES (?,?,0)").run(id, "Boundary");
    assert.equal((await f.get("/hubs/" + encodeURIComponent(id) + "/parking-spaces")).json.data.hub.hub_id, id);
  }
  const { json } = await f.get("/hubs/hub-empty/parking-spaces");
  assert.deepEqual(json.data.spaces, []);
  assert.deepEqual(json.data.summary, { total_spaces: 0, available: 0, reserved: 0, occupied: 0 });
});

test("multiple matching reservations fail safely without choosing an owner or repairing data", async (t) => {
  const f = await fixture(t);
  for (const [space, state] of [["B-reserved-mine", "RESERVED"], ["C-occupied-mine", "ACTIVE"]]) {
    f.reservation(space, state, f.otherId);
    const changes = f.changes();
    expectError(await f.get("/hubs/hub-a/parking-spaces"), 500, "DATA_INTEGRITY_ERROR");
    assert.equal(f.changes(), changes);
    assert.equal(f.db.inTransaction, false);
    f.db.prepare("DELETE FROM Reservations WHERE space_id=? AND user_id=? AND state=?").run(space, f.otherId, state);
  }
});

test("Hubs/parking translate read errors to safe 500/503 and preserve cookie for Retry", async (t) => {
  const f = await fixture(t);
  const original = f.db.prepare;
  for (const route of ["/hubs", "/hubs/hub-a/parking-spaces"]) {
    for (const [code, status, expected] of [["SQLITE_BUSY", 503, "SERVICE_UNAVAILABLE"], ["SQLITE_LOCKED", 503, "SERVICE_UNAVAILABLE"], ["SQLITE_ERROR", 500, "INTERNAL_ERROR"]]) {
      f.db.prepare = function (sql) {
        if (sql.includes("FROM Hubs")) throw Object.assign(new Error("private SQL detail"), { code });
        return original.call(this, sql);
      };
      const result = await f.get(route);
      expectError(result, status, expected);
      assert.equal(result.response.headers.get("set-cookie"), null);
      f.db.prepare = original;
    }
  }
});

test("read transaction keeps Hub/rows/counts coherent when another SQLite connection commits", async (t) => {
  let writer;
  t.after(() => { if (writer?.open) writer.close(); });
  const f = await fixture(t);
  f.db.pragma("journal_mode = WAL");
  writer = new Database(f.filename);
  writer.pragma("foreign_keys = ON");
  const original = f.db.prepare;
  let changed = false;
  f.db.prepare = function (sql) {
    const statement = original.call(this, sql);
    if (sql.includes("FROM Hubs WHERE")) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        assert.equal(f.db.inTransaction, true);
        const result = get(...args);
        if (!changed) {
          changed = true;
          writer.transaction(() => {
            writer.prepare("UPDATE Hubs SET total_parking_capacity=13 WHERE hub_id='hub-a'").run();
            writer.prepare("INSERT INTO ParkingSpaces(space_id,hub_id) VALUES ('new-concurrent-space','hub-a')").run();
          })();
        }
        return result;
      };
    }
    return statement;
  };
  const first = readParking(f.db, "hub-a", f.userId);
  f.db.prepare = original;
  assert.equal(first.hub.total_parking_capacity, 12);
  assert.equal(first.summary.total_spaces, 7);
  assert.equal(first.spaces.length, 7);
  const second = (await f.get("/hubs/hub-a/parking-spaces")).json.data;
  assert.equal(second.hub.total_parking_capacity, 13);
  assert.equal(second.summary.total_spaces, 8);
});
