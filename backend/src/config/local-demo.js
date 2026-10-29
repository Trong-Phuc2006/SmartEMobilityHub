const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomBytes } = require("node:crypto");
const Database = require("better-sqlite3");
const dotenv = require("dotenv");
const { BACKEND_ROOT, SCHEMA_PATH, parseConfig, samePath } = require("./env");
const { startServer } = require("../server");
const { normalizeEmail } = require("../services/auth.service");
const { hashPassword } = require("../services/password.service");

// Node's test runner owns a separate temporary namespace. Production CLI cannot
// select an arbitrary database path; its stable P7 location remains unchanged.
const TEST_DEMOS = Boolean(process.env.NODE_TEST_CONTEXT);
const LOCAL_DEMO_ROOT = TEST_DEMOS ? path.join(fs.realpathSync(os.tmpdir()), "smartemobilityhub-test-demos")
  : path.join(BACKEND_ROOT, ".tmp/local-demos");
const KIND = "SmartEMobilityHub isolated local demo v1";

class LocalDemoError extends Error {}
function refuse(message) { throw new LocalDemoError(message); }

function demoPaths(name) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(name)) refuse("Demo name must be a safe lowercase slug (1..32 characters).");
  const directory = path.join(LOCAL_DEMO_ROOT, name);
  return Object.freeze({ name, directory, database: path.join(directory, "smart_mobility.demo.db"),
    marker: path.join(directory, "owner.json"), env: path.join(directory, ".env") });
}

function directoryCheck(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(directory), directory)) {
    refuse("Refusing a redirected local-demo directory.");
  }
}

