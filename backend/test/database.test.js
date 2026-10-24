const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createTestDatabase, openDemoDatabase } = require("../src/config/db");
const { TEAM_DATABASE_PATH, DEMO_DATABASE_PATH } = require("../src/config/env");
const { protectedSnapshot } = require("./helpers");

test("file-based test databases are unique, isolated, persistent until cleanup and cleaned safely", () => {
  const before = protectedSnapshot();
  const first = createTestDatabase();
  const second = createTestDatabase();
  const directory = path.dirname(first.filename);
  try {
    assert.notEqual(first.filename, second.filename);
    assert.notEqual(first.filename, TEAM_DATABASE_PATH);
    assert.notEqual(first.filename, DEMO_DATABASE_PATH);
    assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("smartemobilityhub-test-"));
    first.db.prepare("INSERT INTO Hubs (hub_id,name,total_parking_capacity) VALUES (?,?,?)")
      .run("hub-one", "Isolated hub", 1);
    assert.equal(first.db.prepare("SELECT name FROM Hubs WHERE hub_id=?").get("hub-one").name, "Isolated hub");
    assert.equal(second.db.prepare("SELECT COUNT(*) AS count FROM Hubs").get().count, 0);
    assert.ok(fs.existsSync(first.filename));
    first.db.close();
    const reopened = new Database(first.filename, { fileMustExist: true });
    try {
      reopened.pragma("foreign_keys = ON");
      assert.equal(reopened.prepare("SELECT name FROM Hubs WHERE hub_id=?").get("hub-one").name, "Isolated hub");
    } finally {
      reopened.close();
    }
    assert.deepEqual(protectedSnapshot(), before);
  } finally {
    first.cleanup();
    second.cleanup();
  }
  assert.equal(first.db.open, false);
  assert.equal(fs.existsSync(directory), false);
  first.cleanup(); // Idempotent; never resolves a target from process.env.
  assert.deepEqual(protectedSnapshot(), before);
});

test("the original schema initializes all ten tables and foreign keys reject invalid references", () => {
  const resource = createTestDatabase();
  try {
    const { db } = resource;
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all().map((row) => row.name);
    assert.equal(names.length, 10);
    for (const name of ["Users", "Hubs", "ParkingSpaces", "Reservations"]) assert.ok(names.includes(name));
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    db.prepare("INSERT INTO Hubs (hub_id,name,total_parking_capacity) VALUES (?,?,?)")
      .run("hub-test", "Test hub", 1);
    db.prepare("INSERT INTO ParkingSpaces (space_id,hub_id) VALUES (?,?)").run("space-test", "hub-test");
    assert.equal(db.prepare("SELECT state FROM ParkingSpaces WHERE space_id=?").get("space-test").state, "AVAILABLE");
    assert.throws(
      () => db.prepare("INSERT INTO ParkingSpaces (space_id,hub_id) VALUES (?,?)").run("invalid-space", "missing"),
      { code: "SQLITE_CONSTRAINT_FOREIGNKEY" },
    );
  } finally {
    resource.cleanup();
  }
});

test("test factory ignores application DATABASE_PATH and demo factory refuses the team database", () => {
  const before = protectedSnapshot();
  const saved = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = TEAM_DATABASE_PATH;
  let resource;
  try {
    resource = createTestDatabase();
    assert.notEqual(resource.filename, TEAM_DATABASE_PATH);
    assert.throws(() => openDemoDatabase(TEAM_DATABASE_PATH), /Refusing to open/);
    assert.throws(() => openDemoDatabase("../database/smart_mobility.demo.db"), /Refusing to open/);
    assert.deepEqual(protectedSnapshot(), before);
  } finally {
    resource?.cleanup();
    if (saved === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = saved;
  }
  assert.deepEqual(protectedSnapshot(), before);
});

test("in-memory schema initialization needs no JWT or persistent DB", () => {
  const before = protectedSnapshot();
  const resource = createTestDatabase({ memory: true });
  try {
    assert.equal(resource.filename, ":memory:");
    assert.equal(resource.db.prepare("SELECT COUNT(*) AS count FROM Hubs").get().count, 0);
  } finally {
    resource.cleanup();
  }
  assert.deepEqual(protectedSnapshot(), before);
});
