const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const Database = require("better-sqlite3");
const dotenv = require("dotenv");
const { BACKEND_ROOT, SCHEMA_PATH, parseConfig, samePath } = require("./env");
const { startServer } = require("../server");
const { normalizeEmail } = require("../services/auth.service");
const { hashPassword } = require("../services/password.service");

const LOCAL_DEMO_ROOT = path.join(BACKEND_ROOT, ".tmp/local-demos");
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
  for (const directory of [path.join(BACKEND_ROOT, ".tmp"), LOCAL_DEMO_ROOT]) {
    if (create && !fs.existsSync(directory)) fs.mkdirSync(directory);
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

function initializeLocalDemo(name) {
  const paths = demoPaths(name);
  rootCheck(true);
  // Never reuse/replace an existing directory, DB or signing key. A partial init
  // remains visible and must be inspected; there is no automatic reset/cleanup.
  fs.mkdirSync(paths.directory);
  directoryCheck(paths.directory);
  fs.writeFileSync(paths.marker, JSON.stringify({ kind: KIND, name, database: "smart_mobility.demo.db" }), { flag: "wx", mode: 0o600 });
  fs.writeFileSync(paths.env, "JWT_SECRET=" + randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
  const fd = fs.openSync(paths.database, "wx", 0o600);
  fs.closeSync(fd);
  const db = openLocalDemo(name);
  try { db.transaction(() => db.exec(fs.readFileSync(SCHEMA_PATH, "utf8")))(); }
  finally { db.close(); }
  return paths;
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
      users: count("Users"), hubs: count("Hubs"), spaces: count("ParkingSpaces"), reservations: count("Reservations") };
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

module.exports = { LocalDemoError, LOCAL_DEMO_ROOT, demoPaths, inspectPaths, initializeLocalDemo,
  openLocalDemo, startLocalDemo, localDemoStatus, seedLocalDemo };