function rootCheck(create = false) {
  directoryCheck(BACKEND_ROOT);
  for (const directory of [TEST_DEMOS ? fs.realpathSync(os.tmpdir()) : path.join(BACKEND_ROOT, ".tmp"), LOCAL_DEMO_ROOT]) {
    if (create && !fs.existsSync(directory)) {
      try { fs.mkdirSync(directory); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    directoryCheck(directory);
  }
}

function fileCheck(filename, optional = false) {
  let stat;
  try { stat = fs.lstatSync(filename); }
  catch (error) { if (optional && error.code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !samePath(fs.realpathSync(filename), filename)) {
    refuse("Refusing a linked or non-file local-demo resource.");
  }
}

function inspectPaths(name) {
  const paths = demoPaths(name);
  rootCheck(); directoryCheck(paths.directory);
  fileCheck(paths.marker);
  let marker;
  try { marker = JSON.parse(fs.readFileSync(paths.marker, "utf8")); }
  catch { refuse("Local-demo ownership marker is invalid."); }
  if (marker.kind !== KIND || marker.name !== name || marker.database !== "smart_mobility.demo.db") {
    refuse("Local-demo ownership marker does not match the selected instance.");
  }
  if (marker.ready === false) refuse("Local-demo initialization is incomplete. Existing files were preserved; select a fresh instance name.");
  fileCheck(paths.env); fileCheck(paths.database);
  for (const suffix of ["-journal", "-wal", "-shm"]) fileCheck(paths.database + suffix, true);
  return paths;
}

function openLocalDemo(name, { readonly = false } = {}) {
  const paths = inspectPaths(name);
  const db = new Database(paths.database, { readonly, fileMustExist: true });
  try { db.pragma("foreign_keys = ON"); return db; }
  catch (error) { db.close(); throw error; }
}

function initializeLocalDemo(name, { populate } = {}) {
  const paths = demoPaths(name);
  rootCheck(true);
  // Exclusive ownership; publish ready only after schema + optional fixture commit.
  fs.mkdirSync(paths.directory);
  directoryCheck(paths.directory);
  const marker = { kind: KIND, name, database: "smart_mobility.demo.db", ready: false };
  fs.writeFileSync(paths.marker, JSON.stringify(marker), { flag: "wx", mode: 0o600 });
  fs.writeFileSync(paths.env, "JWT_SECRET=" + randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
  const fd = fs.openSync(paths.database, "wx", 0o600);
  fs.closeSync(fd);
  const db = new Database(paths.database, { fileMustExist: true });
  try {
    db.pragma("foreign_keys=ON");
    db.transaction(() => {
      db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
      if (populate) populate(db);
      if (db.pragma("foreign_key_check").length) refuse("Demo fixture foreign keys are inconsistent.");
    }).immediate();
  }
  finally { db.close(); }
  const pendingMarker = path.join(paths.directory, "owner.ready.json");
  fs.writeFileSync(pendingMarker, JSON.stringify({ ...marker, ready: true }), { flag: "wx", mode: 0o600 });
  fs.renameSync(pendingMarker, paths.marker);
  return paths;
}

async function ensureLocalDemo(name) {
  const paths = demoPaths(name);
  // lstat, rather than existsSync, also catches dangling links. Never seed an
  // existing instance, even if it is empty or used an older fixture version.
  try {
    fs.lstatSync(paths.directory);
    inspectPaths(name);
    return { ...paths, initialized: false };
  } catch (error) {
    if (error.code !== "ENOENT" || fs.existsSync(paths.directory)) throw error;
  }
  const fixture = require("../../demo/demo-data.json");
  const hashes = await Promise.all(fixture.users.map(() => hashPassword(fixture.password)));
  initializeLocalDemo(name, { populate: (db) => {
    const user = db.prepare("INSERT INTO Users(user_id,email,role,status,password_hash) VALUES (?,?,'STUDENT','ACTIVE',?)");
    fixture.users.forEach((row, i) => user.run(row.user_id, row.email, hashes[i]));
    const hub = db.prepare("INSERT INTO Hubs(hub_id,name,location_type,total_parking_capacity) VALUES (?,?,?,?)");
    fixture.hubs.forEach(row => hub.run(row.hub_id, row.name, row.location_type, row.total_parking_capacity));
    const space = db.prepare("INSERT INTO ParkingSpaces(space_id,hub_id,state) VALUES (?,?,?)");
    const reservation = db.prepare("INSERT INTO Reservations(reservation_id,user_id,type,space_id,start_time,state,created_at) VALUES (?,?,'PARKING',?,?,?,?)");
    const now = new Date().toISOString();
    for (const row of fixture.spaces) {
      space.run(row.space_id, row.hub_id, row.state);
      if (row.owner) reservation.run("initial-" + row.space_id, row.owner, row.space_id, now, row.state === "RESERVED" ? "RESERVED" : "ACTIVE", now);
    }
    const vehicle = db.prepare("INSERT INTO Vehicles(vehicle_id,hub_id,type,battery_level,state) VALUES (?,?,?,?,?)");
    const rental = db.prepare(`INSERT INTO Reservations(reservation_id,user_id,type,vehicle_id,space_id,start_time,end_time,state,created_at)
      VALUES (?,?,'VEHICLE',?,NULL,?,NULL,?,?)`);
    for (const row of fixture.vehicles || []) {
      vehicle.run(row.vehicle_id, row.hub_id, row.type, row.battery_level, row.state);
      if (row.owner) rental.run("initial-" + row.vehicle_id, row.owner, row.vehicle_id, now, row.state === "RESERVED" ? "RESERVED" : "ACTIVE", now);
    }
  } });
  return { ...paths, initialized: true };
}

async function startLocalDemo(name, { env = process.env } = {}) {
  const paths = inspectPaths(name);
  // Only the new instance's ignored configuration is read. No backend/.env,
  // caller DATABASE_PATH or caller JWT_SECRET can redirect this opt-in launcher.
  const saved = dotenv.parse(fs.readFileSync(paths.env));
  if (Object.keys(saved).length !== 1 || !/^[a-f0-9]{64}$/.test(saved.JWT_SECRET || "")) {
    refuse("Local-demo signing configuration is invalid; no key fallback is used.");
  }
  const base = parseConfig({ NODE_ENV: "development", HOST: env.HOST ?? "localhost", PORT: env.PORT ?? "3000",
    FRONTEND_ORIGIN: env.FRONTEND_ORIGIN ?? "http://localhost:5173", COOKIE_SECURE: env.COOKIE_SECURE,
    JWT_SECRET: saved.JWT_SECRET });
  // The selected path was validated by inspectPaths, independently of the normal
  // environment selector. This does not widen parseConfig/openDemoDatabase.
  const config = Object.freeze({ ...base, databasePath: paths.database });
  return startServer({ config, createDatabase: () => {
    const db = openLocalDemo(name);
    return { db, cleanup: () => { if (db.open) db.close(); } };
  } });
}

function localDemoStatus(name) {
  const paths = inspectPaths(name);
  const db = openLocalDemo(name, { readonly: true });
  try {
    const count = (table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
    return { database: paths.database, foreign_keys: db.pragma("foreign_keys", { simple: true }),
      users: count("Users"), hubs: count("Hubs"), spaces: count("ParkingSpaces"), reservations: count("Reservations"), vehicles: count("Vehicles") };
  } finally { db.close(); }
}

async function seedLocalDemo(name, email) {
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.length > 254) {
    refuse("Supply the dummy student email registered through this instance's API.");
  }
  const db = openLocalDemo(name);
  try {
    const users = db.prepare("SELECT user_id,email,role,status FROM Users").all();
    const found = users.filter((u) => normalizeEmail(u.email) === normalizeEmail(email));
    if (found.length !== 1 || found[0].role !== "STUDENT" || found[0].status !== "ACTIVE") {
      refuse("Register one ACTIVE STUDENT in the selected isolated demo before seeding.");
    }
    const otherHash = await hashPassword(randomBytes(32).toString("hex"));
    const owner = found[0].user_id;
    return db.transaction(() => {
      const inserted = { Users: 0, Hubs: 0, ParkingSpaces: 0, Reservations: 0 };
      const keys = { Users: "user_id", Hubs: "hub_id", ParkingSpaces: "space_id", Reservations: "reservation_id" };
      // All table/column names are fixed seed definitions, never CLI input. A
      // collision rolls back the transaction; INSERT only, no UPDATE/REPLACE.
      function put(table, row) {
        const columns = Object.keys(row);
        const existing = db.prepare(`SELECT * FROM ${table} WHERE ${keys[table]}=?`).get(row[keys[table]]);
        if (existing) {
          if (columns.some((key) => key !== "password_hash" && existing[key] !== row[key]) ||
            (table === "Users" && !existing.password_hash.startsWith("scrypt$v1$"))) {
            refuse("Seed fixture collides with existing data; nothing was replaced.");
          }
          return;
        }
        db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
        inserted[table]++;
      }
      put("Users", { user_id: "demo-other-student", email: "synthetic-other@example.invalid", role: "STUDENT", status: "ACTIVE", password_hash: otherHash });
      for (const [hub_id, label, capacity, type] of [["demo-campus", "Demo · Campus", 4, "CAMPUS"],
        ["demo-metro", "Demo · Metro", 2, "METRO"], ["demo-empty", "Demo · Empty Hub", 0, null]]) {
        put("Hubs", { hub_id, name: label, total_parking_capacity: capacity, location_type: type });
      }
      for (const [space_id, hub_id, state] of [["DEMO-A-01", "demo-campus", "AVAILABLE"], ["DEMO-A-02", "demo-campus", "RESERVED"],
        ["DEMO-A-03", "demo-campus", "OCCUPIED"], ["DEMO-A-04", "demo-campus", "RESERVED"],
        ["DEMO-B-01", "demo-metro", "AVAILABLE"], ["DEMO-B-02", "demo-metro", "OCCUPIED"]]) {
        put("ParkingSpaces", { space_id, hub_id, state });
      }
      for (const [space_id, state, user_id] of [["DEMO-A-02", "RESERVED", owner], ["DEMO-A-03", "ACTIVE", owner],
        ["DEMO-A-04", "RESERVED", "demo-other-student"], ["DEMO-B-02", "ACTIVE", "demo-other-student"]]) {
        put("Reservations", { reservation_id: "fixture-" + space_id, user_id, type: "PARKING", vehicle_id: null,
          space_id, start_time: "2026-10-01T00:00:00Z", end_time: null, state, created_at: "2026-10-01T00:00:00Z" });
      }
      return inserted;
    }).immediate();
  } finally { db.close(); }
}

module.exports = { LocalDemoError, LOCAL_DEMO_ROOT, demoPaths, inspectPaths, initializeLocalDemo, ensureLocalDemo,
  openLocalDemo, startLocalDemo, localDemoStatus, seedLocalDemo };
